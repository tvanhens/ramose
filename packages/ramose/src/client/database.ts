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
import { mutationNamespace, type MutationContext, type MutationNamespace } from "./mutation.ts";
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
  const lowered = lowerQueryObject(query);
  const focus = entityFocusOf(query);
  return JSON.stringify([
    lowered.query,
    lowered.shape,
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
      return snapshot.failure === "unauthorized"
        ? { status: "authentication-required", publishes: false }
        : { status: "offline", publishes: true };
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
      const rows = this.lowered.finalize(await runQuery(view, this.lowered.query));
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
export interface ClientDatabase {
  readonly query: {
    readonly from: <N extends AnyComposer>(entity: N) => ClientQuery<N>;
  };
  readonly observe: {
    <N extends AnyComposer, Row, Out>(
      query: EntityFocused<N, Row, Out>,
    ): QuerySubscription<EntityResult<Row, Out>>;
    <Row, Out>(query: QueryObject<Row, Out>): QuerySubscription<ClientValue<Out>>;
  };
  readonly mutate: MutationNamespace;
  readonly sync: Subscription<SyncState>;
}

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
  private generation = 0;

  constructor(private readonly context: DatabaseContext) {}

  observe<N extends AnyComposer, Row, Out>(
    query: EntityFocused<N, Row, Out>,
  ): QuerySubscription<EntityResult<Row, Out>>;
  observe<Row, Out>(query: QueryObject<Row, Out>): QuerySubscription<ClientValue<Out>>;
  observe<Row, Out>(
    query: QueryObject<Row, Out>,
  ): QuerySubscription<ClientValue<Out>> {
    this.context.assertLive("observe");
    const value = query as AnyQueryObject;
    const lowered = lowerQueryObject(value, {
      entity: (eid) => this.entityId(eid),
      resolveEntity: (id) =>
        typeof id === "string" ? this.localIdOf(id) : undefined,
    });
    const key = queryObservationKey(value);
    const shape = this.shapeRows(entityFocusOf(query), lowered);
    void this.activate();
    let last: QueryObserver | undefined = this.observers.get(key);
    return Object.freeze({
      subscribe: (onChange: () => void) => {
        const observer = this.acquire(key, lowered, shape);
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
    shape: (rows: unknown) => unknown,
  ): QueryObserver {
    const existing = this.observers.get(key);
    if (existing !== undefined) return existing;
    const retired = this.retired.get(key);
    this.retired.delete(key);
    const observer = new QueryObserver(lowered, (self) => {
      if (this.observers.get(key) !== self) return;
      this.observers.delete(key);
      this.retired.set(key, {
        snapshot: resumed(self.store.getSnapshot()),
        plain: self.rows(),
      });
    }, shape, retired);
    if (this.closed) return observer;
    this.observers.set(key, observer);
    void observer.run(this.viewGeneration, this.viewValue, this.stale);
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
    this.activation = this.open().catch((cause: unknown) => {
      const terminal = cause instanceof ActivationFailed ? cause.status : undefined;
      if (terminal === undefined) {
        this.publishStatus("offline");
        return;
      }
      // Cleared so a later activation can retry: an expired token at boot is
      // recoverable the moment the application signs in again, and the waiters
      // are already settled by the fenced status published below.
      this.activation = undefined;
      this.publishStatus(terminal);
    });
    return this.activation;
  }

  private async open(): Promise<void> {
    this.publishStatus("connecting");
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
    if (this.session === undefined && this.live()) await this.open();
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
      this.handles = value.handles;
      this.reverse = undefined;
    }
    this.publishStatus(this.statusOf(snapshot));
    void this.recompute();
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
      void observer.run(this.generation, undefined, true);
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

  private transition(): void {
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
    this.publishStatus("authentication-required");
    for (const observer of this.observers.values()) {
      void observer.run(this.generation, undefined, true);
    }
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
      void observer.run(generation, view, stale);
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
    const committed = this.handles.get(id);
    if (committed !== undefined) return committed;
    for (const [local, handle] of this.speculative) {
      if (handle === id) return local;
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
    void this.recompute();
  }

  private async settleActivation(): Promise<void> {
    const identity = this.session?.snapshot().value?.identity ?? this.identity;
    if (identity === undefined || this.closed) return;
    const reconciler = await this.bindReconciler(identity);
    await reconciler.outcome(reconciler.activation())();
  }

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
    this.withdrawEntities();
    this.forgetCredential();
    this.viewValue = undefined;
    for (const observer of this.observers.values()) {
      void observer.run(this.generation, undefined, true);
    }
    this.observers.clear();
    this.retired.clear();
    this.closeGraphChildren();
    this.syncStore.publish(syncState("closed"));
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) await session.close();
    await this.activation?.catch(() => undefined);
  }
}
