import type { AnyComposer } from "../db/Composer.ts";
import { NotOne } from "../db/Errors.ts";
import {
  lowerQueryObject,
  symbolicIdentityLowering,
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
  isReplicaFenceError,
  replicaDatabaseKey,
  replicaDatabaseScopeOf,
  type ReplicaDatabaseScope,
} from "../internal/replication/replica-lifecycle.ts";
import {
  ReplicationSession,
  type ReplicationSessionSnapshot,
} from "../internal/replication/session.ts";
import { sameReplicationIdentity } from "../internal/replication/state.ts";
import type { QueueProgress } from "../internal/replication/submission.ts";
import type { IndexedDbReplicaStorage } from "../internal/replication/indexeddb.ts";
import type { ClientCatalog } from "./catalog.ts";
import {
  clientQueryFrom,
  entityFocusOf,
  GraphDatabaseHandle,
  type ClientQuery,
  type ClientValue,
  type EntityFocused,
  type EntityResult,
  type GraphAncestor,
  type GraphRegistry,
} from "./graph.ts";
import { mutationNamespace, type MutationContext } from "./mutation.ts";
import type { MutationNamespace } from "./mutation-schema.ts";
import {
  EntityRegistry,
  rowIdentity,
  type EntityHandle,
} from "./entity.ts";
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
  readonly status: "pending" | "ready" | "error";
  readonly data: Out | undefined;
  readonly stale: boolean;
  readonly error: Error | undefined;
};

export type QuerySubscription<Out> = Subscription<QuerySnapshot<Out>>;

export const queryObservationKey = (query: AnyQueryObject): string => {
  const { lowering, identities } = symbolicIdentityLowering();
  const lowered = lowerQueryObject(query, lowering);
  const focus = entityFocusOf(query);
  return JSON.stringify([
    lowered.query,
    lowered.shape,
    identities,
    focus === undefined ? null : `${focus._tag}:${focus.ns}`,
  ]);
};

const PENDING: QuerySnapshot<never> = Object.freeze({
  status: "pending" as const,
  data: undefined,
  stale: true,
  error: undefined,
});

export type SessionDisposition = {
  readonly status: SyncStatus;
  readonly publishes: boolean;
};

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
      return snapshot.terminalCode === "update-required" ||
          snapshot.terminalCode === "incompatible-version"
        ? { status: "update-required", publishes: false }
        : { status: "offline", publishes: true };
    case "failed":
      switch (snapshot.failure) {
        case "unauthorized":
          return { status: "authentication-required", publishes: false };
        case "fenced":
          return { status: "connecting", publishes: false };
        default:
          return { status: "offline", publishes: true };
      }
    case "closed":
      return { status: "closed", publishes: false };
  }
};

type RetiredObservation = {
  readonly snapshot: QuerySnapshot<unknown>;
  readonly plain: unknown;
};

/** Everything a database handle needs from the client that owns it. */
export type DatabaseContext = {
  readonly server: string;
  readonly root: string;
  readonly graphPath: readonly string[];
  readonly graphLineage?: (() => readonly string[] | undefined) | undefined;
  readonly graph: () => GraphRegistry;
  readonly catalog: () => Promise<ClientCatalog>;
  readonly storage: () => Promise<IndexedDbReplicaStorage>;
  readonly credential: () => Promise<{
    readonly token: string;
    readonly cacheKey: string;
  }>;
  readonly assertLive: (operation: string) => void;
  readonly live: () => boolean;
  readonly onSyncChange: () => void;
  readonly onConfirmed: (identity: ReplicationIdentity) => void;
  readonly onFenced: () => void;
  readonly mutations: MutationContext;
};

const resumed = (
  prior: QuerySnapshot<unknown> | undefined,
): QuerySnapshot<unknown> => {
  if (prior === undefined || prior.status === "pending") return PENDING;
  return prior.stale ? prior : Object.freeze({ ...prior, stale: true });
};

class QueryObserver {
  readonly store: Store<QuerySnapshot<unknown>>;
  private scheduled = -1;

  private plain: unknown;

