/**
 * One Effectful request constructor: deployment-global authenticated
 * caller + trusted route database + that database's deployed catalog
 * unit → one filtered immutable {@link Db}, then the caller-supplied
 * request against only that value.
 *
 * Catalog lookup is DatabaseId-first (#453). `Db.filter` is the sole
 * authorization primitive. The `execute` callback is the only sanctioned
 * consumer of the request `Db`. JWT, catalog proof, and predicate
 * compile stay fail-closed. `currentDb` failures are infrastructure and
 * pass through so retryable replica/storage errors keep their status.
 */

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Unauthorized } from "../../db/Errors.ts";
import { Index } from "../core/datom.ts";
import type { Db } from "../core/db.ts";
import { RAMOSE_TYPE } from "../core/schema.ts";
import { MAX_READ_LEASE_MS } from "./bounds.ts";
import type { InstalledCatalogUnitV2 } from "./catalog-unit.ts";
import { compositionFromUnit } from "./composition.ts";
import {
  InvalidResolvedDatabaseRoute,
  acquireResolvedDatabase,
  opaqueDatabaseBindingDenial,
  resolveBoundCatalogDefinition,
  type DatabaseCatalogBindings,
  type ResolvedDatabaseRoute,
} from "./database-bindings.ts";
import {
  opaqueCatalogDenial,
  resolveDeployedCatalog,
  type DeployedCatalogs,
} from "./deployed.ts";
import { EntityId, type CatalogId, type CatalogUnitHash, type DatabaseId } from "./identities.ts";
import type { JsonValue } from "./json.ts";
import type {
  AuthorizationPrincipal,
  ClaimDescriptor,
  ClaimScalarType,
  ClaimShape,
} from "./principal.ts";
import { compileReadFilter, uniqueCanonicalTypeName } from "./read-filter.ts";
import { prepareAuthorizationCatalog } from "./validation/catalog.ts";

export type AuthenticatedCaller = {
  readonly claims: Readonly<Record<string, JsonValue>>;
  readonly classes: readonly string[];
  /** JWT NumericDate expiration, in whole seconds. */
  readonly exp: number;
};

export type AuthorizedRequestView = {
  readonly asOf?: number;
  readonly history?: boolean;
};

export type AuthorizedRequestContext = {
  readonly unit: InstalledCatalogUnitV2;
  readonly principal: AuthorizationPrincipal;
  readonly currentDb: Db;
  readonly filteredDb: Db;
};

export type AuthorizedRequestInput<R = never, EDb = unknown> = {
  readonly authenticate: Effect.Effect<AuthenticatedCaller, Unauthorized, R>;
  readonly catalogs: DeployedCatalogs;
  readonly routeDatabase: DatabaseId;
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
  /** Trusted route-database snapshot. Failures stay infrastructure errors. */
  readonly currentDb: (database: DatabaseId) => Effect.Effect<Db, EDb, R>;
  readonly view?: AuthorizedRequestView;
  readonly interruptAfter?: Duration.Input;
};

/**
 * Request input for an already resolved configured-root or dynamic-child
 * route. No database, catalog key, or unit hash can be independently paired.
 */
export type AuthorizedResolvedRequestInput<R = never, EDb = unknown> = {
  readonly authenticate: Effect.Effect<AuthenticatedCaller, Unauthorized, R>;
  readonly bindings: DatabaseCatalogBindings;
  readonly route: ResolvedDatabaseRoute;
  /** Real database acquisition keyed only by the validated sealed route. */
  readonly currentDb: (database: DatabaseId) => Effect.Effect<Db, EDb, R>;
  readonly view?: AuthorizedRequestView;
  readonly interruptAfter?: Duration.Input;
};

const deny = (): Unauthorized => new Unauthorized({});

/**
 * Map a verified JWT principal to the authorization caller.
 * Structural: no worker import. JWT `sub` is authoritative for the
 * `sub` key; app claims come from `attrs`. Classes fall back to the
 * single `class`. Authentication does not select a database.
 */
