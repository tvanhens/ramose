import { COMPOSED_TRAITS, type AnyComposer } from "../db/Composer.ts";
import type { AnyEntity } from "../db/Entity.ts";
import type { Eid } from "../db/Eid.ts";
import {
  isClientRef,
  isEntityId,
  type EntityId,
  type MutationRef,
} from "../db/refs.ts";
import type { EntityHandle } from "./entity.ts";
import { NotOne } from "../db/Errors.ts";
import { Graph } from "../db/Graph.ts";
import type { EntityRow, FluentQuery, WhereEq } from "../db/query/fluent.ts";
import type { FocusAttr } from "../db/query/focus.ts";
import type { IdRow } from "../db/query/lib.ts";
import { select as selectStage } from "../db/query/lib.ts";
import {
  from as queryFrom,
  q,
  type AnyQueryObject,
  type Cursor,
  type Page,
  type Pipeline,
  type QueryObject,
  type QueryOrderKey,
} from "../db/query/index.ts";
import type { OrderDir, OrderEmpty } from "../db/shapes.ts";
import type { ReplicationIdentity } from "../internal/replication/protocol.ts";
import {
  replicaDatabaseKey,
  replicaDatabaseScopeOf,
  type ReplicaDatabaseScope,
} from "../internal/replication/replica-lifecycle.ts";
import {
  ClientDatabaseHandle,
  queryObservationKey,
  type ClientDatabase,
  type QuerySnapshot,
  type QuerySubscription,
} from "./database.ts";
import { GraphPathError, GraphReceiverError } from "./errors.ts";
import { mutationNamespace, type MutationContext } from "./mutation.ts";
import type {
  EntityMutations,
  MutationNamespace,
} from "./mutation-schema.ts";
import { Store, type Subscription } from "./subscription.ts";
import { syncState, type SyncState, type SyncStatus } from "./sync.ts";

/**
 * Whether this focus carries the deployed `Graph` trait.
 *
 * Static, from the installed catalog: `.db()` exists exactly where the authored
 * schema says a child catalog is bound, and never appears or disappears based
 * on a client-side authorization guess.
 */
export type ComposesGraph<N> = N extends {
  readonly [COMPOSED_TRAITS]: { readonly graph: true };
} ? true
  : N extends { readonly _tag: "Trait"; readonly ns: "graph" } ? true
  : false;

const composesGraph = (ns: AnyComposer): boolean => {
  const composed = (ns as { readonly [COMPOSED_TRAITS]?: Record<string, true> })[
    COMPOSED_TRAITS
  ];
  if (composed?.["graph"] === true) return true;
  return ns._tag === "Trait" && ns.ns === "graph";
};

/** The `.db()` an exactly-one Graph focus carries. */
export type GraphFocusDb = {
  readonly db: () => ClientDatabase;
};

declare const EntityFocusBrand: unique symbol;

/**
 * A query value that still has one entity focus, stated at the type level.
 *
 * The runtime marker and this brand say the same thing from two directions: the
 * chain that keeps the focus carries both, and `select` — which projects the
 * focus away — carries neither. That is what lets `observe` promise live entity
 * handles for one and plain rows for the other without inspecting any data.
 *
 * Phantom: nothing reads this property, and the value it would hold is the
 * composer the query started from.
 */
export type EntityFocused<N extends AnyComposer, Row, Out> =
  & QueryObject<Row, Out>
  & { readonly [EntityFocusBrand]: N };

/**
 * What an entity-focused observation publishes, in place of its rows.
 *
 * The row shape is preserved as the handle's `.data`, so an application reads
 * `issue.data.title` where it used to read `issue.title` — and the handle
 * carries the two things a plain row cannot: this client's own pending state,
 * and the operations the deployed catalog declares for the entity's type.
 */
export type EntityResult<N extends AnyComposer, Row, Out> = EntityResultOf<
  EntityHandle<ClientValue<Row>, EntityMutations<N>>,
  Out
>;