  constructor(
    private readonly lowered: LoweredKernelQuery,
    private readonly lower: () => LoweredKernelQuery,
    private readonly release: (self: QueryObserver) => void,
    private readonly shape: (rows: unknown) => unknown,
    retired?: RetiredObservation | undefined,
  ) {
    this.store = new Store<QuerySnapshot<unknown>>(resumed(retired?.snapshot));
    this.plain = retired?.plain;
  }

  rows(): unknown {
    return this.plain;
  }

  republish(changed: ReadonlySet<EntityHandle>): void {
    const prior = this.store.getSnapshot();
    if (prior.status !== "ready") return;
    if (!this.publishes(prior.data, changed)) return;
    this.store.publish(Object.freeze({ ...prior }));
  }

  private publishes(data: unknown, changed: ReadonlySet<EntityHandle>): boolean {
    if (changed.size === 0) return false;
    const rows = Array.isArray(data)
      ? data
      : typeof data === "object" && data !== null &&
          Array.isArray((data as { readonly rows?: unknown }).rows)
      ? (data as { readonly rows: readonly unknown[] }).rows
      : [data];
    return rows.some((row) => changed.has(row as EntityHandle));
  }

  subscribe(onChange: () => void): () => void {
    const stop = this.store.subscribe(onChange);
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
      const lowered = this.lowered.bindsEntities ? this.lower() : this.lowered;
      const rows = lowered.finalize(await runQuery(view, lowered.query));
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

  private publish(
    generation: number,
    status: QuerySnapshot<unknown>["status"],
    rows: unknown,
    stale: boolean,
    error: Error | undefined,
  ): void {
    if (generation < this.scheduled) return;
    const prior = this.store.getSnapshot();
    const unchangedData = sameResult(this.plain, rows);
    if (
      prior.status === status && prior.stale === stale &&
      prior.error === error && unchangedData
    ) return;
    const data = status !== "ready"
      ? undefined
      : unchangedData
      ? prior.data
      : this.shape(rows);
    this.plain = rows;
    this.store.publish(Object.freeze({ status, data, stale, error }));
  }
}

/**
 * The public database handle.
 *
 * `query.from` is the portable query language, unchanged: there is no client
 * query DSL, and a query value built here is the same inert value the deployed
 * code builds.
 */
export interface ClientDatabaseReads {
  readonly query: {
    readonly from: <N extends AnyComposer>(entity: N) => ClientQuery<N>;
  };
  readonly observe: {
    <N extends AnyComposer, Row, Out>(
      query: EntityFocused<N, Row, Out>,
    ): QuerySubscription<EntityResult<N, Row, Out>>;
    <Row, Out>(query: QueryObject<Row, Out>): QuerySubscription<ClientValue<Out>>;
  };
  readonly sync: Subscription<SyncState>;
}

export type ClientDatabase<Mutations = MutationNamespace> =
  & ClientDatabaseReads
  & { readonly mutate: Mutations };

/**
 * An activation failure whose cause decides a terminal state rather than
 * `offline`: a refused credential is not an unreachable network, and a storage
 * layer that will not open leaves no durable substrate to queue against.
 */
class ActivationFailed extends Error {
  constructor(readonly status: SyncStatus, cause: unknown) {
    super("ramose/client: activation failed", { cause });
  }
}

const activationStep = async <A>(
  status: SyncStatus,
  run: () => Promise<A>,
): Promise<A> => {
  try {
    return await run();
  } catch (cause) {
    throw new ActivationFailed(status, cause);
  }
};

export class ClientDatabaseHandle implements ClientDatabase, GraphAncestor {
  readonly query = { from: clientQueryFrom(this) };
  private mutations: MutationNamespace | undefined;

  get mutate(): MutationNamespace {
    this.mutations ??= mutationNamespace(
      this.context.mutations,
      this,
      this.context.mutations.databaseOperations(),
    );
    return this.mutations;
  }
  private readonly syncStore = new Store<SyncState>(syncState("idle"));
  readonly sync = this.syncStore.subscription;
  readonly binding: Subscription<unknown> = Object.freeze({
    subscribe: () => () => undefined,
    getSnapshot: () => this,
  });
  private readonly graphChildren = new Map<string, GraphDatabaseHandle>();