export const callerFromVerified = (verified: {
  readonly exp: number;
  readonly principal: {
    readonly sub?: string;
    readonly class: string;
    readonly classes?: readonly string[];
    readonly claims: { readonly attrs?: Record<string, unknown> };
  };
}): AuthenticatedCaller => {
  const sub = verified.principal.sub;
  const attrs = verified.principal.claims.attrs;
  const claims: Record<string, JsonValue> = {};
  if (attrs !== undefined) {
    for (const [key, value] of Object.entries(attrs)) {
      claims[key] = value as JsonValue;
    }
  }
  if (sub !== undefined && sub.length > 0) claims.sub = sub;
  return {
    claims,
    classes: verified.principal.classes ?? [verified.principal.class],
    exp: verified.exp,
  };
};

const leaseDuration = (
  exp: number,
  nowMs: number,
  limit: Duration.Duration,
): Result.Result<Duration.Duration, Unauthorized> => {
  if (!Number.isSafeInteger(exp)) return Result.fail(deny());
  const remainingMs = exp * 1_000 - nowMs;
  if (remainingMs <= 0) return Result.fail(deny());
  return Result.succeed(Duration.min(limit, Duration.millis(remainingMs)));
};

const selectSubject = (
  caller: AuthenticatedCaller,
  unit: InstalledCatalogUnitV2,
): Result.Result<string, Unauthorized> => {
  const value = caller.claims[unit.policy.principal.subjectClaim];
  if (typeof value !== "string" || value.trim().length === 0) return Result.fail(deny());
  return Result.succeed(value);
};

