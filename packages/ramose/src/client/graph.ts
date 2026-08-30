/**
 * Graph handles — `.one().db()` and everything it implies.
 *
 * A graph handle is a *path*, not a database. Constructing one is inert: it
 * records its parent handle and the canonical portable query value that names
 * one entity, and performs no query, storage, authorization, or network work.
 *
 * Resolution happens ancestor by ancestor, and only when something is observed:
 * each segment runs against one *complete* local parent `Db`, so no child value
 * is ever derived from a partial parent snapshot. With a complete cached parent
 * replica that is a purely local walk — no server is consulted at any step,
 * which is what makes a nested path readable offline. Without one, descendant
 * queries stay `pending` until the parent has a complete value, or surface the
 * parent's typed terminal error.
 *
 * Two interning disciplines, and they are deliberately different:
 *
 * 1. *Before* resolution, by parent plus canonical query identity — the same
 *    [loweredQuery, shape] identity observations already use. Equivalent paths
 *    written twice during a render are one handle.
 * 2. *After* resolution, by stable graph identity: the parent database's stable
 *    scope plus the sealed `EntityId` of the resolved Graph entity, never the
 *    mutable path text and never a partition-local id. A rename keeps the
 *    identity, and therefore the child replica; so does a benign read-view
 *    rotation, because the sealed handle excludes the read view; a
 *    delete/recreate does not, because the successor seals a different eid. See
 *    {@link graphStableKey}.
 *
 * The stable identity is also what feeds `ReplicationSession.open({
 * graphLineage })`: once a child activation confirms an identity, its
 * server-sealed lineage is remembered against that stable identity, so a later
 * activation of the *same* Graph entity under a *different* path name resumes
 * onto the very same durable replica instead of falling back to the provisional
 * path slot and taking a fresh snapshot. The lineage is never authority —
 * activation still sends the current path names and the server authorizes every
 * segment.
 */

import { COMPOSED_TRAITS, type AnyComposer } from "../db/Composer.ts";
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
import { Store, type Subscription } from "./subscription.ts";
import { syncState, type SyncState, type SyncStatus } from "./sync.ts";

// ── which focuses can become a database ────────────────────────────────────

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
  /**
   * The database this entity is the root of, as one inert unresolved handle.
   *
   * Synchronous, performs no work, and interned: two equivalent paths are one
   * handle, so constructing them during rendering is free and safe.
   */
  readonly db: () => ClientDatabase;
};

/** A `.one()` / `.oneOrFail()` terminal, with `.db()` only where it belongs. */
export type GraphFocus<
  N extends AnyComposer,
  Row,
  Out,
  Term extends "one" | "oneOrFail",
> = ComposesGraph<N> extends true
  ? QueryObject<Row, Out, Term> & GraphFocusDb
  : QueryObject<Row, Out, Term>;

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
  ids(): ClientQuery<N, IdRow<N>>;

  one(): GraphFocus<N, Row, Row | null, "one">;
  oneOrFail(): GraphFocus<N, Row, Row, "oneOrFail">;
}

/** What a graph child needs from whatever database it hangs off. */
export interface GraphAncestor {
  /** Activate this ancestor, and every ancestor above it. */
  readonly activateGraph: () => void;
  /** The resolved database this ancestor currently is, if it has one. */
  readonly boundDatabase: () => ClientDatabaseHandle | undefined;
  /** The terminal failure resolution cannot get past, if there is one. */
  readonly bindingFailure: () => Error | undefined;
  /** Notified whenever either of the two above changes. */
  readonly binding: Subscription<unknown>;
  /** The interned child for one canonical resolution query. */
  readonly graphChild: (
    key: string,
    canonical: AnyQueryObject,
  ) => GraphDatabaseHandle;
}

// ── the fluent wrapper ─────────────────────────────────────────────────────

type AnyFluent = FluentQuery<AnyComposer, unknown, unknown>;

/**
 * The stages that shape *how* matches come back rather than *which* entities
 * match. None of them may reach a resolution.
 */
const CURSOR_STAGES: ReadonlySet<string> = new Set(["orderBy", "limit", "offset"]);