  private readonly observers = new Map<string, QueryObserver>();
  private readonly retired = new Map<string, RetiredObservation>();
  private activation: Promise<void> | undefined;
  private opening: Promise<void> | undefined;
  private readonly settling = new Set<Promise<void>>();
  private catalog: ClientCatalog | undefined;
  private session: ReplicationSession | undefined;
  private releaseSession: (() => void) | undefined;
  private reconciler: OptimisticReconciler | undefined;
  private reconcilerKey: string | undefined;
  private reconcilerPending: Promise<OptimisticReconciler> | undefined;
  private releaseOverlay: (() => void) | undefined;
  private identity: ReplicationIdentity | undefined;
  private committed: Db | undefined;
  private account: string | undefined;
  private handles: ReadonlyMap<string, number> = new Map();
  private reverse: Map<number, string> | undefined;
  private speculative: ReadonlyMap<number, string> = new Map();
  private registry: EntityRegistry | undefined;
  private viewValue: Db | undefined;
  private viewGeneration = 0;
  private lastSession: ReplicationSessionSnapshot | undefined;
  private stale = true;
  private updateRequired = false;
  private queueUpdateRequired = false;
  private closed = false;
  private refused = false;
  private wakePending = false;
  private awaitedRoute = false;
  private generation = 0;

  constructor(private readonly context: DatabaseContext) {}

  private spawn(work: Promise<unknown>): void {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.settling.add(settled);
    void settled.then(() => this.settling.delete(settled));
  }

  private async drain(): Promise<void> {
    while (this.settling.size > 0) {
      await Promise.all([...this.settling]);
    }
  }

  observe<N extends AnyComposer, Row, Out>(
    query: EntityFocused<N, Row, Out>,
  ): QuerySubscription<EntityResult<N, Row, Out>>;
  observe<Row, Out>(query: QueryObject<Row, Out>): QuerySubscription<ClientValue<Out>>;
  observe<Row, Out>(
    query: QueryObject<Row, Out>,
  ): QuerySubscription<ClientValue<Out>> {
    this.context.assertLive("observe");
    const value = query as AnyQueryObject;
    const lower = (): LoweredKernelQuery =>
      lowerQueryObject(value, {
        entity: (eid) => this.entityId(eid),
        resolveEntity: (id) =>
          typeof id === "string" ? this.localIdOf(id) : undefined,
      });
    const lowered = lower();
    const key = queryObservationKey(value);
    const shape = this.shapeRows(entityFocusOf(query), lowered);
    void this.activate();
    let last: QueryObserver | undefined = this.observers.get(key);
    return Object.freeze({
      subscribe: (onChange: () => void) => {
        const observer = this.acquire(key, lowered, lower, shape);
        last = observer;
        return observer.subscribe(onChange);
      },
      getSnapshot: (): QuerySnapshot<ClientValue<Out>> => {
        if (this.closed) return PENDING as QuerySnapshot<ClientValue<Out>>;
        const observer = this.observers.get(key);
        if (observer !== undefined) last = observer;
        return (last?.store.getSnapshot() ?? this.retired.get(key)?.snapshot ??
          PENDING) as QuerySnapshot<ClientValue<Out>>;
      },
    }) as QuerySubscription<ClientValue<Out>>;
  }

  private shapeRows(
    focus: AnyComposer | undefined,
    lowered: LoweredKernelQuery,
  ): (rows: unknown) => unknown {
    if (focus === undefined) return (rows) => rows;
    const wrap = (row: unknown): unknown => {
      const id = rowIdentity(row);
      return id === undefined
        ? row
        : this.entities().handle(id, focus, lowered.rowShape, row);
    };
    switch (lowered.result) {
      case "page":
        return (value) => {
          const page = value as { readonly rows: readonly unknown[] };
          return { ...page, rows: page.rows.map(wrap) };
        };
      case "row":
        return (value) => (value === null ? null : wrap(value));
      case "rows":
        return (value) => (Array.isArray(value) ? value.map(wrap) : value);
    }
  }

  private entities(): EntityRegistry {
    if (this.registry !== undefined) return this.registry;
    this.registry = new EntityRegistry(
      this.context.mutations,
      this,
      (focus) =>
        this.context.mutations.selfOperations({
          kind: focus._tag === "Trait" ? "trait" : "entity",
          name: focus.ns,
        }),
    );
    const mappings = this.reconciler?.mappings();
    if (mappings !== undefined) {
      for (const [ref, id] of mappings) this.registry.alias(ref as never, id);
    }
    const pending = this.reconciler?.snapshot().pending;
    if (pending !== undefined) this.registry.observe(pending);
    return this.registry;
  }

