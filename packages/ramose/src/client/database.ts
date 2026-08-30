/**
 * One local database handle.
 *
 * Constructing it is inert. The first observed query activates it: the client
 * catalog is installed, the shared replica storage is opened, `auth()` is
 * resolved, and one {@link ReplicationSession} opens for this route. Everything
 * after that is local — the server never receives a query, and every result is
 * computed against the committed replica plus this database's ordered
 * optimistic layers.
 */

import type { AnyComposer } from "../db/Composer.ts";
import { NotOne } from "../db/Errors.ts";
import {
  lowerQueryObject,
  type AnyQueryObject,
  type LoweredKernelQuery,
  type QueryObject,
} from "../db/query/index.ts";
import type { Db } from "../internal/core/db.ts";
import { query as runQuery } from "../internal/core/query/engine.ts";
import { emptyOverlayLayers } from "../internal/replication/overlay-layers.ts";
import type { ReplicationIdentity } from "../internal/replication/protocol.ts";
import {
  OptimisticReconciler,
  type OptimisticOverlayState,
  type ReconciliationOptions,
} from "../internal/replication/reconciliation.ts";
import {
  replicaDatabaseKey,
  replicaDatabaseScopeOf,
  type ReplicaDatabaseScope,
} from "../internal/replication/replica-lifecycle.ts";
import {
  ReplicationSession,
  type ReplicationSessionSnapshot,
} from "../internal/replication/session.ts";
import { sameReplicationIdentity } from "../internal/replication/state.ts";
import type { IndexedDbReplicaStorage } from "../internal/replication/indexeddb.ts";
import type { ClientCatalog } from "./catalog.ts";
import {
  clientQueryFrom,
  GraphDatabaseHandle,
  type ClientQuery,
  type GraphAncestor,
  type GraphRegistry,
} from "./graph.ts";
import { Store, sameResult, type Subscription } from "./subscription.ts";
import { syncState, type SyncState, type SyncStatus } from "./sync.ts";

/**
 * One query's current answer.
 *
 * `getSnapshot()` returns the same object until this value actually changes:
 * a rerun that found the same rows republishes nothing, and one that found new
 * rows publishes a new snapshot whose `data` is a new value too. A rerun that
 * changed only `stale` keeps the previous `data` identity.
 */
export type QuerySnapshot<Out> = {
  /**
   * - `pending` — this database has no local value yet.
   * - `ready` — `data` is the answer over the current local view.
   * - `error` — the query could not run against the current local value.
   */
  readonly status: "pending" | "ready" | "error";
  /** The rows, present exactly when `status` is `ready`. */
  readonly data: Out | undefined;
  /**
   * The local value this answer came from has not been confirmed by the current
   * session: a restored offline replica, or a reconnect in progress. Always
   * `true` while `status` is `pending`.
   */
  readonly stale: boolean;
  /** Present exactly when `status` is `error`. */
  readonly error: Error | undefined;
};

export type QuerySubscription<Out> = Subscription<QuerySnapshot<Out>>;

/**
 * The identity two observations of the same question share.
 *
 * The lowered wire query carries the whole of *what* is asked — the lowering
 * resets its variable counter, so two independently built equal queries produce
 * identical text, which is what lets them share one execution.
 *
 * It carries none of *how the answer is shaped*. `.one()` sends the same
 * `limit: 1` as `.limit(1)` and returns a row instead of an array; a first page
 * sends no cursor and returns `{ rows, cursor }`; two selects that differ only
 * in their output key names send the same `:find`. Sharing one execution across
 * any of those pairs would hand one caller the other's runtime shape, so the
 * lowering's own canonical description of its finalization plan is half of the
 * identity.
 */
export const queryObservationKey = (query: AnyQueryObject): string => {
  const lowered = lowerQueryObject(query);
  return JSON.stringify([lowered.query, lowered.shape]);
};

const PENDING: QuerySnapshot<never> = Object.freeze({
  status: "pending" as const,
  data: undefined,
  stale: true,
  error: undefined,
});