type EntityResultOf<Handle, Out> = [Out] extends [readonly unknown[]]
  ? readonly Handle[]
  : [Out] extends [{ readonly rows: readonly unknown[] }]
    ? Omit<Out, "rows"> & { readonly rows: readonly Handle[] }
  : null extends Out ? Handle | null
  : Handle;

/** A `.one()` / `.oneOrFail()` terminal, with `.db()` only where it belongs. */
export type GraphFocus<
  N extends AnyComposer,
  Row,
  Out,
  Term extends "one" | "oneOrFail",
> = ComposesGraph<N> extends true
  ? QueryObject<Row, Out, Term> & GraphFocusDb & { readonly [EntityFocusBrand]: N }
  : QueryObject<Row, Out, Term> & { readonly [EntityFocusBrand]: N };

/**
 * The portable fluent chain, re-typed so an entity-focused terminal can name a
 * database. Nothing here is a second query language: every value is the same
 * inert `QueryObject` the deployed code builds, and `.db()` is the only
 * addition.
 *
 * The chain keeps its entity focus through `where` / `orderBy` / `limit` /
 * `offset` / `ids`. `select` projects the focus away, so its result is an
 * ordinary {@link FluentQuery} — a projection is not an entity, and cannot name
 * a database.
 */
export interface ClientQuery<
  N extends AnyComposer,
  Row = EntityRow<N>,
  Out = readonly Row[],
> extends FluentQuery<N, Row, Out> {
  readonly [EntityFocusBrand]: N;

  where<const W extends WhereEq<N>>(eq: W): ClientQuery<N, Row, Out>;
  where(
    ...stages: ReadonlyArray<(q: Pipeline<Row, N>) => Pipeline<Row, N>>
  ): ClientQuery<N, Row, Out>;

  orderBy(
    key: QueryOrderKey<Row> | FocusAttr<N>,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): ClientQuery<N, Row, Out>;

  limit(n: number): ClientQuery<N, Row, Out>;
  offset(n: number): ClientQuery<N, Row, Out>;
  after(cursor: Cursor | null): EntityFocused<N, Row, Page<Row>>;
  ids(): ClientQuery<N, IdRow<N>>;

  one(): GraphFocus<N, Row, Row | null, "one">;
  oneOrFail(): GraphFocus<N, Row, Row, "oneOrFail">;
}

/**
 * One observed value, with every entity id rendered as the opaque identity the
 * client publishes: an `EntityId`, or a `ClientRef` for an entity this device
 * created and the server has not issued a handle for yet.
 */
export type ClientValue<A> = A extends Eid<infer E extends AnyEntity>
  ? MutationRef<E>
  : A extends Date | Uint8Array ? A
  : A extends readonly (infer Item)[] ? readonly ClientValue<Item>[]
  : A extends object ? {
      readonly [K in keyof A]: K extends ":db/id"
        ? MutationRef | Extract<A[K], undefined>
        : ClientValue<A[K]>;
    }
  : A;

export interface GraphAncestor {
  readonly activateGraph: () => void;
  readonly boundDatabase: () => ClientDatabaseHandle | undefined;
  readonly bindingFailure: () => Error | undefined;
  readonly binding: Subscription<unknown>;
  readonly graphChild: (
    key: string,
    canonical: AnyQueryObject,
  ) => GraphDatabaseHandle;
}

type AnyFluent = FluentQuery<AnyComposer, unknown, unknown>;

const CURSOR_STAGES: ReadonlySet<string> = new Set(["orderBy", "limit", "offset"]);

export const graphResolutionQuery = (
  logic: AnyFluent,
  ns: AnyComposer,
): AnyQueryObject => {
  const shape = { id: ns.id, name: Graph.name };
  const body = (): Pipeline => {
    const pipe = (logic as unknown as { body: () => Pipeline }).body();
    return selectStage(shape as never)({
      ...pipe,
      stages: pipe.stages.filter((stage) => !CURSOR_STAGES.has(stage.kind)),
    } as never) as unknown as Pipeline;
  };
  return (q(body as never) as AnyQueryObject).oneOrFail();
};