  private republishLocal(changed: ReadonlySet<EntityHandle>): void {
    for (const observer of this.observers.values()) observer.republish(changed);
  }

  private acquire(
    key: string,
    lowered: LoweredKernelQuery,
    lower: () => LoweredKernelQuery,
    shape: (rows: unknown) => unknown,
  ): QueryObserver {
    const existing = this.observers.get(key);
    if (existing !== undefined) return existing;
    const retired = this.retired.get(key);
    this.retired.delete(key);
    const observer = new QueryObserver(lowered, lower, (self) => {
      if (this.observers.get(key) !== self) return;
      this.observers.delete(key);
      this.retired.set(key, {
        snapshot: resumed(self.store.getSnapshot()),
        plain: self.rows(),
      });
    }, shape, retired);
    if (this.closed) return observer;
    this.observers.set(key, observer);
    this.spawn(observer.run(this.viewGeneration, this.viewValue, this.stale));
    return observer;
  }

  boundReconciler(): OptimisticReconciler | undefined {
    return this.reconciler;
  }

  authenticatedBy(credential: { readonly cacheKey: string }): boolean {
    return this.account !== undefined && this.account === credential.cacheKey;
  }

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

  graphChild(key: string, canonical: AnyQueryObject): GraphDatabaseHandle {
    const existing = this.graphChildren.get(key);
    if (existing !== undefined) return existing;
    const child = new GraphDatabaseHandle(
      this,
      canonical,
      this.context.graph(),
      (operation) => this.context.assertLive(operation),
      this.context.mutations,
    );
    this.graphChildren.set(key, child);
    return child;
  }

  activate(): Promise<void> {
    if (this.activation !== undefined) return this.activation;
    const opening = this.open().catch((cause: unknown) => {
      // A scope withdrawn while this activation was opening leaves no session
      // to publish the fence, so this is where that activation is put back to
      // nothing: the next wake-up starts a new one, admitted where the scope
      // stands now.
      if (isReplicaFenceError(cause)) {
        this.activation = undefined;
        this.refused = true;
        this.publishStatus("offline");
        return;
      }
      const terminal = cause instanceof ActivationFailed ? cause.status : undefined;
      if (terminal === undefined) {
        this.publishStatus("offline");
        return;
      }
      // Cleared so a later activation can retry: an expired token at boot is
      // recoverable the moment the application signs in again, and the waiters
      // are already settled by the fenced status published below.
      this.activation = undefined;
      this.refused = true;
      this.publishStatus(terminal);
    });
    this.activation = opening;
    // What "in flight" means for this handle, and the only thing that means
    // it. An activation that failed leaves its memo behind — settled, holding
    // nothing, and indistinguishable from one still opening by the memo alone
    // — so the retry paths ask this instead and never start a second open
    // beside a first.
    this.opening = opening;
    void opening.then(() => {
      if (this.opening !== opening) return;
      this.opening = undefined;
      this.answerWake();
    });
    return this.activation;
  }

  /**
   * Start one activation in place of a settled one.
   *
   * Every path that reopens a handle goes through here, so "one activation in
   * flight per handle" is one condition in one place: an open already running
   * is returned rather than joined by a second, which is what keeps a retry
   * from leaving the first holding a session nothing closes.
   */
  private restart(): Promise<void> {
    if (this.opening !== undefined) return this.opening;
    this.activation = undefined;
    return this.activate();
  }