/** How a client reads one replication session snapshot. */
export type SessionDisposition = {
  readonly status: SyncStatus;
  /**
   * Whether the value the snapshot still carries may be published.
   *
   * A session keeps its last value across a terminal or a failure, which is
   * right for an unreachable server and wrong for the server's own answer. A
   * refused credential and a rotated authorized view are both answers: the
   * credential no longer opens this partition, or this build can no longer read
   * it. Neither may keep publishing what the session opened with.
   */
  readonly publishes: boolean;
};

/**
 * The whole mapping from replication to public synchronization state.
 *
 * Pure, and exported for that reason: every branch is a decision about what an
 * application is allowed to read, so each one is worth stating over ordinary
 * input values rather than only where a network can be persuaded to produce it.
 */
export const readSessionSnapshot = (
  snapshot: ReplicationSessionSnapshot,
): SessionDisposition => {
  switch (snapshot.status) {
    case "open":
      return {
        status: snapshot.value?.stale === true ? "stale" : "live",
        publishes: true,
      };
    case "connecting":
      return {
        status: snapshot.value === undefined ? "connecting" : "stale",
        publishes: true,
      };
    case "terminal":
      // `incompatible-version` and `update-required` both say this build cannot
      // read what the server serves, so its value goes with the status. A
      // stream that merely ended says nothing about authorization, so it reads
      // as unreachable and its last confirmed value stays readable.
      return snapshot.terminalCode === "update-required" ||
          snapshot.terminalCode === "incompatible-version"
        ? { status: "update-required", publishes: false }
        : { status: "offline", publishes: true };
    case "failed":
      return snapshot.failure === "unauthorized"
        ? { status: "authentication-required", publishes: false }
        : { status: "offline", publishes: true };
    case "closed":
      return { status: "closed", publishes: false };
  }
};

/** Everything a database handle needs from the client that owns it. */
export type DatabaseContext = {
  readonly server: string;
  readonly root: string;
  /**
   * The current mutable path names this activation sends, one per authorized
   * segment. The server authorizes every one of them: the local route slot the
   * lineage below selects is cache selection, never authority.
   */
  readonly graphPath: readonly string[];
  /**
   * The stable Graph lineage a previous activation of this same graph identity
   * confirmed, if this client has one.
   *
   * Resolved at activation rather than captured, so a lineage confirmed while
   * this handle was being constructed still selects the durable replica it
   * names. Absent for the root, and absent until something has confirmed it —
   * the session then falls back on the durable observation table and finally on
   * a provisional path slot, exactly as it does with no client at all.
   */
  readonly graphLineage?: (() => readonly string[] | undefined) | undefined;
  /** Every resolved child database this client has, interned by graph identity. */
  readonly graph: () => GraphRegistry;
  readonly catalog: () => Promise<ClientCatalog>;
  readonly storage: () => Promise<IndexedDbReplicaStorage>;
  readonly credential: () => Promise<{
    readonly token: string;
    readonly cacheKey: string;
  }>;
  /** Throws when the client is terminal. */
  readonly assertLive: (operation: string) => void;
  /** Whether the client is still live, for asynchronous continuations. */
  readonly live: () => boolean;
  /** One database's status changed; the client recomputes its aggregate. */
  readonly onSyncChange: () => void;
  /** An authenticated response confirmed this identity. */
  readonly onConfirmed: (identity: ReplicationIdentity) => void;
  /**
   * Destructive local maintenance closed this database's session. The client is
   * terminal: nothing reactivates it, and the application constructs a new one.
   */
  readonly onFenced: () => void;
};

/**
 * One interned query and its listeners.
 *
 * Shared by every handle `observe()` hands out for the same canonical query, so
 * two components asking the same question run it once. Refcounted by
 * `subscribe`: the last unsubscribe drops it from the database's intern map, so
 * a query nobody watches stops costing anything.
 */
