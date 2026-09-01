import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unauthorized } from "../../db/Errors.ts";
import type { Db } from "../core/db.ts";
import type { InstalledCatalogDefinition } from "./definitions.ts";
import type {
  DatabaseCatalogBindings,
  DatabaseRouteDerivation,
  ResolvedDatabaseRoute,
} from "./database-bindings.ts";
import type { CatalogUnitHash, CatalogId, DatabaseId } from "./identities.ts";
import {
  constructAuthorizedResolvedRequestContext,
  executeWithinAuthorizedLease,
  type AuthenticatedCaller,
  type AuthorizedRequestContext,
  type AuthorizedRequestView,
} from "./request.ts";

export class DatabaseAuthorizationFailed extends Data.TaggedError(
  "DatabaseAuthorizationFailed",
)<{ readonly database: DatabaseId }> {}

export class DatabaseUnavailable extends Data.TaggedError("DatabaseUnavailable")<{
  readonly database: DatabaseId;
  readonly cause: unknown;
}> {}

export class DatabaseProvisioningFailed extends Data.TaggedError(
  "DatabaseProvisioningFailed",
)<{
  readonly database: DatabaseId;
  readonly cause: unknown;
}> {}

export type DatabaseTargetFailure =
  | DatabaseAuthorizationFailed
  | DatabaseUnavailable
  | DatabaseProvisioningFailed;

export const opaqueDatabaseTargetDenial = (
  _error: DatabaseTargetFailure,
): Unauthorized => new Unauthorized({ status: 403 });

export type AuthorizedDatabaseInput<R = never, EDb = unknown, EProvision = unknown> = {
  readonly bindings: DatabaseCatalogBindings;
  readonly root: ResolvedDatabaseRoute;
  readonly currentDb: (database: DatabaseId) => Effect.Effect<Db, EDb, R>;
  readonly provision: (
    route: ResolvedDatabaseRoute,
    derivation: DatabaseRouteDerivation,
  ) => Effect.Effect<void, EProvision, R>;
  readonly view?: AuthorizedRequestView;
};

export type DatabaseLeaseRouteIdentity = {
  readonly database: DatabaseId;
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
};

export type DatabaseLeaseIdentity = {
  readonly rootDatabase: DatabaseId;
  readonly route: DatabaseLeaseRouteIdentity;
};

export type AuthorizedDatabaseTarget = {
  readonly route: ResolvedDatabaseRoute;
  readonly derivation: DatabaseRouteDerivation;
  readonly context: AuthorizedRequestContext;
};

export const databaseLeaseIdentity = (
  target: AuthorizedDatabaseTarget,
): DatabaseLeaseIdentity => Object.freeze({
  rootDatabase: target.derivation.rootDatabase,
  route: Object.freeze({
    database: target.route.database,
    catalogKey: target.route.deployed.catalogKey,
    unitHash: target.route.deployed.unitHash,
  }),
});

export const sameDatabaseLeaseIdentity = (
  left: DatabaseLeaseIdentity,
  right: DatabaseLeaseIdentity,
): boolean =>
  left.rootDatabase === right.rootDatabase &&
  left.route.database === right.route.database &&
  left.route.catalogKey === right.route.catalogKey &&
  left.route.unitHash === right.route.unitHash;

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
  Object.freeze(definition.unit.catalog.fields.map((field) => Object.freeze({
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
  })));

export const resolveAuthorizedDatabaseTarget = Effect.fn(
  "Authorization.resolveAuthorizedDatabaseTarget",
)(function* <R, EDb, EProvision>(
  input: AuthorizedDatabaseInput<R, EDb, EProvision>,
  caller: AuthenticatedCaller,
): Effect.fn.Return<AuthorizedDatabaseTarget, DatabaseTargetFailure, R> {
  const derivation = Object.freeze({ rootDatabase: input.root.database });
  yield* input.provision(input.root, derivation).pipe(
    Effect.mapError((cause) => new DatabaseProvisioningFailed({
      database: input.root.database,
      cause,
    })),
  );
  const context = yield* constructAuthorizedResolvedRequestContext({
    authenticate: Effect.succeed(caller),
    bindings: input.bindings,
    route: input.root,
    currentDb: input.currentDb,
    ...(input.view === undefined ? {} : { view: input.view }),
  }, caller).pipe(
    Effect.mapError((error) =>
      error instanceof Unauthorized
        ? new DatabaseAuthorizationFailed({ database: input.root.database })
        : new DatabaseUnavailable({ database: input.root.database, cause: error })
    ),
  );
  return Object.freeze({ route: input.root, derivation, context });
});

export type ExecuteAuthorizedDatabaseInput<
  R = never,
  EDb = unknown,
  EProvision = unknown,
> = AuthorizedDatabaseInput<R, EDb, EProvision> & {
  readonly authenticate: Effect.Effect<AuthenticatedCaller, Unauthorized, R>;
  readonly interruptAfter?: import("effect/Duration").Input;
};

export const executeAuthorizedDatabaseTarget = Effect.fn(
  "Authorization.executeAuthorizedDatabaseTarget",
)(function* <A, E, R, EDb = unknown, EProvision = unknown>(
  input: ExecuteAuthorizedDatabaseInput<R, EDb, EProvision>,
  execute: (target: AuthorizedDatabaseTarget) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, Unauthorized | E, R> {
  return yield* executeWithinAuthorizedLease(input, (caller) =>
    resolveAuthorizedDatabaseTarget(input, caller).pipe(
      Effect.mapError(opaqueDatabaseTargetDenial),
      Effect.flatMap(execute),
    )
  );
});

export const executeAuthorizedDatabase = Effect.fn(
  "Authorization.executeAuthorizedDatabase",
)(function* <A, E, R, EDb = unknown, EProvision = unknown>(
  input: ExecuteAuthorizedDatabaseInput<R, EDb, EProvision>,
  execute: (filteredDb: Db) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, Unauthorized | E, R> {
  return yield* executeAuthorizedDatabaseTarget(
    input,
    (target) => execute(target.context.filteredDb),
  );
});
