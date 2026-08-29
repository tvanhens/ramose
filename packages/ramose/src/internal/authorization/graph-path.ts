/**
 * Authenticated hierarchical Graph routing.
 *
 * Every segment is found through that database's ordinary filtered current
 * Db. Only after the row, protected concrete type, and path-name field are
 * visible does routing read the engine-owned catalog key from the exact
 * authorized entity and derive the sealed child route. Physical provisioning
 * is a narrow framework callback invoked after that authorization decision;
 * it is never part of an operation context.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Unauthorized } from "../../db/Errors.ts";
import { MAX_COLLECTION_SIZE, MAX_STRING_LENGTH } from "./bounds.ts";
import {
  type DatabaseCatalogBindings,
  type DatabaseRouteDerivation,
  type DynamicDatabaseBindingFailure,
  type DynamicGraphBinding,
  type ResolvedDatabaseRoute,
} from "./database-bindings.ts";
import { CatalogId, type DatabaseId } from "./identities.ts";
import {
  constructAuthorizedResolvedRequestContext,
  executeWithinAuthorizedLease,
  type AuthenticatedCaller,
  type AuthorizedRequestContext,
  type AuthorizedRequestView,
} from "./request.ts";
import type { InstalledCatalogDefinition } from "./definitions.ts";
import { Index, ValueTag } from "../core/datom.ts";
import type { Db } from "../core/db.ts";
import { RAMOSE_TYPE_IDENT } from "../core/schema.ts";

const GRAPH_TRAIT_IDENT = ":graph";
const GRAPH_NAME_IDENT = ":graph/name";
const GRAPH_CATALOG_IDENT = ":graph/catalog";

export class InvalidGraphPath extends Data.TaggedError("InvalidGraphPath")<{
  readonly index: number;
  readonly reason: string;
}> {}

/** Missing and filtered-away rows deliberately share this internal shape. */
export class GraphPathSegmentInaccessible extends Data.TaggedError(
  "GraphPathSegmentInaccessible",
)<{
  readonly parentDatabase: DatabaseId;
  readonly index: number;
  readonly segment: string;
}> {}

/** A visible row carrying the path-name field does not implement Graph. */
export class GraphPathSegmentWrongKind extends Data.TaggedError(
  "GraphPathSegmentWrongKind",
)<{
  readonly parentDatabase: DatabaseId;
  readonly index: number;
  readonly segment: string;
  readonly graphEntity: number;
}> {}

/** The exact authorized Graph row lacks one valid protected catalog key. */
export class GraphPathCatalogUnavailable extends Data.TaggedError(
  "GraphPathCatalogUnavailable",
)<{
  readonly parentDatabase: DatabaseId;
  readonly index: number;
  readonly graphEntity: number;
}> {}

/** The database's deployed policy could not construct its filtered value. */
export class GraphPathAuthorizationFailed extends Data.TaggedError(
  "GraphPathAuthorizationFailed",
)<{
  readonly database: DatabaseId;
  readonly index: number;
}> {}

/** A real database acquisition or lookup failed while resolving the path. */
export class GraphPathDatabaseUnavailable extends Data.TaggedError(
  "GraphPathDatabaseUnavailable",
)<{
  readonly database: DatabaseId;
  readonly index: number;
  readonly cause: unknown;
}> {}

/** Authorized child storage could not be provisioned idempotently. */
export class GraphPathProvisioningFailed extends Data.TaggedError(
  "GraphPathProvisioningFailed",
)<{
  readonly database: DatabaseId;
  readonly index: number;
  readonly cause: unknown;
}> {}

export type GraphPathFailure =
  | InvalidGraphPath
  | GraphPathSegmentInaccessible
  | GraphPathSegmentWrongKind
  | GraphPathCatalogUnavailable
  | GraphPathAuthorizationFailed
  | GraphPathDatabaseUnavailable
  | GraphPathProvisioningFailed
  | DynamicDatabaseBindingFailure;

/** Every authenticated path failure has the same caller-visible result. */
export const opaqueGraphPathDenial = (
  _error: GraphPathFailure,
): Unauthorized => new Unauthorized({ status: 403 });

export type AuthorizedGraphPathInput<R = never, EDb = unknown, EProvision = unknown> = {
  readonly bindings: DatabaseCatalogBindings;
  /** Configured, opaque root route selected by server routing. */
  readonly root: ResolvedDatabaseRoute;
  /** Caller-visible mutable Graph names, relative to the configured root. */
  readonly path: readonly string[];
  readonly currentDb: (database: DatabaseId) => Effect.Effect<Db, EDb, R>;
  /** Idempotently ensure the already-authorized child route has storage. */
  readonly provision: (
    route: ResolvedDatabaseRoute,
    derivation: DatabaseRouteDerivation,
  ) => Effect.Effect<void, EProvision, R>;
  /** Applies only to the target database; every path segment is current. */
  readonly view?: AuthorizedRequestView;
};

