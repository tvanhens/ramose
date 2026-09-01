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
import { CatalogMismatch, InvalidIR } from "./failures.ts";
import type { CatalogUnitHash, CatalogId, DatabaseId } from "./identities.ts";
import type { DeployedCatalog } from "./deployed.ts";

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

export type DatabaseRouteDerivation = { readonly rootDatabase: DatabaseId };

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

export type DatabaseBindingFailure =
  | DatabaseCatalogBindingConflict
  | InvalidResolvedDatabaseRoute
  | InvalidIR;

export interface DatabaseCatalogBindings {
  readonly [DatabaseCatalogBindingsTypeId]: typeof DatabaseCatalogBindingsTypeId;
  readonly root: (
    database: DatabaseId,
  ) => Result.Result<ResolvedDatabaseRoute, CatalogMismatch>;
}

export const unavailableDatabaseCatalogBindings = (
  fail: () => never,
): DatabaseCatalogBindings => Object.freeze({
  [DatabaseCatalogBindingsTypeId]:
    DatabaseCatalogBindingsTypeId as typeof DatabaseCatalogBindingsTypeId,
  root: fail,
});

export const opaqueDatabaseBindingDenial = (
  _error: DatabaseBindingFailure | CatalogMismatch,
): Unauthorized => new Unauthorized({});

type BoundRoute = {
  readonly route: ResolvedDatabaseRoute;
  readonly definition: InstalledCatalogDefinition;
};
type BindingState = {
  readonly owner: object;
  readonly byDatabase: Map<DatabaseId, BoundRoute>;
};
type RouteState = BoundRoute & { readonly owner: object };

const bindingStates = new WeakMap<DatabaseCatalogBindings, BindingState>();
const routeStates = new WeakMap<ResolvedDatabaseRoute, RouteState>();

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
): BoundRoute => {
  const route: ResolvedDatabaseRoute = Object.freeze({
    [ResolvedDatabaseRouteTypeId]:
      ResolvedDatabaseRouteTypeId as typeof ResolvedDatabaseRouteTypeId,
    database,
    deployed: deployedCatalog(database, definition),
  });
  const bound = Object.freeze({ route, definition });
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
      byDatabase.set(database, makeRoute(owner, database, canonical));
    }
    const bindings: DatabaseCatalogBindings = Object.freeze({
      [DatabaseCatalogBindingsTypeId]:
        DatabaseCatalogBindingsTypeId as typeof DatabaseCatalogBindingsTypeId,
      root: (database: DatabaseId) => {
        const found = byDatabase.get(database);
        return found === undefined
          ? Result.fail(new CatalogMismatch({
            message: "catalog mismatch",
            expectedDatabase: database,
          }))
          : Result.succeed(found.route);
      },
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
  return yield* Effect.fromResult(bindings.root(derivation.rootDatabase));
});