/**
 * What a released observation was last showing.
 *
 * Kept so a remount resumes from it instead of flashing back through
 * `pending`: a released observation is not a *changed* one, and the snapshot
 * contract says identity changes only when the value does. It comes back
 * marked stale, because nothing has re-derived it against the current view
 * yet — which is the honest reading, and is free when it was already stale.
 */
const resumed = (
  prior: QuerySnapshot<unknown> | undefined,
): QuerySnapshot<unknown> => {
  if (prior === undefined || prior.status === "pending") return PENDING;
  // Already stale means already resumable: returning it unchanged is what
  // makes a remount cost no re-render at all.
  return prior.stale ? prior : Object.freeze({ ...prior, stale: true });
};

class QueryObserver {
  readonly store: Store<QuerySnapshot<unknown>>;
  /**
   * The newest generation this observer has been asked to answer for.
   *
   * Claimed when a run *starts*, not when one publishes: a query is async, so
   * an older run can finish after a newer one has already been scheduled, and
   * comparing against the last published generation would let it publish rows
   * from a view that has since been superseded.
   */
  private scheduled = -1;

  constructor(
    private readonly lowered: LoweredKernelQuery,
    private readonly release: (self: QueryObserver) => void,
    prior?: QuerySnapshot<unknown> | undefined,
  ) {
    this.store = new Store<QuerySnapshot<unknown>>(resumed(prior));
  }

  subscribe(onChange: () => void): () => void {
    const stop = this.store.subscribe(onChange);
    // Idempotent, as the public subscription contract promises. A second call
    // must not release again: the query may have been reacquired in between,
    // and releasing then would detach the replacement's live listeners.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      stop();
      if (this.store.size === 0) this.release(this);
    };
  }

  async run(generation: number, view: Db | undefined, stale: boolean): Promise<void> {
    if (generation < this.scheduled) return;
    this.scheduled = generation;
    if (view === undefined) {
      this.publish(generation, "pending", undefined, true, undefined);
      return;
    }
    try {
      const rows = this.lowered.finalize(await runQuery(view, this.lowered.query));
      // `oneOrFail()` reports a miss by *returning* its error rather than
      // throwing, so a snapshot that took it for data would hand an application
      // an error object where its rows belong.
      if (rows instanceof NotOne) {
        this.publish(generation, "error", undefined, stale, rows);
        return;
      }
      this.publish(generation, "ready", rows, stale, undefined);
    } catch (cause) {
      this.publish(
        generation,
        "error",
        undefined,
        stale,
        cause instanceof Error ? cause : new Error(String(cause)),
      );
    }
  }

  /**
   * Publish, preserving identity when nothing changed.
   *
   * Both halves matter: an unchanged answer republishes nothing at all, and an
   * answer that changed only in `stale` keeps the previous `data` identity, so
   * a consumer memoizing on `snapshot.data` is not invalidated by a reconnect.
   */
  private publish(
    generation: number,
    status: QuerySnapshot<unknown>["status"],
    data: unknown,
    stale: boolean,
    error: Error | undefined,
  ): void {
    if (generation < this.scheduled) return;
    const prior = this.store.getSnapshot();
    const unchangedData = sameResult(prior.data, data);
    if (
      prior.status === status && prior.stale === stale &&
      prior.error === error && unchangedData
    ) return;
    this.store.publish(Object.freeze({
      status,
      data: unchangedData ? prior.data : data,
      stale,
      error,
    }));
  }
}

/**
 * The public database handle.
 *
 * `query.from` is the portable query language, unchanged: there is no client
 * query DSL, and a query value built here is the same inert value the deployed
 * code builds.
 */
export interface ClientDatabase {
  readonly query: {
    readonly from: <N extends AnyComposer>(entity: N) => ClientQuery<N>;
  };
  /**
   * Observe one query. Observing activates this database; constructing the
   * query value, and this handle, does not.
   *
   * Safe to call during rendering: it performs no query, storage, or network
   * work synchronously, retains nothing until something subscribes, and shares
   * one interned observation across equal queries.
   */
  readonly observe: <Row, Out>(
    query: QueryObject<Row, Out>,
  ) => QuerySubscription<Out>;
  /** This database's synchronization state. */
  readonly sync: Subscription<SyncState>;
}