export type AuthorizedGraphPathTarget = {
  readonly route: ResolvedDatabaseRoute;
  readonly derivation: DatabaseRouteDerivation;
  readonly context: AuthorizedRequestContext;
};

export type CatalogProvisioningAttribute = {
  readonly ":db/ident": string;
  readonly ":db/valueType": string;
  readonly ":db/cardinality": string;
  readonly ":db/unique"?: string;
  readonly ":db/index"?: true;
  readonly ":db/isComponent"?: true;
  readonly ":db/optional"?: true;
  readonly ":db/doc"?: string;
};

/**
 * Definition-directed schema facts for a fresh dynamic database. This is
 * framework provisioning data, not database-resident catalog authority: the
 * installed unit, policy, operations, hashes, and binding remain in code.
 */
export const catalogProvisioningAttributes = (
  definition: InstalledCatalogDefinition,
): readonly CatalogProvisioningAttribute[] =>
  Object.freeze(definition.unit.catalog.fields.map((field) => {
    const attribute: CatalogProvisioningAttribute = {
      ":db/ident": `:${field.id.owner.name}/${field.id.localName}`,
      ":db/valueType": `:db.type/${field.valueType}`,
      ":db/cardinality": `:db.cardinality/${field.cardinality}`,
      ...(field.unique === undefined
        ? {}
        : {
          ":db/unique": field.unique === "upsert"
            ? ":db.unique/identity"
            : ":db.unique/value",
        }),
      ...(field.index ? { ":db/index": true as const } : {}),
      ...(field.owned ? { ":db/isComponent": true as const } : {}),
      ...(field.optional && field.cardinality === "one"
        ? { ":db/optional": true as const }
        : {}),
      ...(field.doc === undefined ? {} : { ":db/doc": field.doc }),
    };
    return Object.freeze(attribute);
  }));

const validatePath = (
  path: readonly string[],
): Result.Result<readonly string[], InvalidGraphPath> => {
  if (!Array.isArray(path) || path.length > MAX_COLLECTION_SIZE) {
    return Result.fail(new InvalidGraphPath({
      index: -1,
      reason: "graph path exceeds the collection bound",
    }));
  }
  for (let index = 0; index < path.length; index++) {
    const segment = path[index];
    if (
      typeof segment !== "string" ||
      segment.length === 0 ||
      segment.length > MAX_STRING_LENGTH
    ) {
      return Result.fail(new InvalidGraphPath({
        index,
        reason: "graph path segments must be bounded non-empty strings",
      }));
    }
  }
  return Result.succeed(Object.freeze([...path]));
};

const authorizeRoute = <R, EDb, EProvision>(
  input: AuthorizedGraphPathInput<R, EDb, EProvision>,
  caller: AuthenticatedCaller,
  route: ResolvedDatabaseRoute,
  index: number,
  view: AuthorizedRequestView | undefined,
): Effect.Effect<
  AuthorizedRequestContext,
  GraphPathAuthorizationFailed | GraphPathDatabaseUnavailable,
  R
> =>
  constructAuthorizedResolvedRequestContext({
    authenticate: Effect.succeed(caller),
    bindings: input.bindings,
    route,
    currentDb: input.currentDb,
    ...(view === undefined ? {} : { view }),
  }, caller).pipe(
    Effect.mapError((error) =>
      error instanceof Unauthorized
        ? new GraphPathAuthorizationFailed({ database: route.database, index })
        : new GraphPathDatabaseUnavailable({
          database: route.database,
          index,
          cause: error,
        })
    ),
  );