/**
 * The canonical portable query value one path is interned and resolved by.
 *
 * Built from the *logic* of the authored query — its membership and `where`
 * clauses — and nothing else. A projection does not change which entity a path
 * names, and `orderBy` / `limit` / `offset` would resolve a multiple match by
 * arbitrary selection, which the frozen semantics forbid outright: two matches
 * are an ambiguity error, never a pick. So the canonical value drops all of
 * them and asks for exactly one row, which is also what makes two spellings of
 * the same path one interned handle.
 *
 * Dropped from the *pipeline*, not merely left off the chain: `where` accepts
 * arbitrary same-focus stages, so `.where(Query.offset(1))` is a legal way to
 * smuggle a cursor into the logic. `oneOrFail` overrides a stray `limit`, but
 * an `offset` would survive and hand back the *second* of two matches as though
 * it were the only one — silently addressing the wrong child database, and
 * durably so once a mutation is queued against it.
 *
 * It selects the local id and the canonical `:graph/name`: the id is the stable
 * identity the resolved database is interned and cached by, and the name is the
 * current mutable path segment activation sends for the server to authorize.
 */
export const graphResolutionQuery = (
  logic: AnyFluent,
  ns: AnyComposer,
): AnyQueryObject => {
  const shape = { id: ns.id, name: Graph.name };
  // Re-run per build, exactly as every other query body is, so the variables
  // each lowering mints stay hygienic.
  const body = (): Pipeline => {
    const pipe = (logic as unknown as { body: () => Pipeline }).body();
    return selectStage(shape as never)({
      ...pipe,
      stages: pipe.stages.filter((stage) => !CURSOR_STAGES.has(stage.kind)),
    } as never) as unknown as Pipeline;
  };
  return (q(body as never) as AnyQueryObject).oneOrFail();
};

/**
 * The identity a resolved child database is interned, cached, and remembered
 * by: the parent database's *stable scope* plus the sealed `EntityId` of the
 * Graph entity resolved inside it.
 *
 * Both halves are chosen against a specific failure. The scope
 * (`server`/`principal`/`database`) is what survives a read-view rotation, and
 * the sealed handle is the identity that survives one *with* it: it is bound to
 * that same scope and excludes the catalog, the read view, and the schema, so a
 * benign rotation names the same entity with the same string. That is what lets
 * a child keep its resume memo — and therefore its durable replica — across a
 * redeploy that rotates nothing an application can see.
 *
 * A partition-local id could not do that, and keying on one was the trade-off
 * PR #574 accepted while the carriage did not exist: the installer numbers each
 * partition's entities independently, so the key had to include the partition
 * to stay honest, and every rotation then cost a fresh snapshot. It also had to
 * be defended in the other direction — delete a Graph, recreate a same-named
 * one, and the successor could land on the predecessor's local id, producing a
 * byte-identical key and handing the successor the predecessor's replica. The
 * sealed handle closes that by construction rather than by partitioning: it
 * seals the private eid, a recreated entity gets a new eid, and the two handles
 * therefore differ even under one scope.
 */
export const graphStableKey = (
  scope: ReplicaDatabaseScope,
  entity: string,
): string => `${replicaDatabaseKey(scope)} ${entity}`;

/** One resolved segment: which entity, and what it is currently called. */
type ResolvedSegment = { readonly id: number; readonly name: string };

const resolvedSegment = (row: unknown): ResolvedSegment | undefined => {
  if (row === null || typeof row !== "object") return undefined;
  const { id, name } = row as { id?: unknown; name?: unknown };
  const eid = typeof id === "object" && id !== null
    ? (id as { id?: unknown }).id
    : id;
  if (typeof eid !== "number" || typeof name !== "string") return undefined;
  return { id: eid, name };
};

const CHAIN = ["where", "orderBy", "limit", "offset", "ids"] as const;

/**
 * Decorate one fluent value so the chain keeps `.db()` in reach.
 *
 * `logic` is the same chain with only its membership and `where` stages — the
 * canonical value {@link graphResolutionQuery} builds from. It advances with
 * `where` and stands still for everything else, which is exactly the difference
 * between narrowing *which* entity is named and shaping how it is returned.
 */
const decorate = (
  fluent: AnyFluent,
  logic: AnyFluent,
  ns: AnyComposer,
  node: GraphAncestor,
): AnyFluent => {
  const wrapped = { ...fluent } as unknown as Record<string, unknown>;
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
      if (!composesGraph(ns)) return taken;
      // Canonicalized inside `db()`, not here: a `.one()` that never names a
      // database must cost exactly what it costs on any other entity.
      return Object.assign({}, taken, {
        db: (): ClientDatabase => {
          const canonical = graphResolutionQuery(logic, ns);
          return node.graphChild(queryObservationKey(canonical), canonical);
        },
      });
    };
  }
  return wrapped as unknown as AnyFluent;
};