export class ClientDatabaseHandle implements ClientDatabase, GraphAncestor {
  readonly query = { from: clientQueryFrom(this) };
  private readonly syncStore = new Store<SyncState>(syncState("idle"));
  readonly sync = this.syncStore.subscription;
  /**
   * A resolved database *is* its own binding, and never rebinds: it is what
   * every path hanging off it resolves against. The subscription exists so a
   * descendant does not have to care whether its parent is one of these or an
   * unresolved graph handle.
   */
  readonly binding: Subscription<unknown> = Object.freeze({
    subscribe: () => () => undefined,
    getSnapshot: () => this,
  });
  private readonly graphChildren = new Map<string, GraphDatabaseHandle>();

  private readonly observers = new Map<string, QueryObserver>();
  /**
   * The last snapshot of each released observation, so a resubscribe resumes
   * from it. Emptied whenever the value behind it stops being this database's:
   * a partition transition, a fence, or a close.
   */
  private readonly retired = new Map<string, QuerySnapshot<unknown>>();
  private activation: Promise<void> | undefined;
  private catalog: ClientCatalog | undefined;
  private session: ReplicationSession | undefined;
  private releaseSession: (() => void) | undefined;
  private reconciler: OptimisticReconciler | undefined;
  private reconcilerKey: string | undefined;
  private reconcilerPending: Promise<OptimisticReconciler> | undefined;
  private releaseOverlay: (() => void) | undefined;
  private identity: ReplicationIdentity | undefined;
  private committed: Db | undefined;
  /**
   * The sealed-handle binding of the committed value currently published, and
   * its inverse, recomputed together whenever that value is replaced.
   *
   * Empty whenever there is no publishable value — a fenced, transitioned, or
   * closed database holds no handles, so nothing can address a mutation at a
   * row it is no longer allowed to read.
   */
  private handles: ReadonlyMap<string, number> = new Map();
  private reverse: Map<number, string> | undefined;
  private viewValue: Db | undefined;
  /** The generation {@link viewValue} was computed under. */
  private viewGeneration = 0;
  private lastSession: ReplicationSessionSnapshot | undefined;
  private stale = true;
  private updateRequired = false;
  private closed = false;
  /**
   * Monotonic observation generation. Every published view, and every partition
   * transition, claims a new one; a query result computed under an older
   * generation is dropped rather than published, so a value from a replaced
   * principal or read view cannot reach an application even transiently.
   */
  private generation = 0;

  constructor(private readonly context: DatabaseContext) {}

  observe<Row, Out>(query: QueryObject<Row, Out>): QuerySubscription<Out> {
    this.context.assertLive("observe");
    const value = query as AnyQueryObject;
    const lowered = lowerQueryObject(value);
    const key = queryObservationKey(value);
    void this.activate();
    // Resolved on every use, never captured. A subscription value outlives the
    // observation it names — a framework unmounts, the last listener goes, the
    // observation is released, and the *same* value is subscribed again on
    // remount. Holding the released observer there would hand that remount a
    // frozen snapshot that no replica or overlay change ever updates again.
    //
    // And nothing is interned until something subscribes: an observation is
    // released only through an unsubscribe, so one installed by a render that
    // is then abandoned would never be released, and every later replica or
    // overlay change would rerun it forever.
    let last: QueryObserver | undefined = this.observers.get(key);
    return Object.freeze({
      subscribe: (onChange: () => void) => {
        const observer = this.acquire(key, lowered);
        last = observer;
        return observer.subscribe(onChange);
      },
      getSnapshot: (): QuerySnapshot<Out> => {
        // A closed database maintains nothing, so nothing it once published is
        // still an answer — including through a subscription value an
        // application is still holding.
        if (this.closed) return PENDING as QuerySnapshot<Out>;
        const observer = this.observers.get(key);
        if (observer !== undefined) last = observer;
        // A released observation is not a changed one: a value built for this
        // query after the release still answers with what it was showing,
        // exactly as a resubscribe does.
        return (last?.store.getSnapshot() ?? this.retired.get(key) ??
          PENDING) as QuerySnapshot<Out>;
      },
    });
  }

