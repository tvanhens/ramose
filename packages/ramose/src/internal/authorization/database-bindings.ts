import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Unauthorized } from "../../db/Errors.ts";
import type {
  CatalogDefinitions,
  DeployedCatalogDefinition,
  DeployedCatalogDefinitions,
  InstalledCatalogDefinition,
} from "./definitions.ts";
import { hashDomainSeparatedCanonicalJson } from "./decode.ts";
import { CatalogMismatch, InvalidIR } from "./failures.ts";
import type { CatalogId, CatalogUnitHash, DatabaseId } from "./identities.ts";
import { DatabaseId as DatabaseIdSchema } from "./identities.ts";
import type { DeployedCatalog } from "./deployed.ts";

const CHILD_DATABASE_ID_HASH_DOMAIN_V1 =
  "ramose/dynamic-child-database/v1\0";

const ResolvedDatabaseRouteTypeId: unique symbol = Symbol(
  "ramose/internal/ResolvedDatabaseRoute",
);

const DatabaseCatalogBindingsTypeId: unique symbol = Symbol(
  "ramose/internal/DatabaseCatalogBindings",
);

export interface ResolvedDatabaseRoute {
  readonly [ResolvedDatabaseRouteTypeId]: typeof ResolvedDatabaseRouteTypeId;
  readonly database: DatabaseId;
  readonly deployed: DeployedCatalog;
}

export type DynamicGraphBinding = {
  readonly graphEntity: number;
  readonly catalogKey: CatalogId;
};

export type DatabaseRouteDerivation = {
  readonly rootDatabase: DatabaseId;
  readonly graphs: readonly DynamicGraphBinding[];
};

export class DynamicCatalogDefinitionMissing extends Data.TaggedError(
  "DynamicCatalogDefinitionMissing",
)<{
  readonly parentDatabase: DatabaseId;
  readonly graphEntity: number;
  readonly catalogKey: CatalogId;
}> {}

export class DatabaseCatalogBindingConflict extends Data.TaggedError(
  "DatabaseCatalogBindingConflict",
)<{
  readonly database: DatabaseId;
  readonly expectedCatalogKey: CatalogId;
  readonly expectedUnitHash: CatalogUnitHash;
  readonly actualCatalogKey: CatalogId;
  readonly actualUnitHash: CatalogUnitHash;
}> {}

export class InvalidResolvedDatabaseRoute extends Data.TaggedError(
  "InvalidResolvedDatabaseRoute",
)<{ readonly message: string }> {}

export class InvalidDynamicGraphIdentity extends Data.TaggedError(
  "InvalidDynamicGraphIdentity",
)<{ readonly graphEntity: number }> {}

export type DynamicDatabaseBindingFailure =
  | DynamicCatalogDefinitionMissing
  | DatabaseCatalogBindingConflict
  | InvalidResolvedDatabaseRoute
  | InvalidDynamicGraphIdentity
  | InvalidIR;

export const opaqueDatabaseBindingDenial = (
  _error: DynamicDatabaseBindingFailure | CatalogMismatch,
): Unauthorized => new Unauthorized({});

export interface DatabaseCatalogBindings {
  readonly [DatabaseCatalogBindingsTypeId]: typeof DatabaseCatalogBindingsTypeId;
  readonly root: (
    database: DatabaseId,
  ) => Result.Result<ResolvedDatabaseRoute, CatalogMismatch>;
  readonly child: (
    parent: ResolvedDatabaseRoute,
    graph: DynamicGraphBinding,
  ) => Effect.Effect<ResolvedDatabaseRoute, DynamicDatabaseBindingFailure>;
}

type RootSource = { readonly _tag: "root" };
type GraphSource = {
  readonly _tag: "graph";
  readonly parentDatabase: DatabaseId;
  readonly graphEntity: number;
};
type BindingSource = RootSource | GraphSource;

type BoundRoute = {
  readonly route: ResolvedDatabaseRoute;
  readonly definition: InstalledCatalogDefinition;
  readonly source: BindingSource;
};