/** `db.query.from` — the portable language, with `.db()` in reach. */
export const clientQueryFrom = (node: GraphAncestor) =>
<N extends AnyComposer>(entity: N): ClientQuery<N> => {
  const base = queryFrom(entity) as unknown as AnyFluent;
  return decorate(base, base, entity, node) as unknown as ClientQuery<N>;
};

// ── the resolved-database registry ─────────────────────────────────────────

/** How the registry builds one activated database for a resolved path. */
export type GraphDatabaseFactory = (input: {
  readonly graphPath: readonly string[];
  /** Read at activation, so a lineage confirmed in between is still used. */
  readonly graphLineage: () => readonly string[] | undefined;
  readonly onConfirmed: (identity: ReplicationIdentity) => void;
}) => ClientDatabaseHandle;

const samePath = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((segment, index) => segment === right[index]);

/**
 * Every resolved child database this client has, interned by stable graph
 * identity — the parent database plus the resolved Graph entity — and never by
 * path text.
 *
 * A rename produces a *new* activation, because the path authorization the old
 * one obtained was for a name that no longer exists and must be obtained again
 * for the new one. It does not produce new storage: the lineage the previous
 * activation confirmed is remembered against the stable identity and handed to
 * the next one, which selects the same durable replica and resumes instead of
 * taking a snapshot.
 */
export class GraphRegistry {
  private readonly databases = new Map<string, {
    readonly path: readonly string[];
    readonly handle: ClientDatabaseHandle;
    /**
     * The paths currently resolved to this database.
     *
     * More than one path can name one database — two queries that select the
     * same Graph entity are two handles and one activation — so a path that
     * stops naming it releases only its own hold. Closing on the first release
     * would take the database out from under the others.
     */
    readonly holders: Set<object>;
  }>();
  /** Stable graph identity → the lineage its activation last confirmed. */
  private readonly lineages = new Map<string, readonly string[]>();