  /**
   * The interned observation for one canonical query, installing it if this is
   * the first (or the next) handle to ask for it.
   *
   * A newly installed observation is seeded against the view already computed
   * rather than by recomputing the whole database: a render that observes fifty
   * queries must cost one run each, not fifty runs each.
   */
  private acquire(key: string, lowered: LoweredKernelQuery): QueryObserver {
    const existing = this.observers.get(key);
    if (existing !== undefined) return existing;
    const prior = this.retired.get(key);
    this.retired.delete(key);
    const observer = new QueryObserver(lowered, (self) => {
      // Only if it is still the installed one: a release that raced a
      // reacquisition must not evict the replacement.
      if (this.observers.get(key) !== self) return;
      this.observers.delete(key);
      // Normalized here rather than at each read, so every reader of a retired
      // snapshot gets one stable identity for it.
      this.retired.set(key, resumed(self.store.getSnapshot()));
    }, prior);
    // A closed database installs nothing: its observers were released and
    // nothing will ever run again, so the fresh one is handed back detached
    // with its `pending` snapshot rather than added to a map close() emptied.
    if (this.closed) return observer;
    this.observers.set(key, observer);
    void observer.run(this.viewGeneration, this.viewValue, this.stale);
    return observer;
  }

  // ── graph ancestry ───────────────────────────────────────────────────────

  /** The current authorized path names this database activates with. */
  graphPath(): readonly string[] {
    return this.context.graphPath;
  }

  activateGraph(): void {
    void this.activate();
  }

  boundDatabase(): ClientDatabaseHandle | undefined {
    return this.closed ? undefined : this;
  }

  bindingFailure(): Error | undefined {
    return undefined;
  }

  /**
   * The interned unresolved path for one canonical resolution query.
   *
   * Interned by parent plus canonical query identity, so two equivalent paths
   * built independently — during a render, in two components — are one handle,
   * and constructing them costs nothing.
   */
  graphChild(key: string, canonical: AnyQueryObject): GraphDatabaseHandle {
    const existing = this.graphChildren.get(key);
    if (existing !== undefined) return existing;
    const child = new GraphDatabaseHandle(
      this,
      canonical,
      this.context.graph(),
      (operation) => this.context.assertLive(operation),
    );
    this.graphChildren.set(key, child);
    return child;
  }

  /**
   * Open this database's replication, once.
   *
   * Idempotent and fire-and-forget: an activation that cannot reach the server
   * leaves whatever local value was already confirmed readable and reports
   * `offline`, because an unreachable server is not an authorization answer.
   */
  activate(): Promise<void> {
    if (this.activation !== undefined) return this.activation;
    this.activation = this.open().catch(() => {
      this.publishStatus("offline");
    });
    return this.activation;
  }

  private async open(): Promise<void> {
    this.publishStatus("connecting");
    const [catalog, storage] = await Promise.all([
      this.context.catalog(),
      this.context.storage(),
    ]);
    if (!this.live()) return;
    this.catalog = catalog;
    const credential = await this.context.credential();
    if (!this.live()) return;
    // The lineage a previous activation of this same stable graph identity
    // confirmed. It selects the durable replica this path already has — which
    // is what lets a renamed path resume instead of taking a fresh snapshot —
    // and it decides nothing about authorization: the path names below are
    // still what the server authorizes, segment by segment.
    const lineage = this.context.graphLineage?.();
    const session = await ReplicationSession.open({
      activation: {
        server: this.context.server,
        root: this.context.root,
        graphPath: this.context.graphPath,
      },
      credential: credential.token,
      cacheKey: credential.cacheKey,
      ...(lineage === undefined ? {} : { graphLineage: lineage }),
      attributes: catalog.attributes,
      readCompatibilityHash: catalog.readCompatibilityHash,
      storage,
      onActivationOutcome: () => this.settleActivation(),
    });
    if (!this.live()) {
      await session.close();
      return;
    }
    this.session = session;
    this.releaseSession = session.observe((snapshot) => this.accept(snapshot));
  }