export const graphStableKey = (
  scope: ReplicaDatabaseScope,
  entity: string,
): string => `${replicaDatabaseKey(scope)} ${entity}`;

export const receiverStableKey = (receiver: ReplicaDatabaseScope): string =>
  `receiver ${replicaDatabaseKey(receiver)}`;

type ResolvedSegment = {
  readonly id: EntityId;
  readonly name: string;
};

const segmentIdentity = (row: unknown): unknown => {
  if (row === null || typeof row !== "object") return undefined;
  const id = (row as { id?: unknown }).id;
  return typeof id === "object" && id !== null ? (id as { id?: unknown }).id : id;
};

const resolvedSegment = (row: unknown): ResolvedSegment | undefined => {
  if (row === null || typeof row !== "object") return undefined;
  const { name } = row as { name?: unknown };
  const handle = segmentIdentity(row);
  if (!isEntityId(handle) || typeof name !== "string") return undefined;
  return { id: handle, name };
};

const CHAIN = ["where", "orderBy", "limit", "offset", "ids", "after"] as const;

export const ENTITY_FOCUS = Symbol.for("ramose/client/entity-focus") as symbol;

export const entityFocusOf = (query: unknown): AnyComposer | undefined => {
  if (query === null || typeof query !== "object") return undefined;
  const focus = (query as Record<symbol, unknown>)[ENTITY_FOCUS];
  return focus === undefined ? undefined : (focus as AnyComposer);
};

const decorate = (
  fluent: AnyFluent,
  logic: AnyFluent,
  ns: AnyComposer,
  node: GraphAncestor,
): AnyFluent => {
  const wrapped = { ...fluent } as unknown as Record<string | symbol, unknown>;
  wrapped[ENTITY_FOCUS] = ns;
  for (const key of CHAIN) {
    const method = (fluent as unknown as Record<string, unknown>)[key];
    if (typeof method !== "function") continue;
    wrapped[key] = (...args: unknown[]): AnyFluent =>
      decorate(
        (method as (...a: unknown[]) => AnyFluent).apply(fluent, args),
        key === "where"
          ? (logic as unknown as Record<string, (...a: unknown[]) => AnyFluent>)[
            "where"
          ]!.apply(logic, args)
          : logic,
        ns,
        node,
      );
  }
  for (const key of ["one", "oneOrFail"] as const) {
    wrapped[key] = (): unknown => {
      const taken = (fluent as unknown as Record<string, () => unknown>)[key]!
        .call(fluent);
      if (!composesGraph(ns)) {
        return Object.assign({ [ENTITY_FOCUS]: ns }, taken);
      }
      return Object.assign({ [ENTITY_FOCUS]: ns }, taken, {
        db: (): ClientDatabase => {
          const canonical = graphResolutionQuery(logic, ns);
          return node.graphChild(queryObservationKey(canonical), canonical);
        },
      });
    };
  }
  return wrapped as unknown as AnyFluent;
};

export const clientQueryFrom = (node: GraphAncestor) =>
<N extends AnyComposer>(entity: N): ClientQuery<N> => {
  const base = queryFrom(entity) as unknown as AnyFluent;
  return decorate(base, base, entity, node) as unknown as ClientQuery<N>;
};

export type GraphDatabaseFactory = (input: {
  readonly graphPath: readonly string[];
  readonly graphLineage: () => readonly string[] | undefined;
  readonly onConfirmed: (identity: ReplicationIdentity) => void;
}) => ClientDatabaseHandle;

const samePath = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((segment, index) => segment === right[index]);

export class GraphRegistry {
  private readonly databases = new Map<string, {
    readonly path: readonly string[];
    readonly handle: ClientDatabaseHandle;
    readonly holders: Set<object>;
  }>();
  private readonly lineages = new Map<string, readonly string[]>();
  private readonly closing = new Set<Promise<void>>();