  /**
   * @param membershipChanged Called whenever this registry gains or loses a
   * database. The client's aggregate is over the databases it *has*, and a
   * closing handle publishes only to its own store — so a path that stops
   * resolving would otherwise leave `client.sync` reporting the state of a
   * database that is gone, until some unrelated activation happened to change.
   */
  constructor(
    private readonly factory: GraphDatabaseFactory,
    private readonly membershipChanged: () => void,
  ) {}

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
      void existing.handle.close();
    }
    const handle = this.factory({
      graphPath,
      graphLineage: () => {
        const lineage = this.lineages.get(stable);
        // A lineage that does not describe every segment of *this* path cannot
        // select a slot for it; the session falls back on its own.
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

  /**
   * One path gives up its hold on a stable graph database — a revoked ancestor,
   * a replaced principal, a reset read view, or a path that stopped naming an
   * entity at all. The last hold to go closes the activation; the durable
   * replica survives either way.
   */
  retire(stable: string, holder: object): void {
    const existing = this.databases.get(stable);
    if (existing === undefined) return;
    existing.holders.delete(holder);
    if (existing.holders.size > 0) return;
    this.databases.delete(stable);
    // The lineage goes with the database. A memo that outlives what it
    // describes is unbounded growth at best, and at worst it is a pre-flight
    // selection handed to some later activation that reached this key by a
    // route this one knows nothing about.
    this.lineages.delete(stable);
    void existing.handle.close();
    this.membershipChanged();
  }

  statuses(): readonly SyncStatus[] {
    return [...this.databases.values()].map(({ handle }) => handle.syncStatus());
  }

  async close(): Promise<void> {
    const handles = [...this.databases.values()].map(({ handle }) => handle);
    this.databases.clear();
    this.lineages.clear();
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

// ── the handle ─────────────────────────────────────────────────────────────

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

/** Zero matches and hidden matches are the same opaque answer. */
const unavailable = (): GraphPathError =>
  new GraphPathError({
    reason: "unavailable",
    message: "this graph path does not name a database you can read",
  });

/**
 * An ancestor's own terminal state, restated as the path failure it causes.
 *
 * Pure, and exported for that reason: every branch decides whether a descendant
 * query keeps waiting or stops, so each one is worth stating over ordinary
 * input values. `authentication-required` covers both a revoked ancestor and a
 * replaced principal — the path authorization is invalid either way, however
 * much retained child storage still has the same stable identity.
 */
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

/**
 * What a failed path's own synchronization state is.
 *
 * Never the state it was in before: whatever the resolved database was
 * reporting described a database this path no longer names, and leaving `live`
 * or `offline` standing after a terminal failure would tell an application it
 * is synchronized with something it cannot read.
 *
 * A path that resolves to nothing reports `idle` — the state of a handle with
 * no database to synchronize, and the one status the client aggregate ignores,
 * because asking for a board that does not exist is not a client-wide outage.
 */
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
  /** The stable graph identity this handle currently holds a database for. */
  private boundKey: string | undefined;
  private releaseBoundSync: (() => void) | undefined;

  constructor(
    private readonly parent: GraphAncestor,
    private readonly canonical: AnyQueryObject,
    private readonly registry: GraphRegistry,
    private readonly assertLive: (operation: string) => void,
  ) {}

  // ── ancestor surface ─────────────────────────────────────────────────────

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
    );
    this.children.set(key, child);
    return child;
  }

  // ── public surface ───────────────────────────────────────────────────────

  observe<Row, Out>(query: QueryObject<Row, Out>): QuerySubscription<Out> {
    this.assertLive("observe");
    // Activating is what a descendant observation means: resolve the required
    // ancestors, in order. Nothing before this did any work.
    this.activateGraph();
    let inner: QuerySubscription<Out> | undefined;
    let innerFor: ClientDatabaseHandle | undefined;
    /**
     * Resolved on every use, never captured. The database behind this handle is
     * replaced whenever the path is re-authorized under a new name, so a
     * captured observation would go on answering from an activation that has
     * been closed.
     */
    const attached = (): QuerySubscription<Out> | undefined => {
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
      getSnapshot: (): QuerySnapshot<Out> => {
        const observation = attached();
        if (observation !== undefined) return observation.getSnapshot();
        return this.unboundSnapshot() as QuerySnapshot<Out>;
      },
    });
  }

  /**
   * What a descendant query answers while this path has no database.
   *
   * Pending until an ancestor has one complete value, and the ancestor's own
   * typed terminal error once there is one — never a partial value, and never
   * an answer from an ancestor snapshot that is still filling in.
   */
  private unboundSnapshot(): QuerySnapshot<never> {
    const failure = this.bindingFailure();
    if (failure === undefined) return PENDING_SNAPSHOT;
    // One stable identity per failure, so a consumer polling `getSnapshot()`
    // is not told the value changed on every read.
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

  // ── resolution ───────────────────────────────────────────────────────────

  /** The parent's binding changed: re-observe the canonical query on it. */
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
    // The public observation path: interned, rerun by every committed and
    // optimistic change to the parent, and never a partial value.
    const resolution = parent.observe(this.canonical);
    this.resolution = resolution;
    this.releaseResolution = resolution.subscribe(() => this.settle(parent));
    this.releaseParentSync = parent.sync.subscribe(() => this.settle(parent));
    this.settle(parent);
  }

  /**
   * Whether the parent has withdrawn the authority this path resolves under.
   *
   * Consulted before the resolution snapshot is read, and that order is the
   * whole point. A parent publishes its terminal status *before* the
   * recomputation that resets its observers, so a listener woken by that status
   * change sees a snapshot still holding the rows the withdrawn view produced.
   * Binding from it hands a descendant — and, through the pre-queue gate, a
   * durable invocation — a database the ancestor's authority no longer reaches.
   *
   * `update-required` has two causes and only one of them is the ancestor's: a
   * rotated authorized view withdraws the value, while a build that cannot
   * replay its own optimistic layers still reads a perfectly good committed
   * replica and is no reason to invalidate a path at all.
   */
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
    // A settle that raced a rebinding belongs to a parent this handle no longer
    // hangs off; publishing from it would resolve against a replaced partition.
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
      // `oneOrFail` witnesses a second match without pulling a page, so an
      // ambiguity is distinguishable from an absence — and neither is ever
      // resolved by picking one.
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
      // Not fenced — {@link GraphDatabaseHandle.ancestorFence} already ruled
      // that out — so the parent is merely still filling in, and waiting is the
      // honest answer rather than a verdict.
      this.publish(PENDING_BINDING, syncState(parent.syncStatus()));
      return;
    }
    const segment = resolvedSegment(snapshot.data);
    if (segment === undefined) {
      this.fail(unavailable());
      return;
    }
    const scope = parent.confirmedScope();
    // The opaque identity of the entity this path named, from the parent's own
    // committed binding. Absent for a Graph that exists only in an optimistic
    // layer: the server has not issued a handle for it, so it has no stable
    // database identity yet and waiting is the only honest answer — resolving
    // it would mean addressing a child database by a guess.
    const entity = parent.sealedHandleOf(segment.id);
    if (scope === undefined || entity === undefined) {
      this.publish(PENDING_BINDING, syncState(parent.syncStatus()));
      return;
    }
    const stable = graphStableKey(scope, entity);
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
    // This handle's own status is the resolved database's from here on.
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

  /**
   * Publish one binding, releasing whatever it replaces.
   *
   * Leaving the bound state releases the resolved database as well as unbinding
   * it: an ancestor whose authorization was revoked, whose principal was
   * replaced, or whose read view was reset must not leave this client with a
   * live scope on retained child storage, even though that storage still has
   * the same stable identity.
   */
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

  /** Release this handle and every descendant path hanging off it. */
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
    this.bindingStore.publish(PENDING_BINDING);
    this.syncStore.publish(syncState("closed"));
  }
}

