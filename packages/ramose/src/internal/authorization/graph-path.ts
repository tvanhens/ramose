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
import {
  CatalogId,
  type CatalogUnitHash,
  type DatabaseId,
} from "./identities.ts";
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

export class GraphPathSegmentInaccessible extends Data.TaggedError(
  "GraphPathSegmentInaccessible",
)<{
  readonly parentDatabase: DatabaseId;
  readonly index: number;
  readonly segment: string;
}> {}

export class GraphPathSegmentWrongKind extends Data.TaggedError(
  "GraphPathSegmentWrongKind",
)<{
  readonly parentDatabase: DatabaseId;
  readonly index: number;
  readonly segment: string;
  readonly graphEntity: number;
}> {}

export class GraphPathCatalogUnavailable extends Data.TaggedError(
  "GraphPathCatalogUnavailable",
)<{
  readonly parentDatabase: DatabaseId;
  readonly index: number;
  readonly graphEntity: number;
}> {}

export class GraphPathAuthorizationFailed extends Data.TaggedError(
  "GraphPathAuthorizationFailed",
)<{
  readonly database: DatabaseId;
  readonly index: number;
}> {}

export class GraphPathDatabaseUnavailable extends Data.TaggedError(
  "GraphPathDatabaseUnavailable",
)<{
  readonly database: DatabaseId;
  readonly index: number;
  readonly cause: unknown;
}> {}

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

export const opaqueGraphPathDenial = (
  _error: GraphPathFailure,
): Unauthorized => new Unauthorized({ status: 403 });

export type AuthorizedGraphPathInput<R = never, EDb = unknown, EProvision = unknown> = {
  readonly bindings: DatabaseCatalogBindings;
  readonly root: ResolvedDatabaseRoute;
  readonly path: readonly string[];
  readonly currentDb: (database: DatabaseId) => Effect.Effect<Db, EDb, R>;
  readonly provision: (
    route: ResolvedDatabaseRoute,
    derivation: DatabaseRouteDerivation,
  ) => Effect.Effect<void, EProvision, R>;
  readonly view?: AuthorizedRequestView;
};

export type GraphPathLeaseDependency = {
  readonly parentDatabase: DatabaseId;
  readonly graphEntity: number;
};

export type GraphPathLeaseRouteIdentity = {
  readonly database: DatabaseId;
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
};

export type GraphPathLeaseIdentity = {
  readonly rootDatabase: DatabaseId;
  readonly path: readonly string[];
  readonly routes: readonly GraphPathLeaseRouteIdentity[];
  readonly dependencies: readonly GraphPathLeaseDependency[];
};

export type AuthorizedGraphPathTarget = {
  readonly route: ResolvedDatabaseRoute;
  readonly derivation: DatabaseRouteDerivation;
  readonly context: AuthorizedRequestContext;
  readonly routes: readonly ResolvedDatabaseRoute[];
  readonly dependencies: readonly GraphPathLeaseDependency[];
};

export const graphPathLeaseIdentity = (
  target: AuthorizedGraphPathTarget,
  path: readonly string[],
): GraphPathLeaseIdentity => Object.freeze({
  rootDatabase: target.derivation.rootDatabase,
  path: Object.freeze([...path]),
  routes: Object.freeze(target.routes.map((route) => Object.freeze({
    database: route.database,
    catalogKey: route.deployed.catalogKey,
    unitHash: route.deployed.unitHash,
  }))),
  dependencies: Object.freeze(target.dependencies.map((dependency) =>
    Object.freeze({ ...dependency })
  )),
});

export const sameGraphPathLeaseIdentity = (
  left: GraphPathLeaseIdentity,
  right: GraphPathLeaseIdentity,
): boolean =>
  left.rootDatabase === right.rootDatabase &&
  left.path.length === right.path.length &&
  left.path.every((segment, index) => segment === right.path[index]) &&
  left.routes.length === right.routes.length &&
  left.routes.every((route, index) => {
    const other = right.routes[index];
    return other !== undefined &&
      route.database === other.database &&
      route.catalogKey === other.catalogKey &&
      route.unitHash === other.unitHash;
  }) &&
  left.dependencies.length === right.dependencies.length &&
  left.dependencies.every((dependency, index) => {
    const other = right.dependencies[index];
    return other !== undefined &&
      dependency.parentDatabase === other.parentDatabase &&
      dependency.graphEntity === other.graphEntity;
  });

export const graphPathLeaseDependsOn = (
  identity: GraphPathLeaseIdentity,
  dependency: GraphPathLeaseDependency,
): boolean => identity.dependencies.some((candidate) =>
  candidate.parentDatabase === dependency.parentDatabase &&
  candidate.graphEntity === dependency.graphEntity
);

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

export const resolveAuthorizedGraphPath = Effect.fn(
  "Authorization.resolveAuthorizedGraphPath",
)(function* <R, EDb, EProvision>(
  input: AuthorizedGraphPathInput<R, EDb, EProvision>,
  caller: AuthenticatedCaller,
): Effect.fn.Return<AuthorizedGraphPathTarget, GraphPathFailure, R> {
  const path = yield* Effect.fromResult(validatePath(input.path));
  const graphs: DynamicGraphBinding[] = [];
  const routes: ResolvedDatabaseRoute[] = [input.root];
  const dependencies: GraphPathLeaseDependency[] = [];
  let route = input.root;
  let context!: AuthorizedRequestContext;

  yield* input.provision(
    input.root,
    Object.freeze({
      rootDatabase: input.root.database,
      graphs: Object.freeze([]),
    }),
  ).pipe(
    Effect.mapError((cause) =>
      new GraphPathProvisioningFailed({
        database: input.root.database,
        index: 0,
        cause,
      })
    ),
  );

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
    dependencies.push(Object.freeze({
      parentDatabase: route.database,
      graphEntity: graph.graphEntity,
    }));
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
    routes.push(child);
  }

  return Object.freeze({
    route,
    derivation: Object.freeze({
      rootDatabase: input.root.database,
      graphs: Object.freeze([...graphs]),
    }),
    context,
    routes: Object.freeze([...routes]),
    dependencies: Object.freeze([...dependencies]),
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