  private live(): boolean {
    return !this.closed && this.context.live();
  }

  /** Adopt one session snapshot: identity first, then value, then status. */
  private accept(snapshot: ReplicationSessionSnapshot): void {
    if (this.closed) return;
    if (snapshot.status === "closed") {
      // Not this handle's own close — that path sets `closed` first, and the
      // guard above returns. Destructive local maintenance closed this session
      // out from under the client, so the client is done: nothing reactivates
      // it, and it must say so rather than sit at a status that reads healthy.
      this.fence();
      this.context.onFenced();
      return;
    }
    const value = snapshot.value;
    const identity = value?.identity;
    if (identity !== undefined) {
      if (
        this.identity !== undefined &&
        !sameReplicationIdentity(this.identity, identity)
      ) {
        this.transition();
      }
      this.identity = identity;
      this.context.onConfirmed(identity);
      // Fire and forget, and *observed*: binding is best-effort here — the
      // committed replica publishes with or without its layers — but an
      // unobserved rejection is an unhandled rejection in the page, which a
      // close that raced this bind produces routinely.
      void this.bindReconciler(identity).catch(() => undefined);
    }
    this.lastSession = snapshot;
    const disposition = readSessionSnapshot(snapshot);
    this.stale = value === undefined ? true : value.stale;
    const catalog = this.catalog;
    if (!disposition.publishes || value === undefined || catalog === undefined) {
      this.committed = undefined;
      this.forgetHandles();
    } else {
      this.committed = value.db.withComposition(catalog.composition);
      // The binding travels with the value it describes, and goes when it goes.
      this.handles = value.handles;
      this.reverse = undefined;
    }
    this.publishStatus(this.statusOf(snapshot));
    void this.recompute();
  }

  /**
   * Stop for good without going through `close()`.
   *
   * For when something outside this client ended its session: the durable scope
   * it was reading was cleared or evicted. Every observation resets to pending
   * and the status becomes terminal.
   */
  private fence(): void {
    this.closed = true;
    this.generation++;
    this.committed = undefined;
    this.forgetHandles();
    this.viewValue = undefined;
    this.viewGeneration = this.generation;
    this.releaseOverlay?.();
    this.releaseOverlay = undefined;
    this.reconciler = undefined;
    this.reconcilerPending = undefined;
    this.reconcilerKey = undefined;
    for (const observer of this.observers.values()) {
      void observer.run(this.generation, undefined, true);
    }
    this.observers.clear();
    this.retired.clear();
    this.closeGraphChildren();
    this.syncStore.publish(syncState("closed"));
  }

  /**
   * Release every path hanging off this database.
   *
   * The paths themselves, not the databases they resolved to: those belong to
   * the client's registry, which releases them on its own terms.
   */
  private closeGraphChildren(): void {
    for (const child of this.graphChildren.values()) child.close();
    this.graphChildren.clear();
  }

  /**
   * The prior partition is gone: a replaced principal, read view, schema, or
   * database identity. Drop everything derived from it *before* the replacement
   * is installed, and claim a fresh generation so an in-flight query result
   * computed against it can never be published.
   */
  private transition(): void {
    this.generation++;
    this.committed = undefined;
    this.forgetHandles();
    this.viewValue = undefined;
    this.viewGeneration = this.generation;
    this.reconciler = undefined;
    this.reconcilerKey = undefined;
    this.reconcilerPending = undefined;
    this.releaseOverlay?.();
    this.releaseOverlay = undefined;
    this.updateRequired = false;
    this.retired.clear();
    this.publishStatus("authentication-required");
    for (const observer of this.observers.values()) {
      void observer.run(this.generation, undefined, true);
    }
  }