const matchesScalar = (value: unknown, valueType: ClaimScalarType): boolean => {
  switch (valueType) {
    case "string":
      return typeof value === "string";
    case "long":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "double":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
};

const matchesClaimShape = (value: unknown, shape: ClaimShape): boolean => {
  if (shape._tag === "scalar") return matchesScalar(value, shape.valueType);
  return Array.isArray(value) && value.every((item) => matchesScalar(item, shape.items.valueType));
};

const validateCallerClaims = (
  claims: Readonly<Record<string, JsonValue>>,
  vocabulary: readonly ClaimDescriptor[],
): Result.Result<void, Unauthorized> => {
  for (const descriptor of vocabulary) {
    if (!Object.hasOwn(claims, descriptor.key)) {
      if (!descriptor.optional) return Result.fail(deny());
      continue;
    }
    if (!matchesClaimShape(claims[descriptor.key], descriptor.shape)) {
      return Result.fail(deny());
    }
  }
  return Result.succeed(undefined);
};

const resolveMe = async (
  unit: InstalledCatalogUnitV2,
  subject: string,
  caller: AuthenticatedCaller,
  currentDb: Db,
): Promise<Result.Result<AuthorizationPrincipal, Unauthorized>> => {
  const principal: AuthorizationPrincipal = {
    subject,
    claims: caller.claims,
    classes: [...caller.classes],
  };
  const field = unit.policy.principal.entity;
  if (field === undefined) return Result.succeed(principal);
  const eid = await currentDb.entid([`:${field.owner.name}/${field.localName}`, subject]);
  if (eid === undefined) return Result.succeed(principal);
  const typeDatoms = await currentDb.datomsArray(Index.EAVT, { e: eid, a: RAMOSE_TYPE });
  const name = uniqueCanonicalTypeName(typeDatoms);
  if (name === undefined || name !== field.owner.name) return Result.fail(deny());
  const catalogEntity = unit.catalog.entities.find((entity) => entity.id.name === name);
  if (catalogEntity === undefined || catalogEntity.id.catalog !== field.catalog) {
    return Result.fail(deny());
  }
  return Result.succeed({
    ...principal,
    me: {
      entity: EntityId.make({ catalog: field.catalog, name }),
      eid,
    },
  });
};

const requestedView = (current: Db, view: AuthorizedRequestView | undefined): Db => {
  let db = current;
  if (typeof view?.asOf === "number") db = db.asOf(view.asOf);
  if (view?.history === true) db = db.history();
  return db;
};

const catalogTargetOf = (unit: InstalledCatalogUnitV2) => ({
  database: unit.catalog.database,
  catalog: unit.catalog.id,
  catalogVersion: unit.catalog.version,
  schemaFingerprint: unit.catalog.fingerprint,
});

const requirePreparedUnit = (
  unit: InstalledCatalogUnitV2,
): Result.Result<void, Unauthorized> => {
  try {
    if (unit.policy == null) return Result.fail(deny());
    const prepared = prepareAuthorizationCatalog(catalogTargetOf(unit), unit.catalog);
    if (Result.isFailure(prepared)) return Result.fail(deny());
    return Result.succeed(undefined);
  } catch {
    return Result.fail(deny());
  }
};

const compilePredicate = (
  unit: InstalledCatalogUnitV2,
  principal: AuthorizationPrincipal,
  currentDb: Db,
): Result.Result<ReturnType<typeof compileReadFilter>, Unauthorized> => {
  try {
    return Result.succeed(compileReadFilter({ unit, principal, currentDb }));
  } catch {
    return Result.fail(deny());
  }
};

type AdmittedCaller = {
  readonly unit: InstalledCatalogUnitV2;
  readonly subject: string;
};

const admitCatalogCaller = (
  unit: InstalledCatalogUnitV2,
  caller: AuthenticatedCaller,
): Effect.Effect<AdmittedCaller, Unauthorized> =>
  Effect.gen(function* () {
    yield* Effect.fromResult(requirePreparedUnit(unit));
    const subject = yield* Effect.fromResult(selectSubject(caller, unit));
    yield* Effect.fromResult(validateCallerClaims(caller.claims, unit.policy.claims));
    return { unit, subject };
  }).pipe(Effect.catchCause(() => Effect.fail(deny())));

/** Catalog proof and caller claims. Defects collapse to Unauthorized. */
const admitDeployedCaller = <R, EDb>(
  input: AuthorizedRequestInput<R, EDb>,
  caller: AuthenticatedCaller,
): Effect.Effect<AdmittedCaller, Unauthorized, R> =>
  Effect.gen(function* () {
    const deployed = yield* Effect.fromResult(
      resolveDeployedCatalog(input.catalogs, {
        database: input.routeDatabase,
        catalogKey: input.catalogKey,
        unitHash: input.unitHash,
      }),
    ).pipe(Effect.mapError(opaqueCatalogDenial));
    return yield* admitCatalogCaller(deployed.unit, caller);
  }).pipe(Effect.catchCause(() => Effect.fail(deny())));

/** Principal bind + predicate compile. Defects collapse to Unauthorized. */
const bindReadPredicate = (
  unit: InstalledCatalogUnitV2,
  subject: string,
  caller: AuthenticatedCaller,
  current: Db,
): Effect.Effect<{
  readonly principal: AuthorizationPrincipal;
  readonly predicate: ReturnType<typeof compileReadFilter>;
}, Unauthorized> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.tryPromise({
      try: () => resolveMe(unit, subject, caller, current),
      catch: () => deny(),
    });
    const principal = yield* Effect.fromResult(resolved);
    const predicate = yield* Effect.fromResult(compilePredicate(unit, principal, current));
    return { principal, predicate };
  }).pipe(Effect.catchCause(() => Effect.fail(deny())));

const constructFilteredContext = (
  admitted: AdmittedCaller,
  caller: AuthenticatedCaller,
  currentDb: Db,
  view: AuthorizedRequestView | undefined,
): Effect.Effect<AuthorizedRequestContext, Unauthorized> =>
  Effect.gen(function* () {
    const composition = yield* Effect.fromResult(compositionFromUnit(admitted.unit)).pipe(
      Effect.mapError(() => deny()),
    );
    const current = currentDb.withComposition(composition);
    const bound = yield* bindReadPredicate(
      admitted.unit,
      admitted.subject,
      caller,
      current,
    );
    return {
      unit: admitted.unit,
      principal: bound.principal,
      currentDb: current,
      filteredDb: requestedView(current, view).filter(bound.predicate),
    };
  });