type BindingState = {
  readonly owner: object;
  readonly byDatabase: Map<DatabaseId, BoundRoute>;
};

type RouteState = BoundRoute & { readonly owner: object };

const bindingStates = new WeakMap<DatabaseCatalogBindings, BindingState>();
const routeStates = new WeakMap<ResolvedDatabaseRoute, RouteState>();

const compareBinding = (
  existing: BoundRoute,
  source: GraphSource,
  definition: InstalledCatalogDefinition,
): boolean =>
  existing.source._tag === "graph" &&
  existing.source.parentDatabase === source.parentDatabase &&
  existing.source.graphEntity === source.graphEntity &&
  existing.definition.catalogKey === definition.catalogKey &&
  existing.definition.unitHash === definition.unitHash;

const deployedCatalog = (
  database: DatabaseId,
  definition: InstalledCatalogDefinition,
): DeployedCatalog => Object.freeze({
  database,
  catalogKey: definition.catalogKey,
  unitHash: definition.unitHash,
  unit: definition.unit,
  composition: definition.composition,
});

const makeRoute = (
  owner: object,
  database: DatabaseId,
  definition: InstalledCatalogDefinition,
  source: BindingSource,
): BoundRoute => {
  const route: ResolvedDatabaseRoute = Object.freeze({
    [ResolvedDatabaseRouteTypeId]:
      ResolvedDatabaseRouteTypeId as typeof ResolvedDatabaseRouteTypeId,
    database,
    deployed: deployedCatalog(database, definition),
  });
  const bound = Object.freeze({ route, definition, source });
  routeStates.set(route, { ...bound, owner });
  return bound;
};

const stateOf = (
  bindings: DatabaseCatalogBindings,
): Result.Result<BindingState, InvalidResolvedDatabaseRoute> => {
  const state = bindingStates.get(bindings);
  return state === undefined
    ? Result.fail(new InvalidResolvedDatabaseRoute({
      message: "database catalog bindings were not created by deployDatabaseCatalogBindings",
    }))
    : Result.succeed(state);
};

const boundRoute = (
  bindings: DatabaseCatalogBindings,
  route: ResolvedDatabaseRoute,
): Result.Result<BoundRoute, InvalidResolvedDatabaseRoute> =>
  Result.gen(function* () {
    const state = yield* stateOf(bindings);
    const routed = routeStates.get(route);
    if (
      routed === undefined ||
      routed.owner !== state.owner ||
      state.byDatabase.get(route.database)?.route !== route ||
      route.deployed.database !== route.database ||
      route.deployed.catalogKey !== routed.definition.catalogKey ||
      route.deployed.unitHash !== routed.definition.unitHash
    ) {
      return yield* Result.fail(new InvalidResolvedDatabaseRoute({
        message: "resolved database route is forged, stale, or belongs to another deployment",
      }));
    }
    return routed;
  });

export const deriveDynamicChildDatabaseId = Effect.fn(
  "Authorization.deriveDynamicChildDatabaseId",
)(function* (
  parentDatabase: DatabaseId,
  graphEntity: number,
): Effect.fn.Return<DatabaseId, InvalidDynamicGraphIdentity | InvalidIR> {
  if (
    !Number.isSafeInteger(graphEntity) ||
    graphEntity < 0
  ) {
    return yield* new InvalidDynamicGraphIdentity({ graphEntity });
  }
  const digest = yield* hashDomainSeparatedCanonicalJson(
    CHILD_DATABASE_ID_HASH_DOMAIN_V1,
    [parentDatabase, graphEntity],
  );
  return DatabaseIdSchema.make(digest);
});