  constructor(
    private readonly factory: GraphDatabaseFactory,
    private readonly membershipChanged: () => void,
  ) {}

  private release(handle: ClientDatabaseHandle): void {
    const settled = handle.close().catch(() => undefined);
    this.closing.add(settled);
    void settled.then(() => this.closing.delete(settled));
  }

  acquire(
    stable: string,
    graphPath: readonly string[],
    holder: object,
  ): ClientDatabaseHandle {
    const existing = this.databases.get(stable);
    if (existing !== undefined) {
      if (samePath(existing.path, graphPath)) {
        existing.holders.add(holder);
        return existing.handle;
      }
      this.databases.delete(stable);
      this.release(existing.handle);
    }
    const handle = this.factory({
      graphPath,
      graphLineage: () => {
        const lineage = this.lineages.get(stable);
        return lineage?.length === graphPath.length ? lineage : undefined;
      },
      onConfirmed: (identity) => {
        if (identity.graphLineage.length === graphPath.length) {
          this.lineages.set(stable, identity.graphLineage);
        }
      },
    });
    this.databases.set(stable, {
      path: graphPath,
      handle,
      holders: new Set([holder]),
    });
    this.membershipChanged();
    return handle;
  }

  retire(stable: string, holder: object): void {
    const existing = this.databases.get(stable);
    if (existing === undefined) return;
    existing.holders.delete(holder);
    if (existing.holders.size > 0) return;
    this.databases.delete(stable);
    this.lineages.delete(stable);
    this.release(existing.handle);
    this.membershipChanged();
  }

  handles(): readonly ClientDatabaseHandle[] {
    return [...this.databases.values()].map(({ handle }) => handle);
  }

  async close(): Promise<void> {
    const handles = [...this.databases.values()].map(({ handle }) => handle);
    this.databases.clear();
    this.lineages.clear();
    for (const handle of handles) this.release(handle);
    while (this.closing.size > 0) await Promise.all([...this.closing]);
  }
}

type GraphBinding =
  | { readonly status: "pending" }
  | { readonly status: "bound"; readonly db: ClientDatabaseHandle }
  | { readonly status: "failed"; readonly error: Error };

const PENDING_BINDING: GraphBinding = Object.freeze({ status: "pending" });

const PENDING_SNAPSHOT: QuerySnapshot<never> = Object.freeze({
  status: "pending" as const,
  data: undefined,
  stale: true,
  error: undefined,
});

const unavailable = (): GraphPathError =>
  new GraphPathError({
    reason: "unavailable",
    message: "this graph path does not name a database you can read",
  });

export const terminalPathError = (
  status: SyncStatus,
): GraphPathError | undefined => {
  switch (status) {
    case "authentication-required":
      return new GraphPathError({
        reason: "unauthorized",
        message: "an ancestor of this graph path is no longer authorized",
      });
    case "update-required":
      return new GraphPathError({
        reason: "update-required",
        message: "this build cannot read the authorized view of an ancestor",
      });
    case "closed":
      return new GraphPathError({
        reason: "closed",
        message: "an ancestor of this graph path was closed",
      });
    default:
      return undefined;
  }
};

const failureStatus = (error: Error): SyncStatus => {
  if (!(error instanceof GraphPathError)) return "idle";
  switch (error.reason) {
    case "unauthorized":
      return "authentication-required";
    case "update-required":
      return "update-required";
    case "closed":
      return "closed";
    default:
      return "idle";
  }
};

export class GraphDatabaseHandle implements ClientDatabase, GraphAncestor {
  readonly query = { from: clientQueryFrom(this) };
  private mutations: MutationNamespace | undefined;
  private readonly bindingStore = new Store<GraphBinding>(PENDING_BINDING);
  readonly binding = this.bindingStore.subscription;
  private readonly syncStore = new Store<SyncState>(syncState("idle"));
  readonly sync = this.syncStore.subscription;