/**
 * Admit the caller, acquire the route database, then filter that value.
 * `currentDb` errors are infrastructure and pass through unchanged.
 */
export const constructAuthorizedRequestContext = <R, EDb>(
  input: AuthorizedRequestInput<R, EDb>,
  caller: AuthenticatedCaller,
): Effect.Effect<AuthorizedRequestContext, Unauthorized | EDb, R> =>
  Effect.gen(function* () {
    const admitted = yield* admitDeployedCaller(input, caller);
    const current = yield* input.currentDb(input.routeDatabase);
    return yield* constructFilteredContext(admitted, caller, current, input.view);
  });

/**
 * Authorize and acquire a configured root or dynamic child only through its
 * opaque server-owned binding. Invalid/foreign/stale routes deny before the
 * real acquisition callback runs.
 */
export const constructAuthorizedResolvedRequestContext = <R, EDb>(
  input: AuthorizedResolvedRequestInput<R, EDb>,
  caller: AuthenticatedCaller,
): Effect.Effect<AuthorizedRequestContext, Unauthorized | EDb, R> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.fromResult(
      resolveBoundCatalogDefinition(input.bindings, input.route),
    ).pipe(Effect.mapError(opaqueDatabaseBindingDenial));
    const admitted = yield* admitCatalogCaller(resolved.definition.unit, caller);
    const current = yield* acquireResolvedDatabase(
      input.bindings,
      input.route,
      input.currentDb,
    ).pipe(Effect.mapError((error) =>
      error instanceof InvalidResolvedDatabaseRoute
        ? opaqueDatabaseBindingDenial(error)
        : error
    ));
    return yield* constructFilteredContext(admitted, caller, current, input.view);
  });

export type AuthorizedLeaseInput<R> = {
  readonly authenticate: Effect.Effect<AuthenticatedCaller, Unauthorized, R>;
  readonly interruptAfter?: Duration.Input;
};

export const executeWithinAuthorizedLease = <A, E, R>(
  input: AuthorizedLeaseInput<R>,
  execute: (caller: AuthenticatedCaller) => Effect.Effect<A, E, R>,
): Effect.Effect<A, Unauthorized | E, R> => {
  const limit = Duration.fromInputUnsafe(input.interruptAfter ?? MAX_READ_LEASE_MS);
  const program = Effect.gen(function* () {
    const caller = yield* input.authenticate.pipe(Effect.mapError(() => deny()));
    const nowMs = yield* Clock.currentTimeMillis;
    const duration = yield* Effect.fromResult(leaseDuration(caller.exp, nowMs, limit));
    return yield* execute(caller).pipe(
      Effect.timeoutOrElse({
        duration,
        orElse: () => Effect.fail(deny()),
      }),
    );
  });
  return program.pipe(
    Effect.timeoutOrElse({
      duration: limit,
      orElse: () => Effect.fail(deny()),
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.fail(deny()) : Effect.failCause(cause)
    ),
  );
};

export const executeAuthorizedRequest = Effect.fn("Authorization.executeAuthorizedRequest")(
  function* <A, E, R, EDb = unknown>(
    input: AuthorizedRequestInput<R, EDb>,
    execute: (filteredDb: Db) => Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, Unauthorized | E | EDb, R> {
    return yield* executeWithinAuthorizedLease(input, (caller) =>
      constructAuthorizedRequestContext(input, caller).pipe(
        Effect.flatMap((context) => execute(context.filteredDb)),
      )
    );
  },
);

export const executeAuthorizedResolvedRequest = Effect.fn(
  "Authorization.executeAuthorizedResolvedRequest",
)(function* <A, E, R, EDb = unknown>(
  input: AuthorizedResolvedRequestInput<R, EDb>,
  execute: (filteredDb: Db) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, Unauthorized | E | EDb, R> {
  return yield* executeWithinAuthorizedLease(input, (caller) =>
    constructAuthorizedResolvedRequestContext(input, caller).pipe(
      Effect.flatMap((context) => execute(context.filteredDb)),
    )
  );
});
