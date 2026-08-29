/**
 * Server-owned concrete database bindings for configured roots and dynamic
 * Graph children.
 *
 * The immutable definition registry is reusable code. A binding resolver owns
 * the separate `DatabaseId -> DeployedCatalog` decision for concrete storage.
 * Dynamic child identity depends only on the sealed parent route and stable
 * graph entity id; readable names never enter storage identity. Callers cannot
 * manufacture a route or supply an independently pairable unit hash.
 */

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

/**
 * Opaque server-owned pairing consumed by database acquisition and request
 * authorization. The private symbol prevents ordinary structural creation;
 * runtime provenance is checked as well.
 */
export interface ResolvedDatabaseRoute {
  readonly [ResolvedDatabaseRouteTypeId]: typeof ResolvedDatabaseRouteTypeId;
  readonly database: DatabaseId;
  readonly deployed: DeployedCatalog;
}

/** Protected Graph-row inputs after the caller's path segment was authorized. */
export type DynamicGraphBinding = {
  readonly graphEntity: number;
  readonly catalogKey: CatalogId;
};

/** Reachable code did not deploy the Graph row's protected permanent key. */
export class DynamicCatalogDefinitionMissing extends Data.TaggedError(
  "DynamicCatalogDefinitionMissing",
)<{
  readonly parentDatabase: DatabaseId;
  readonly graphEntity: number;
  readonly catalogKey: CatalogId;
}> {}

/** One derived concrete database was already sealed to a different source/unit. */
export class DatabaseCatalogBindingConflict extends Data.TaggedError(
  "DatabaseCatalogBindingConflict",
)<{
  readonly database: DatabaseId;
  readonly expectedCatalogKey: CatalogId;
  readonly expectedUnitHash: CatalogUnitHash;
  readonly actualCatalogKey: CatalogId;
  readonly actualUnitHash: CatalogUnitHash;
}> {}

/** A forged, stale, or foreign route reached a concrete acquisition boundary. */
export class InvalidResolvedDatabaseRoute extends Data.TaggedError(
  "InvalidResolvedDatabaseRoute",
)<{ readonly message: string }> {}

/** The Graph identity cannot name an application entity. */
export class InvalidDynamicGraphIdentity extends Data.TaggedError(
  "InvalidDynamicGraphIdentity",
)<{ readonly graphEntity: number }> {}

export type DynamicDatabaseBindingFailure =
  | DynamicCatalogDefinitionMissing
  | DatabaseCatalogBindingConflict
  | InvalidResolvedDatabaseRoute
  | InvalidDynamicGraphIdentity
  | InvalidIR;

/** External graph routing collapses every internal binding diagnostic. */
export const opaqueDatabaseBindingDenial = (
  _error: DynamicDatabaseBindingFailure | CatalogMismatch,
): Unauthorized => new Unauthorized({});

export interface DatabaseCatalogBindings {
  readonly [DatabaseCatalogBindingsTypeId]: typeof DatabaseCatalogBindingsTypeId;
  /** Resolve only a configured deployment root. Dynamic ids are not roots. */
  readonly root: (
    database: DatabaseId,
  ) => Result.Result<ResolvedDatabaseRoute, CatalogMismatch>;
  /** Seal the child database/unit derived from one authorized Graph row. */
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

/**
 * Stable, valid Cloudflare storage identity. The complete SHA-256 hex digest
 * fits the existing 64-character database-name contract without truncation.
 */
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

/**
 * Build the concrete binding capability from definitions and the configured
 * root deployment. Neither registry is mutated; dynamic bindings live only in
 * this server-owned resolver and are deterministically recoverable.
 */
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

/** Validate route provenance and recover its exact private runnable definition. */
export const resolveBoundCatalogDefinition = (
  bindings: DatabaseCatalogBindings,
  route: ResolvedDatabaseRoute,
): Result.Result<DeployedCatalogDefinition, InvalidResolvedDatabaseRoute> =>
  Result.map(boundRoute(bindings, route), (bound) => Object.freeze({
    database: route.database,
    definition: bound.definition,
  }));

/**
 * The sole concrete acquisition adapter for a resolved route. Validation
 * happens before the caller-provided real database boundary is invoked.
 */
export const acquireResolvedDatabase = <A, E, R>(
  bindings: DatabaseCatalogBindings,
  route: ResolvedDatabaseRoute,
  acquire: (database: DatabaseId) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | InvalidResolvedDatabaseRoute, R> =>
  Effect.gen(function* () {
    yield* Effect.fromResult(boundRoute(bindings, route));
    return yield* acquire(route.database);
  });