  private readonly children = new Map<string, GraphDatabaseHandle>();
  private activated = false;
  private closed = false;
  private releaseParent: (() => void) | undefined;
  private releaseResolution: (() => void) | undefined;
  private releaseParentSync: (() => void) | undefined;
  private resolution: QuerySubscription<unknown> | undefined;
  private failureSnapshot: QuerySnapshot<never> | undefined;
  private boundKey: string | undefined;
  private releaseBoundSync: (() => void) | undefined;

  constructor(
    private readonly parent: GraphAncestor,
    private readonly canonical: AnyQueryObject,
    private readonly registry: GraphRegistry,
    private readonly assertLive: (operation: string) => void,
    private readonly mutationContext: MutationContext,
  ) {}

  activateGraph(): void {
    if (this.activated || this.closed) return;
    this.activated = true;
    this.parent.activateGraph();
    this.releaseParent = this.parent.binding.subscribe(() => this.reattach());
    this.reattach();
  }

  boundDatabase(): ClientDatabaseHandle | undefined {
    const binding = this.bindingStore.getSnapshot();
    return binding.status === "bound" ? binding.db : undefined;
  }

  bindingFailure(): Error | undefined {
    const binding = this.bindingStore.getSnapshot();
    return binding.status === "failed" ? binding.error : undefined;
  }

  graphChild(key: string, canonical: AnyQueryObject): GraphDatabaseHandle {
    const existing = this.children.get(key);
    if (existing !== undefined) return existing;
    const child = new GraphDatabaseHandle(
      this,
      canonical,
      this.registry,
      this.assertLive,
      this.mutationContext,
    );
    this.children.set(key, child);
    return child;
  }

  get mutate(): MutationNamespace {
    this.mutations ??= mutationNamespace(
      this.mutationContext,
      this,
      this.mutationContext.databaseOperations(),
    );
    return this.mutations;
  }