/**
 * Whether two resolution failures say the same thing.
 *
 * A rerun that reaches the same verdict is not a change, and republishing it
 * would tell every descendant observation to look again for nothing.
 */
const sameFailure = (left: Error, right: Error): boolean => {
  if (left === right) return true;
  const tag = (error: Error): unknown => (error as { _tag?: unknown })._tag;
  return tag(left) === tag(right) &&
    (left as { reason?: unknown }).reason === (right as { reason?: unknown }).reason;
};

// ── the mutation pre-queue gate (#477 slice 3 calls this) ──────────────────

/**
 * The receiver of an invocation, or a typed failure *before* anything durable.
 *
 * An invocation against a graph handle may activate resolution, but it cannot
 * become durably `queued` until its receiver is one stable database identity.
 * Slice 3 calls this first and enqueues only what it returns: there is
 * deliberately no path from here to an outbox entry addressed by mutable path
 * text or by a guessed database.
 *
 * Resolution that terminates unavailable or ambiguous fails here, which is what
 * `receipt.queued` reports; nothing was written, so nothing has to be undone.
 *
 * A path that has simply not resolved *yet* — a cold ancestor still filling in —
 * is neither: this waits for it. The deadline belongs to the caller, because
 * only slice 3 knows what an application asked for.
 */
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
  // A mutation may activate graph resolution — it just cannot outrun it.
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

/**
 * Settle a promise the first time `attempt` reaches a verdict, watching one
 * subscription until it does — and unsubscribing exactly once either way.
 */
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
    // The subscription may have been released between the two, so re-check.
    if (done) stop();
  });

/** A resolution failure, restated as the pre-queue failure it causes. */
const preQueueFailure = (error: Error): GraphReceiverError =>
  new GraphReceiverError({
    reason: error instanceof GraphPathError && error.reason === "ambiguous"
      ? "ambiguous"
      : "unresolved",
    message: "a graph receiver must resolve to one database before queueing",
    cause: error,
  });

/**
 * A terminal database state, as the pre-queue failure it causes.
 *
 * Pure, and exported for that reason: each branch decides whether durable work
 * may be addressed to a database, and the cost of getting one wrong is a queued
 * invocation that survives restarts and cannot be safely reattributed.
 */
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

/**
 * Wait for the one stable database identity an outbox entry is addressed by.
 *
 * Offline that is the identity a restored replica already carries; online it is
 * the one the current response confirms. Either way it is an identity an
 * authenticated response produced, never a guess.
 *
 * The fence is checked *before* the identity is accepted, and that order is the
 * whole point. A session that restored a confirmed replica and was then refused
 * keeps its prior identity while it fences the rows — deliberately, so a
 * reconnect can recognize the same partition. Reading that identity here would
 * durably queue work against a database the server has just said this
 * credential does not open, and a queued invocation with its receipts survives
 * restarts and cannot be safely reattributed afterwards.
 */
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