  /**
   * Activate again after an activation that must start from nothing: a
   * credential this client or the server refused, or a fence that overtook it.
   *
   * `auth()` runs once per activation, so a refreshed bearer is presented by
   * the next one. This is what makes a refused client recoverable without
   * constructing another: the application signs in again and the next
   * activation wake-up — a focused tab, a page shown from bfcache, a broadcast
   * selector notice — carries the new credential. The refusal may have come
   * from `auth()` itself, which leaves no session behind, or from the server
   * answering the activation, which leaves one holding the refusal; either way
   * the next activation starts from nothing.
   *
   * An activation already opening is that next activation: it will present
   * whatever `auth()` answers now, and starting a second one beside it would
   * leave the first holding a session nothing closes.
   */
  reactivateRefused(): void {
    if (!this.live() || !this.refused) return;
    if (this.session === undefined && this.activation !== undefined) return;
    this.refused = false;
    this.releaseSession?.();
    this.releaseSession = undefined;
    const session = this.session;
    this.session = undefined;
    this.activation = undefined;
    if (session !== undefined) this.spawn(session.close());
    void this.activate();
  }

  /**
   * What this handle's own read stream says, rather than what the handle
   * publishes.
   *
   * The published status is an aggregate: a queue this build cannot replay
   * reports `update-required` over a committed replica that is readable and a
   * read stream that was perfectly compatible, and deciding a retry on that
   * aggregate would leave exactly that database never reading again after a
   * cut. Every disposition that must stay fenced — a rotated view, a refused
   * credential, a fence — still says so here, now decided by the session that
   * produced it.
   */
  private disposition(): SyncStatus {
    const snapshot = this.session?.snapshot();
    return snapshot === undefined
      ? this.syncStatus()
      : readSessionSnapshot(snapshot).status;
  }

  /**
   * Activate again after an activation that could not reach the server.
   *
   * A connection that dies is not a refusal and not a fence. It publishes
   * `offline`, leaves whatever was already confirmed readable, and leaves the
   * memoized activation settled behind it — and nothing else starts another
   * one. `reactivateRefused()` answers a credential this client or the server
   * refused; `reactivateUnconfirmed()` answers a route another tab confirmed,
   * for a child that has none of its own. Neither describes a device that just
   * came back, so this is the path it comes back on.
   *
   * A wake this handle cannot answer yet is remembered rather than dropped.
   * `online` fires on a transition and a foreground tab that never loses focus
   * regains it never, so a wake that lands while an activation is still opening
   * — or while a stream that is already dead has not published its failure yet
   * — is the only one this device is going to send. `answerWake()` asks it
   * again the moment the disposition is known.
   *
   * The session this was holding is closed before another opens: a transport
   * failure has already ended its stream, and leaving it attached would leave
   * two observers publishing into one handle.
   */
  reactivateOffline(): void {
    if (!this.live() || this.refused) return;
    if (this.opening !== undefined || this.disposition() !== "offline") {
      this.wakePending = true;
      return;
    }
    this.wakePending = false;
    const session = this.session;
    this.releaseSession?.();
    this.releaseSession = undefined;
    this.session = undefined;
    if (session !== undefined) this.spawn(session.close());
    void this.restart();
  }

  /**
   * Ask a remembered wake again now that this handle's disposition has moved.
   *
   * Called where a disposition becomes known: when an activation settles, and
   * when the session publishes.
   *
   * A wake is *not* answered by a value: a stream that is already dying can
   * publish a buffered frame, or a keep-alive, before it publishes the failure
   * that ended it, and treating that as an answer would drop the one wake this
   * device was going to send. So a remembered wake is only ever spent — by the
   * retry it asks for — or dropped where no later activation could change the
   * answer: a refused credential, a build that is behind, a closed handle.
   * Held otherwise, which costs at most one reconnection attempt the first time
   * a stream fails after the tab was last activated.
   */
  private answerWake(): void {
    if (!this.wakePending) return;
    if (!this.live()) {
      this.wakePending = false;
      return;
    }
    if (this.opening !== undefined) return;
    const disposition = this.disposition();
    if (disposition === "offline" && !this.refused) {
      this.reactivateOffline();
      return;
    }
    if (
      this.refused || disposition === "authentication-required" ||
      disposition === "update-required" || disposition === "closed"
    ) this.wakePending = false;
  }