  observe<N extends AnyComposer, Row, Out>(
    query: EntityFocused<N, Row, Out>,
  ): QuerySubscription<EntityResult<N, Row, Out>>;
  observe<Row, Out>(query: QueryObject<Row, Out>): QuerySubscription<ClientValue<Out>>;
  observe<Row, Out>(
    query: QueryObject<Row, Out>,
  ): QuerySubscription<ClientValue<Out>> {
    this.assertLive("observe");
    this.activateGraph();
    let inner: QuerySubscription<ClientValue<Out>> | undefined;
    let innerFor: ClientDatabaseHandle | undefined;
    const attached = (): QuerySubscription<ClientValue<Out>> | undefined => {
      const bound = this.boundDatabase();
      if (bound === undefined) {
        inner = undefined;
        innerFor = undefined;
        return undefined;
      }
      if (innerFor !== bound) {
        inner = bound.observe(query);
        innerFor = bound;
      }
      return inner;
    };
    return Object.freeze({
      subscribe: (onChange: () => void) => {
        let releaseInner: (() => void) | undefined;
        const rebind = (): void => {
          releaseInner?.();
          releaseInner = attached()?.subscribe(onChange);
        };
        const releaseBinding = this.bindingStore.subscribe(() => {
          rebind();
          onChange();
        });
        rebind();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          releaseBinding();
          releaseInner?.();
        };
      },
      getSnapshot: (): QuerySnapshot<ClientValue<Out>> => {
        const observation = attached();
        if (observation !== undefined) return observation.getSnapshot();
        return this.unboundSnapshot() as QuerySnapshot<ClientValue<Out>>;
      },
    });
  }

  private unboundSnapshot(): QuerySnapshot<never> {
    const failure = this.bindingFailure();
    if (failure === undefined) return PENDING_SNAPSHOT;
    if (this.failureSnapshot?.error !== failure) {
      this.failureSnapshot = Object.freeze({
        status: "error" as const,
        data: undefined,
        stale: true,
        error: failure,
      });
    }
    return this.failureSnapshot;
  }

  private reattach(): void {
    if (this.closed) return;
    this.releaseResolution?.();
    this.releaseResolution = undefined;
    this.releaseParentSync?.();
    this.releaseParentSync = undefined;
    this.resolution = undefined;
    const failure = this.parent.bindingFailure();
    if (failure !== undefined) {
      this.fail(failure);
      return;
    }
    const parent = this.parent.boundDatabase();
    if (parent === undefined) {
      this.publish(PENDING_BINDING, syncState("connecting"));
      return;
    }
    const resolution = parent.observe(this.canonical);
    this.resolution = resolution;
    this.releaseResolution = resolution.subscribe(() => this.settle(parent));
    this.releaseParentSync = parent.sync.subscribe(() => this.settle(parent));
    this.settle(parent);
  }

  private ancestorFence(
    parent: ClientDatabaseHandle,
  ): GraphPathError | undefined {
    const status = parent.syncStatus();
    if (status === "authentication-required" || status === "closed") {
      return terminalPathError(status);
    }
    return parent.viewWithdrawn() ? terminalPathError(status) : undefined;
  }

  private settle(parent: ClientDatabaseHandle): void {
    if (this.closed) return;
    if (this.parent.boundDatabase() !== parent) return;
    const resolution = this.resolution;
    if (resolution === undefined) return;
    const fenced = this.ancestorFence(parent);
    if (fenced !== undefined) {
      this.fail(fenced);
      return;
    }
    const snapshot = resolution.getSnapshot();
    if (snapshot.status === "error") {
      const error = snapshot.error;
      if (error instanceof NotOne) {
        this.fail(
          error.found === 2
            ? new GraphPathError({
              reason: "ambiguous",
              message: "this graph path matches more than one entity",
            })
            : unavailable(),
        );
        return;
      }
      this.fail(
        new GraphPathError({
          reason: "query",
          message: "this graph path could not be resolved against its parent",
          cause: error,
        }),
      );
      return;
    }
    if (snapshot.status === "pending") {
      this.publish(PENDING_BINDING, syncState(parent.syncStatus()));
      return;
    }
    const segment = resolvedSegment(snapshot.data);
    if (segment === undefined) {
      if (isClientRef(segmentIdentity(snapshot.data))) {
        this.publish(PENDING_BINDING, syncState(parent.syncStatus()));
        return;
      }
      this.fail(unavailable());
      return;
    }
    const scope = parent.confirmedScope();
    if (scope === undefined) {
      this.publish(PENDING_BINDING, syncState(parent.syncStatus()));
      return;
    }
    const stable = graphStableKey(scope, segment.id);
    const handle = this.registry.acquire(
      stable,
      [...parent.graphPath(), segment.name],
      this,
    );
    this.bind(stable, handle);
  }

  private bind(stable: string, handle: ClientDatabaseHandle): void {
    if (this.boundDatabase() === handle) {
      this.syncStore.publish(syncState(handle.syncStatus()));
      return;
    }
    if (this.boundKey !== undefined && this.boundKey !== stable) {
      this.registry.retire(this.boundKey, this);
    }
    this.releaseBoundSync?.();
    this.failureSnapshot = undefined;
    this.boundKey = stable;
    this.bindingStore.publish({ status: "bound", db: handle });
    this.syncStore.publish(syncState(handle.syncStatus()));
    this.releaseBoundSync = handle.sync.subscribe(() => {
      if (this.boundDatabase() === handle) {
        this.syncStore.publish(syncState(handle.syncStatus()));
      }
    });
  }

  private fail(error: Error): void {
    const current = this.bindingStore.getSnapshot();
    if (current.status === "failed" && sameFailure(current.error, error)) return;
    this.publish({ status: "failed", error }, syncState(failureStatus(error)));
  }

  private publish(binding: GraphBinding, status: SyncState): void {
    if (binding.status !== "bound" && this.boundKey !== undefined) {
      const retired = this.boundKey;
      this.boundKey = undefined;
      this.releaseBoundSync?.();
      this.releaseBoundSync = undefined;
      this.registry.retire(retired, this);
    }
    this.bindingStore.publish(binding);
    this.syncStore.publish(status);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseParent?.();
    this.releaseResolution?.();
    this.releaseParentSync?.();
    this.releaseParent = undefined;
    this.releaseResolution = undefined;
    this.releaseParentSync = undefined;
    this.releaseBoundSync?.();
    this.releaseBoundSync = undefined;
    if (this.boundKey !== undefined) {
      this.registry.retire(this.boundKey, this);
      this.boundKey = undefined;
    }
    this.resolution = undefined;
    for (const child of this.children.values()) child.close();
    this.children.clear();
    this.bindingStore.publish({
      status: "failed",
      error: terminalPathError("closed") ?? unavailable(),
    });
    this.syncStore.publish(syncState("closed"));
  }
}