  /**
   * The replication status, plus this database's own scope-wide layer
   * quarantine — which the session knows nothing about.
   *
   * The quarantine loses to the server's own answers. Both fence the data, but
   * they ask for different things: a refused credential is recovered by signing
   * in again, and telling that application to ship a new build instead would
   * leave it with no way back.
   */
  private statusOf(snapshot: ReplicationSessionSnapshot): SyncStatus {
    const status = readSessionSnapshot(snapshot).status;
    if (status === "authentication-required" || status === "closed") return status;
    return this.updateRequired ? "update-required" : status;
  }

  private publishStatus(status: SyncStatus): void {
    if (this.closed && status !== "closed") return;
    if (this.syncStore.publish(syncState(status))) this.context.onSyncChange();
  }

  syncStatus(): SyncStatus {
    return this.syncStore.getSnapshot().status;
  }

  /** Whether this database has ever been activated in this client session. */
  activated(): boolean {
    return this.activation !== undefined;
  }

  confirmedIdentity(): ReplicationIdentity | undefined {
    return this.identity;
  }

  /**
   * Whether the current session has withdrawn this database's readable value.
   *
   * True exactly when the server's own answer says this credential or this
   * build can no longer read the partition it opened — never for an unreachable
   * server, whose last confirmed value stays readable, and never for this
   * database's own layer quarantine, which withholds layers while the committed
   * replica goes on answering.
   *
   * Descendant paths need that distinction: `update-required` names both, and
   * only one of them invalidates the authority a child path resolved under.
   */
  viewWithdrawn(): boolean {
    if (this.closed) return true;
    return this.lastSession !== undefined &&
      !readSessionSnapshot(this.lastSession).publishes;
  }

  /**
   * The local view currently published: the committed replica plus this
   * database's ordered layers. With no layers the committed value *is* the
   * view, so the ordinary read path costs nothing extra.
   */
  private async recompute(): Promise<void> {
    const generation = ++this.generation;
    const committed = this.committed;
    const reconciler = this.reconciler;
    const layers = reconciler?.snapshot().layers ?? emptyOverlayLayers;
    let view = committed;
    if (committed !== undefined && reconciler !== undefined && layers.length > 0) {
      try {
        view = (await reconciler.view(committed)).db;
      } catch {
        // A projection that cannot be applied contributes no layer rather than
        // a partial one; the committed value remains the honest local answer.
        view = committed;
      }
    }
    if (generation !== this.generation || this.closed) return;
    this.viewValue = view;
    this.viewGeneration = generation;
    const stale = this.stale;
    for (const observer of this.observers.values()) {
      void observer.run(generation, view, stale);
    }
  }

  /**
   * The reconciler for the database this response confirmed.
   *
   * Built lazily because its receiver scope only exists once the server has
   * confirmed an identity — before that there is no database to own layers for.
   */
  private bindReconciler(
    identity: ReplicationIdentity,
  ): Promise<OptimisticReconciler> {
    const receiver = replicaDatabaseScopeOf(identity);
    const key = replicaDatabaseKey(receiver);
    if (this.reconcilerKey === key && this.reconcilerPending !== undefined) {
      return this.reconcilerPending;
    }
    this.reconcilerKey = key;
    const pending = (async () => {
      const storage = await this.context.storage();
      const catalog = await this.context.catalog();
      const reconciler = new OptimisticReconciler(
        storage.outbox(),
        receiver,
        catalog.projections,
        this.reconciliationOptions(),
      );
      await reconciler.refresh();
      if (this.reconcilerKey !== key || this.closed) return reconciler;
      this.releaseOverlay?.();
      this.reconciler = reconciler;
      this.releaseOverlay = reconciler.observe((state) => this.overlay(state));
      return reconciler;
    })().catch((cause: unknown): never => {
      // A memo of a failure is worse than no memo: every later activation of
      // this same database would be handed the rejection instead of trying
      // again. The commonest cause is entirely ordinary — the storage handle
      // closed while this bind was in flight — and the next activation opens
      // its own.
      if (this.reconcilerKey === key) {
        this.reconcilerKey = undefined;
        this.reconcilerPending = undefined;
      }
      throw cause;
    });
    this.reconcilerPending = pending;
    return pending;
  }

