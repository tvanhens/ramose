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
import type { EntityRow, FluentQuery } from "../db/query/fluent.ts";
import {
  from as queryFrom,
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
} from "../internal/replication/replica-lifecycle.ts";
import {
  ReplicationSession,
  type ReplicationSessionSnapshot,
} from "../internal/replication/session.ts";
import { sameReplicationIdentity } from "../internal/replication/state.ts";
import type { IndexedDbReplicaStorage } from "../internal/replication/indexeddb.ts";
import type { ClientCatalog } from "./catalog.ts";
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
  readonly graphPath: readonly string[];
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
class QueryObserver {
  readonly store = new Store<QuerySnapshot<unknown>>(PENDING);
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
  ) {}

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
    readonly from: <N extends AnyComposer>(
      entity: N,
    ) => FluentQuery<N, EntityRow<N>>;
  };
  /**
   * Observe one query. Observing activates this database; constructing the
   * query value, and this handle, does not.
   *
   * Safe to call during rendering: it performs no query, storage, or network
   * work synchronously, and equal queries share one interned observation.
   */
  readonly observe: <Row, Out>(
    query: QueryObject<Row, Out>,
  ) => QuerySubscription<Out>;
  /** This database's synchronization state. */
  readonly sync: Subscription<SyncState>;
}

export class ClientDatabaseHandle implements ClientDatabase {
  readonly query = { from: queryFrom };
  private readonly syncStore = new Store<SyncState>(syncState("idle"));
  readonly sync = this.syncStore.subscription;

  private readonly observers = new Map<string, QueryObserver>();
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
    // Resolved on every use, never captured. A subscription value outlives the
    // observation it names — a framework unmounts, the last listener goes, the
    // observation is released, and the *same* value is subscribed again on
    // remount. Holding the released observer there would hand that remount a
    // frozen snapshot that no replica or overlay change ever updates again.
    const acquire = (): QueryObserver => this.acquire(key, lowered);
    let last = acquire();
    void this.activate();
    return Object.freeze({
      subscribe: (onChange: () => void) => {
        last = acquire();
        return last.subscribe(onChange);
      },
      getSnapshot: (): QuerySnapshot<Out> => {
        const observer = this.observers.get(key);
        if (observer !== undefined) last = observer;
        return last.store.getSnapshot() as QuerySnapshot<Out>;
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
    const observer = new QueryObserver(lowered, (self) => {
      // Only if it is still the installed one: a release that raced a
      // reacquisition must not evict the replacement.
      if (this.observers.get(key) === self) this.observers.delete(key);
    });
    // A closed database installs nothing: its observers were released and
    // nothing will ever run again, so the fresh one is handed back detached
    // with its `pending` snapshot rather than added to a map close() emptied.
    if (this.closed) return observer;
    this.observers.set(key, observer);
    void observer.run(this.viewGeneration, this.viewValue, this.stale);
    return observer;
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
    const session = await ReplicationSession.open({
      activation: {
        server: this.context.server,
        root: this.context.root,
        graphPath: this.context.graphPath,
      },
      credential: credential.token,
      cacheKey: credential.cacheKey,
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
      void this.bindReconciler(identity);
    }
    this.lastSession = snapshot;
    const disposition = readSessionSnapshot(snapshot);
    this.stale = value === undefined ? true : value.stale;
    this.committed =
      !disposition.publishes || value === undefined || this.catalog === undefined
        ? undefined
        : value.db.withComposition(this.catalog.composition);
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
    this.syncStore.publish(syncState("closed"));
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
    this.viewValue = undefined;
    this.viewGeneration = this.generation;
    this.reconciler = undefined;
    this.reconcilerKey = undefined;
    this.reconcilerPending = undefined;
    this.releaseOverlay?.();
    this.releaseOverlay = undefined;
    this.updateRequired = false;
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
    this.reconcilerPending = (async () => {
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
    })();
    return this.reconcilerPending;
  }

  /**
   * The lookups the overlay cannot perform itself.
   *
   * `entity` — the committed replica's sealed-handle to local-id binding — is
   * deliberately absent: logical replication does not yet carry the sealed
   * `EntityId` for a replicated row, so a layer addressed by a handle this
   * replica holds is refused rather than invented. This is the one seam the
   * opaque entity surface fills; nothing here decides what it will contain.
   */
  private reconciliationOptions(): ReconciliationOptions {
    return {};
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
    this.viewValue = undefined;
    this.observers.clear();
    this.syncStore.publish(syncState("closed"));
    const session = this.session;
    this.session = undefined;
    // Awaited, not fired: `close()` is deterministic, so the retentions this
    // session holds are released before it resolves.
    if (session !== undefined) await session.close();
    await this.activation?.catch(() => undefined);
  }
}