const lookupAuthorizedGraph = Effect.fn(
  "Authorization.lookupAuthorizedGraphPathSegment",
)(function* (
  context: AuthorizedRequestContext,
  parent: ResolvedDatabaseRoute,
  segment: string,
  index: number,
): Effect.fn.Return<
  DynamicGraphBinding,
  | GraphPathSegmentInaccessible
  | GraphPathSegmentWrongKind
  | GraphPathCatalogUnavailable
  | GraphPathDatabaseUnavailable
> {
  const inaccessible = () => new GraphPathSegmentInaccessible({
    parentDatabase: parent.database,
    index,
    segment,
  });
  const graphEntity = yield* Effect.tryPromise({
    try: () => context.filteredDb.entid([GRAPH_NAME_IDENT, segment]),
    catch: (cause) => new GraphPathDatabaseUnavailable({
      database: parent.database,
      index,
      cause,
    }),
  });
  if (graphEntity === undefined) return yield* inaccessible();

  const row = yield* Effect.tryPromise({
    try: () => context.filteredDb.entity(graphEntity),
    catch: (cause) => new GraphPathDatabaseUnavailable({
      database: parent.database,
      index,
      cause,
    }),
  });
  if (
    row === undefined ||
    row[GRAPH_NAME_IDENT] !== segment ||
    typeof row[RAMOSE_TYPE_IDENT] !== "string"
  ) {
    return yield* inaccessible();
  }
  const concreteType = row[RAMOSE_TYPE_IDENT];
  if (
    context.filteredDb.composition === undefined ||
    !context.filteredDb.composition.isEntityIdent(concreteType) ||
    !context.filteredDb.composition.transitiveTraits(concreteType).includes(
      GRAPH_TRAIT_IDENT,
    )
  ) {
    return yield* new GraphPathSegmentWrongKind({
      parentDatabase: parent.database,
      index,
      segment,
      graphEntity,
    });
  }

  const catalogAttribute = context.currentDb.attr(GRAPH_CATALOG_IDENT);
  if (catalogAttribute === undefined) {
    return yield* new GraphPathCatalogUnavailable({
      parentDatabase: parent.database,
      index,
      graphEntity,
    });
  }
  const catalogDatoms = yield* Effect.tryPromise({
    try: () => context.currentDb.datomsArray(Index.EAVT, {
      e: graphEntity,
      a: catalogAttribute.id,
    }),
    catch: (cause) => new GraphPathDatabaseUnavailable({
      database: parent.database,
      index,
      cause,
    }),
  });
  if (
    catalogDatoms.length !== 1 ||
    catalogDatoms[0]!.vt !== ValueTag.Str ||
    typeof catalogDatoms[0]!.v !== "string" ||
    catalogDatoms[0]!.v.length === 0
  ) {
    return yield* new GraphPathCatalogUnavailable({
      parentDatabase: parent.database,
      index,
      graphEntity,
    });
  }
  return Object.freeze({
    graphEntity,
    catalogKey: CatalogId.make(catalogDatoms[0]!.v),
  });
});

/**
 * Resolve one authenticated path and retain rich failures for framework logs.
 * Callers should normally use {@link executeAuthorizedGraphPath}, which
 * collapses these details before an external response.
 */
export const resolveAuthorizedGraphPath = Effect.fn(
  "Authorization.resolveAuthorizedGraphPath",
)(function* <R, EDb, EProvision>(
  input: AuthorizedGraphPathInput<R, EDb, EProvision>,
  caller: AuthenticatedCaller,
): Effect.fn.Return<AuthorizedGraphPathTarget, GraphPathFailure, R> {
  const path = yield* Effect.fromResult(validatePath(input.path));
  const graphs: DynamicGraphBinding[] = [];
  let route = input.root;
  let context!: AuthorizedRequestContext;

  for (let index = 0; index <= path.length; index++) {
    context = yield* authorizeRoute(
      input,
      caller,
      route,
      index,
      index === path.length ? input.view : undefined,
    );
    if (index === path.length) break;

    const graph = yield* lookupAuthorizedGraph(
      context,
      route,
      path[index]!,
      index,
    );
    const child = yield* input.bindings.child(route, graph);
    const childDerivation: DatabaseRouteDerivation = Object.freeze({
      rootDatabase: input.root.database,
      graphs: Object.freeze([...graphs, graph]),
    });
    yield* input.provision(child, childDerivation).pipe(
      Effect.mapError((cause) => new GraphPathProvisioningFailed({
        database: child.database,
        index,
        cause,
      })),
    );
    graphs.push(graph);
    route = child;
  }

  return Object.freeze({
    route,
    derivation: Object.freeze({
      rootDatabase: input.root.database,
      graphs: Object.freeze([...graphs]),
    }),
    context,
  });
});

export type ExecuteAuthorizedGraphPathInput<
  R = never,
  EDb = unknown,
  EProvision = unknown,
> = AuthorizedGraphPathInput<R, EDb, EProvision> & {
  readonly authenticate: Effect.Effect<AuthenticatedCaller, Unauthorized, R>;
  readonly interruptAfter?: import("effect/Duration").Input;
};

/** Authenticate once and retain the sealed target for framework routing. */
export const executeAuthorizedGraphPathTarget = Effect.fn(
  "Authorization.executeAuthorizedGraphPathTarget",
)(function* <A, E, R, EDb = unknown, EProvision = unknown>(
  input: ExecuteAuthorizedGraphPathInput<R, EDb, EProvision>,
  execute: (target: AuthorizedGraphPathTarget) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, Unauthorized | E, R> {
  return yield* executeWithinAuthorizedLease(input, (caller) =>
    resolveAuthorizedGraphPath(input, caller).pipe(
      Effect.mapError(opaqueGraphPathDenial),
      Effect.flatMap(execute),
    )
  );
});

/** Authenticate once, resolve every boundary, then expose only target data. */
export const executeAuthorizedGraphPath = Effect.fn(
  "Authorization.executeAuthorizedGraphPath",
)(function* <A, E, R, EDb = unknown, EProvision = unknown>(
  input: ExecuteAuthorizedGraphPathInput<R, EDb, EProvision>,
  execute: (filteredDb: Db) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, Unauthorized | E, R> {
  return yield* executeAuthorizedGraphPathTarget(
    input,
    (target) => execute(target.context.filteredDb),
  );
});