  /**
   * The lookups the overlay cannot perform itself.
   *
   * `entity` is the committed replica's sealed-handle → local-id binding, read
   * on every call rather than captured: the reconciler outlives any one
   * committed value, and a layer must resolve a handle against the value it is
   * being projected onto. A handle this replica does not hold still resolves to
   * `undefined`, which the overlay refuses rather than inventing a row for.
   */
  private reconciliationOptions(): ReconciliationOptions {
    return { entity: (id) => this.handles.get(id) };
  }

  /** Drop the binding along with the value it describes. */
  private forgetHandles(): void {
    this.handles = new Map();
    this.reverse = undefined;
  }

  /**
   * The sealed handle for one local id in the currently published value.
   *
   * The inverse of the binding above, and built lazily because most databases
   * never need it: only a graph resolution and the entity surface ask "what is
   * this row's opaque identity?", and both ask about a handful of rows.
   */
  sealedHandleOf(eid: number): string | undefined {
    if (this.reverse === undefined) {
      const reverse = new Map<number, string>();
      for (const [handle, local] of this.handles) reverse.set(local, handle);
      this.reverse = reverse;
    }
    return this.reverse.get(eid);
  }

  /** The stable `{ server, principal, database }` scope this database confirmed. */
  confirmedScope(): ReplicaDatabaseScope | undefined {
    return this.identity === undefined
      ? undefined
      : replicaDatabaseScopeOf(this.identity);
  }

  private overlay(state: OptimisticOverlayState): void {
    if (this.closed) return;
    const required = state.updateRequired.length > 0;
    if (required !== this.updateRequired) {
      this.updateRequired = required;
      // Both directions: a build that *can* replay its layers again must stop
      // reporting a state it is no longer in.
      this.publishStatus(
        required
          ? "update-required"
          : this.statusOf(this.lastSession ?? { status: "connecting" }),
      );
    }
    void this.recompute();
  }

  /**
   * The session's own post-commit fence hook.
   *
   * Forwards to whichever reconciler owns the database this activation
   * confirmed. A hook that throws leaves the activation unfenced and the next
   * settled frame tries again, which is exactly the session's contract.
   */
  private async settleActivation(): Promise<void> {
    const identity = this.session?.snapshot().value?.identity ?? this.identity;
    if (identity === undefined || this.closed) return;
    const reconciler = await this.bindReconciler(identity);
    await reconciler.outcome(reconciler.activation())();
  }

  /**
   * Release the network scope and every in-process observer.
   *
   * Durable state is untouched: the replica, the outbox, receipts, client refs,
   * and the optimistic layers are all exactly as they were.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.releaseOverlay?.();
    this.releaseOverlay = undefined;
    this.releaseSession?.();
    this.releaseSession = undefined;
    this.reconciler = undefined;
    this.reconcilerPending = undefined;
    this.committed = undefined;
    this.forgetHandles();
    this.viewValue = undefined;
    // Reset, then drop — the same order `fence` takes. A held subscription
    // must not keep answering with the value a closed client is no longer
    // maintaining.
    for (const observer of this.observers.values()) {
      void observer.run(this.generation, undefined, true);
    }
    this.observers.clear();
    this.retired.clear();
    this.closeGraphChildren();
    this.syncStore.publish(syncState("closed"));
    const session = this.session;
    this.session = undefined;
    // Awaited, not fired: `close()` is deterministic, so the retentions this
    // session holds are released before it resolves.
    if (session !== undefined) await session.close();
    await this.activation?.catch(() => undefined);
  }
}