  private async open(): Promise<void> {
    // `connecting` says nothing is readable and `stale` says something is,
    // unconfirmed — so a reactivation over a value this handle is still
    // publishing is `stale`, and a build that is behind keeps saying so rather
    // than being talked over by an activation that cannot change it.
    this.publishStatus(
      this.updateRequired || this.queueUpdateRequired
        ? "update-required"
        : this.committed === undefined
        ? "connecting"
        : "stale",
    );
    // And every observer says the same thing. A retained value stops being
    // confirmed when this activation begins, not when it answers — the two
    // `stale` signals an application renders from are one fact, and a
    // reconnect that can take a storage read and a credential is exactly the
    // window where they would otherwise disagree.
    if (this.committed !== undefined && !this.stale) {
      this.stale = true;
      this.spawn(this.recompute());
    }
    const [catalog, storage] = await activationStep(
      "closed",
      () => Promise.all([this.context.catalog(), this.context.storage()]),
    );
    if (!this.live()) return;
    this.catalog = catalog;
    const credential = await activationStep(
      "authentication-required",
      () => this.context.credential(),
    );
    if (!this.live()) return;
    const lineage = this.context.graphLineage?.();
    this.account = credential.cacheKey;
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

  /**
   * Read the durable committed head again and republish what changed.
   *
   * Another tab of this scope installs into the same IndexedDB records, so a
   * tab whose own stream has ended still renders what the scope committed.
   */
  async refreshCommitted(): Promise<void> {
    if (!this.live()) return;
    await this.session?.refreshFromDurable().catch(() => false);
  }

  /**
   * Read the durable optimistic layers, mappings, and activation fence again
   * and republish the local value, the pending sidecars, and the observers
   * they feed.
   */
  async refreshOptimistic(): Promise<void> {
    if (!this.live()) return;
    await this.reconciler?.refresh().catch(() => undefined);
  }

  /**
   * Open the session again for a database whose durable identity is still
   * unconfirmed, so a route another tab has since confirmed is read rather
   * than waited for.
   *
   * An activation that has not produced a session yet is one already in
   * flight, and reading the route again is what it is on its way to doing:
   * clearing the guard for it would leave two opens racing to own one handle.
   */
  reactivateUnconfirmed(): void {
    if (!this.live() || this.identity !== undefined) return;
    if (this.activation === undefined || this.context.graphPath.length === 0) return;
    const session = this.session;
    if (session === undefined) {
      this.awaitedRoute = true;
      return;
    }
    const status = session.snapshot().status;
    if (status !== "failed" && status !== "terminal" && status !== "closed") return;
    this.releaseSession?.();
    this.releaseSession = undefined;
    this.session = undefined;
    this.activation = undefined;
    this.spawn(session.close());
    void this.activate();
  }

  async reconcileSubmissions(
    progress: readonly QueueProgress[],
  ): Promise<void> {
    const scope = this.confirmedScope();
    const mine = scope === undefined ? undefined : replicaDatabaseKey(scope);
    if (
      !this.queueUpdateRequired && mine !== undefined &&
      progress.some((entry) =>
        entry.state._tag === "UpdateRequired" &&
        replicaDatabaseKey(entry.receiver) === mine
      )
    ) {
      this.queueUpdateRequired = true;
      this.publishStatus("update-required");
    }
    const reconciler = this.reconciler;
    if (reconciler === undefined || !this.live()) return;
    const session = this.session;
    await reconciler.reconcile(
      progress,
      session === undefined ? undefined : {
        close: async () => {
          this.releaseSession?.();
          this.releaseSession = undefined;
          this.session = undefined;
          await session.close();
        },
      },
    );
    if (this.session === undefined && this.live()) await this.restart();
  }

  private live(): boolean {
    return !this.closed && this.context.live();
  }

  private accept(snapshot: ReplicationSessionSnapshot): void {
    if (this.closed) return;
    if (snapshot.status === "closed") {
      this.fence();
      this.context.onFenced();
      return;
    }
    if (snapshot.status === "failed" && snapshot.failure === "fenced") {
      this.refence();
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
      this.context.mutations.submit(replicaDatabaseScopeOf(identity));
      this.spawn(this.bindReconciler(identity));
    }
    this.lastSession = snapshot;
    const disposition = readSessionSnapshot(snapshot);
    // The server answering the activation with a refusal is the other way a
    // credential is refused, and the one a refreshed bearer recovers from.
    if (disposition.status === "authentication-required") this.refused = true;
    this.stale = value === undefined ? true : value.stale;
    const catalog = this.catalog;
    if (!disposition.publishes || value === undefined || catalog === undefined) {
      this.committed = undefined;
      this.forgetHandles();
    } else {
      this.committed = value.db.withComposition(catalog.composition);
      this.handles = value.handles;
      this.reverse = undefined;
    }
    this.publishStatus(this.statusOf(snapshot));
    this.spawn(this.recompute());
    this.retryAwaitedRoute();
    this.answerWake();
  }

  /**
   * Read the route again for a selector notice that arrived while this
   * handle's own activation was still opening.
   *
   * That open read the route slot before the other tab wrote it, so the notice
   * it would have answered was dropped. Answering it once the session settles
   * is what keeps the recovery from waiting for the next notice.
   */
  private retryAwaitedRoute(): void {
    if (!this.awaitedRoute || this.identity !== undefined) return;
    const status = this.session?.snapshot().status;
    if (status !== "failed" && status !== "terminal" && status !== "closed") return;
    this.awaitedRoute = false;
    this.reactivateUnconfirmed();
  }

  private fence(): void {
    this.closed = true;
    this.generation++;
    this.committed = undefined;
    this.forgetHandles();
    this.withdrawEntities();
    this.forgetCredential();
    this.viewValue = undefined;
    this.viewGeneration = this.generation;
    this.releaseOverlay?.();
    this.releaseOverlay = undefined;
    this.reconciler = undefined;
    this.reconcilerPending = undefined;
    this.reconcilerKey = undefined;
    for (const observer of this.observers.values()) {
      this.spawn(observer.run(this.generation, undefined, true));
    }
    this.observers.clear();
    this.retired.clear();
    this.closeGraphChildren();
    this.syncStore.publish(syncState("closed"));
  }

  private closeGraphChildren(): void {
    for (const child of this.graphChildren.values()) child.close();
    this.graphChildren.clear();
  }

  private transition(status: SyncStatus = "authentication-required"): void {
    this.generation++;
    this.committed = undefined;
    this.forgetHandles();
    this.withdrawEntities();
    this.forgetCredential();
    this.viewValue = undefined;
    this.viewGeneration = this.generation;
    this.reconciler = undefined;
    this.reconcilerKey = undefined;
    this.reconcilerPending = undefined;
    this.releaseOverlay?.();
    this.releaseOverlay = undefined;
    this.updateRequired = false;
    this.retired.clear();
    this.publishStatus(status);
    for (const observer of this.observers.values()) {
      this.spawn(observer.run(this.generation, undefined, true));
    }
  }

  /**
   * Withdraw what a fenced session was holding and activate again.
   *
   * The scope this handle was reading was cleared or given to another
   * principal, so the value it holds is one no tab may publish. Activating
   * again is what reaches the state the scope is in now: the credential this
   * client presents decides which principal answers, and nothing from the
   * fenced one survives the transition.
   */
  private refence(): void {
    this.releaseSession?.();
    this.releaseSession = undefined;
    const session = this.session;
    this.session = undefined;
    this.identity = undefined;
    this.lastSession = undefined;
    this.activation = undefined;
    this.transition("connecting");
    if (session !== undefined) this.spawn(session.close());
    if (this.live()) void this.activate();
  }

  /**
   * Re-read the durable generations this handle's session adopted, so a clear
   * or principal replacement another tab committed withdraws this value.
   */
  async revalidate(): Promise<void> {
    if (!this.live()) return;
    await this.session?.revalidate().catch(() => false);
  }

  private statusOf(snapshot: ReplicationSessionSnapshot): SyncStatus {
    const status = readSessionSnapshot(snapshot).status;
    if (status === "authentication-required" || status === "closed") return status;
    return this.updateRequired || this.queueUpdateRequired
      ? "update-required"
      : status;
  }

  private publishStatus(status: SyncStatus): void {
    if (this.closed && status !== "closed") return;
    if (this.syncStore.publish(syncState(status))) this.context.onSyncChange();
  }

  syncStatus(): SyncStatus {
    return this.syncStore.getSnapshot().status;
  }

  activated(): boolean {
    return this.activation !== undefined;
  }

  confirmedIdentity(): ReplicationIdentity | undefined {
    return this.identity;
  }

  viewWithdrawn(): boolean {
    if (this.closed) return true;
    return this.lastSession !== undefined &&
      !readSessionSnapshot(this.lastSession).publishes;
  }

  private async recompute(): Promise<void> {
    const generation = ++this.generation;
    const committed = this.committed;
    const reconciler = this.reconciler;
    const layers = reconciler?.snapshot().layers ?? emptyOverlayLayers;
    let view = committed;
    let speculative = new Map<number, string>();
    if (committed !== undefined && reconciler !== undefined && layers.length > 0) {
      try {
        const overlay = await reconciler.view(committed);
        view = overlay.db;
        for (const [handle, local] of overlay.speculative) {
          speculative.set(local, handle);
        }
      } catch {
        view = committed;
        speculative = new Map();
      }
    }
    if (generation !== this.generation || this.closed) return;
    this.viewValue = view;
    this.speculative = speculative;
    this.viewGeneration = generation;
    const stale = this.stale;
    for (const observer of this.observers.values()) {
      this.spawn(observer.run(generation, view, stale));
    }
  }

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
      if (this.reconcilerPending === pending) {
        this.reconcilerKey = undefined;
        this.reconcilerPending = undefined;
      }
      throw cause;
    });
    this.reconcilerPending = pending;
    return pending;
  }

  private reconciliationOptions(): ReconciliationOptions {
    return { entity: (id) => this.handles.get(id) };
  }

  private forgetCredential(): void {
    this.account = undefined;
  }

  private forgetHandles(): void {
    this.handles = new Map();
    this.reverse = undefined;
    this.speculative = new Map();
  }

  private withdrawEntities(): void {
    this.registry?.clear();
    this.registry = undefined;
  }

  private entityId(eid: number): string {
    const handle = this.sealedHandleOf(eid);
    if (handle !== undefined) return handle;
    const speculative = this.speculative.get(eid);
    if (speculative !== undefined) return speculative;
    throw new Error(
      "ramose/client: this row has no opaque identity in the current local value",
    );
  }

  private localIdOf(id: string): number | undefined {
    const mapped = this.reconciler?.mappings().get(id);
    const committed = this.handles.get(mapped ?? id);
    if (committed !== undefined) return committed;
    for (const [local, handle] of this.speculative) {
      if (handle === id || (mapped !== undefined && handle === mapped)) {
        return local;
      }
    }
    return undefined;
  }

  sealedHandleOf(eid: number): string | undefined {
    if (this.reverse === undefined) {
      const reverse = new Map<number, string>();
      for (const [handle, local] of this.handles) reverse.set(local, handle);
      this.reverse = reverse;
    }
    return this.reverse.get(eid);
  }

  confirmedScope(): ReplicaDatabaseScope | undefined {
    return this.identity === undefined
      ? undefined
      : replicaDatabaseScopeOf(this.identity);
  }

  private overlay(state: OptimisticOverlayState): void {
    if (this.closed) return;
    const moved = this.registry?.observe(state.pending);
    if (moved !== undefined && moved.size > 0) this.republishLocal(moved);
    const mappings = this.reconciler?.mappings();
    if (mappings !== undefined) {
      for (const [ref, id] of mappings) {
        this.registry?.alias(ref as never, id);
      }
    }
    const required = state.updateRequired.length > 0;
    if (required !== this.updateRequired) {
      this.updateRequired = required;
      this.publishStatus(
        required
          ? "update-required"
          : this.statusOf(this.lastSession ?? { status: "connecting" }),
      );
    }
    this.spawn(this.recompute());
  }

  private async settleActivation(): Promise<void> {
    const identity = this.session?.snapshot().value?.identity ?? this.identity;
    if (identity === undefined || this.closed) return;
    const reconciler = await this.bindReconciler(identity);
    await reconciler.outcome(reconciler.activation())();
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.drain();
      return;
    }
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
    this.withdrawEntities();
    this.forgetCredential();
    this.viewValue = undefined;
    for (const observer of this.observers.values()) {
      this.spawn(observer.run(this.generation, undefined, true));
    }
    this.observers.clear();
    this.retired.clear();
    this.closeGraphChildren();
    this.syncStore.publish(syncState("closed"));
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) await session.close();
    await this.activation?.catch(() => undefined);
    await this.drain();
  }
}