const sameFailure = (left: Error, right: Error): boolean => {
  if (left === right) return true;
  const tag = (error: Error): unknown => (error as { _tag?: unknown })._tag;
  return tag(left) === tag(right) &&
    (left as { reason?: unknown }).reason === (right as { reason?: unknown }).reason;
};

export const resolveGraphReceiver = (
  database: ClientDatabase,
): Promise<ReplicaDatabaseScope> => {
  if (database instanceof ClientDatabaseHandle) return confirmedReceiver(database);
  if (!(database instanceof GraphDatabaseHandle)) {
    return Promise.reject(
      new GraphReceiverError({
        reason: "unresolved",
        message: "this receiver is not a database this client opened",
      }),
    );
  }
  const handle = database;
  handle.activateGraph();
  return settleOn(handle.binding, (resolve, reject) => {
    const failure = handle.bindingFailure();
    if (failure !== undefined) {
      reject(preQueueFailure(failure));
      return true;
    }
    const bound = handle.boundDatabase();
    if (bound === undefined) return false;
    confirmedReceiver(bound).then(resolve, reject);
    return true;
  });
};

const settleOn = <A>(
  source: Subscription<unknown>,
  attempt: (
    resolve: (value: A) => void,
    reject: (error: unknown) => void,
  ) => boolean,
): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    let stop: (() => void) | undefined;
    let done = false;
    const settle = (): void => {
      if (done) return;
      done = attempt(resolve, reject);
      if (done) stop?.();
    };
    settle();
    if (done) return;
    stop = source.subscribe(settle);
    if (done) stop();
  });

const PRE_QUEUE_REASON: Partial<
  Record<GraphPathError["reason"], GraphReceiverError["reason"]>
> = {
  ambiguous: "ambiguous",
  closed: "closed",
  unauthorized: "unauthorized",
  "update-required": "update-required",
};

const preQueueFailure = (error: Error): GraphReceiverError =>
  new GraphReceiverError({
    reason: (error instanceof GraphPathError
      ? PRE_QUEUE_REASON[error.reason]
      : undefined) ?? "unresolved",
    message: "a graph receiver must resolve to one database before queueing",
    cause: error,
  });

export const fencedReceiver = (
  status: SyncStatus,
): GraphReceiverError | undefined => {
  switch (status) {
    case "authentication-required":
      return new GraphReceiverError({
        reason: "unauthorized",
        message: "this database's credential no longer opens it",
      });
    case "update-required":
      return new GraphReceiverError({
        reason: "update-required",
        message: "this build cannot read or replay against this database",
      });
    case "closed":
      return new GraphReceiverError({
        reason: "closed",
        message: "this database was closed before its receiver was known",
      });
    default:
      return undefined;
  }
};

const confirmedReceiver = (
  handle: ClientDatabaseHandle,
): Promise<ReplicaDatabaseScope> => {
  void handle.activate();
  return settleOn(handle.sync, (resolve, reject) => {
    const fenced = fencedReceiver(handle.syncStatus());
    if (fenced !== undefined) {
      reject(fenced);
      return true;
    }
    const identity = handle.confirmedIdentity();
    if (identity === undefined) return false;
    resolve(replicaDatabaseScopeOf(identity));
    return true;
  });
};