export const deployDatabaseCatalogBindings = (
  definitions: CatalogDefinitions,
  roots: DeployedCatalogDefinitions,
): Result.Result<DatabaseCatalogBindings, CatalogMismatch | InvalidIR> =>
  Result.gen(function* () {
    const owner = Object.freeze({});
    const byDatabase = new Map<DatabaseId, BoundRoute>();

    for (const database of roots.databases()) {
      const root = yield* roots.requireDatabase(database);
      const canonical = yield* definitions.require(root.definition.catalogKey);
      const read = yield* roots.catalogs.requireDatabase(database);
      if (
        canonical !== root.definition ||
        read.catalogKey !== canonical.catalogKey ||
        read.unitHash !== canonical.unitHash
      ) {
        return yield* Result.fail(new InvalidIR({
          message: `configured database '${database}' does not match its immutable catalog definition`,
        }));
      }
      byDatabase.set(
        database,
        makeRoute(owner, database, canonical, Object.freeze({ _tag: "root" })),
      );
    }

    let bindings!: DatabaseCatalogBindings;
    bindings = Object.freeze({
      [DatabaseCatalogBindingsTypeId]:
        DatabaseCatalogBindingsTypeId as typeof DatabaseCatalogBindingsTypeId,
      root: (database: DatabaseId) => {
        const found = byDatabase.get(database);
        return found?.source._tag === "root"
          ? Result.succeed(found.route)
          : Result.fail(new CatalogMismatch({
            message: "catalog mismatch",
            expectedDatabase: database,
          }));
      },
      child: Effect.fn("Authorization.resolveDynamicGraphChild")(function* (
        parent: ResolvedDatabaseRoute,
        graph: DynamicGraphBinding,
      ) {
        const parentBound = yield* Effect.fromResult(boundRoute(bindings, parent));
        const database = yield* deriveDynamicChildDatabaseId(
          parentBound.route.database,
          graph.graphEntity,
        );
        const definitionResult = definitions.require(graph.catalogKey);
        if (Result.isFailure(definitionResult)) {
          return yield* new DynamicCatalogDefinitionMissing({
            parentDatabase: parentBound.route.database,
            graphEntity: graph.graphEntity,
            catalogKey: graph.catalogKey,
          });
        }
        const definition = definitionResult.success;
        const source: GraphSource = Object.freeze({
          _tag: "graph",
          parentDatabase: parentBound.route.database,
          graphEntity: graph.graphEntity,
        });
        const existing = byDatabase.get(database);
        if (existing !== undefined) {
          if (compareBinding(existing, source, definition)) return existing.route;
          return yield* new DatabaseCatalogBindingConflict({
            database,
            expectedCatalogKey: existing.definition.catalogKey,
            expectedUnitHash: existing.definition.unitHash,
            actualCatalogKey: definition.catalogKey,
            actualUnitHash: definition.unitHash,
          });
        }
        const child = makeRoute(owner, database, definition, source);
        byDatabase.set(database, child);
        return child.route;
      }),
    });
    bindingStates.set(bindings, { owner, byDatabase });
    return bindings;
  });

export const resolveBoundCatalogDefinition = (
  bindings: DatabaseCatalogBindings,
  route: ResolvedDatabaseRoute,
): Result.Result<DeployedCatalogDefinition, InvalidResolvedDatabaseRoute> =>
  Result.map(boundRoute(bindings, route), (bound) => Object.freeze({
    database: route.database,
    definition: bound.definition,
  }));

export const acquireResolvedDatabase = <A, E, R>(
  bindings: DatabaseCatalogBindings,
  route: ResolvedDatabaseRoute,
  acquire: (database: DatabaseId) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | InvalidResolvedDatabaseRoute, R> =>
  Effect.gen(function* () {
    yield* Effect.fromResult(boundRoute(bindings, route));
    return yield* acquire(route.database);
  });

export const deriveResolvedDatabaseRoute = Effect.fn(
  "Authorization.deriveResolvedDatabaseRoute",
)(function* (
  bindings: DatabaseCatalogBindings,
  derivation: DatabaseRouteDerivation,
) {
  let route = yield* Effect.fromResult(
    bindings.root(derivation.rootDatabase),
  );
  for (const graph of derivation.graphs) {
    route = yield* bindings.child(route, graph);
  }
  return route;
});
