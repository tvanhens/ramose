/**
 * One Effectful request constructor: authenticated caller + deployed
 * catalog unit → filtered immutable {@link Db}, then the caller-supplied
 * request against only that value.
 *
 * Catalog definitions come from {@link DeployedCatalogs} (#409). The
 * `execute` callback is the only sanctioned consumer of the request `Db`.
 */

import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Unauthorized } from "../../db/Errors.ts";
import { Index } from "../core/datom.ts";
import type { Db } from "../core/db.ts";
import { RAMOSE_TYPE } from "../core/schema.ts";
import { MAX_READ_LEASE_MS } from "./bounds.ts";
import type { InstalledCatalogUnitV1 } from "./catalog-unit.ts";
import {
  opaqueCatalogDenial,
  resolveDeployedCatalog,
  type CatalogBoundRef,
  type DeployedCatalogs,
} from "./deployed.ts";
import { DatabaseId, EntityId } from "./identities.ts";
import type { JsonValue } from "./json.ts";
import type {
  AuthorizationPrincipal,
  ClaimDescriptor,
  ClaimScalarType,
  ClaimShape,
} from "./principal.ts";
import { compileReadFilter } from "./read-filter.ts";
import { prepareAuthorizationCatalog } from "./validation/catalog.ts";

export type AuthenticatedCaller = {
  readonly database: DatabaseId;
  readonly claims: Readonly<Record<string, JsonValue>>;
  readonly classes: readonly string[];
};

export type AuthorizedRequestView = {
  readonly asOf?: number;
  readonly history?: boolean;
};

export type AuthorizedRequestInput<R = never> = {
  readonly authenticate: Effect.Effect<AuthenticatedCaller, Unauthorized, R>;
  readonly catalogs: DeployedCatalogs;
  readonly catalogRef: CatalogBoundRef;
  readonly currentDb: Effect.Effect<Db, unknown, R>;
  readonly view?: AuthorizedRequestView;
  readonly interruptAfter?: Duration.Input;
};

const deny = (): Unauthorized => new Unauthorized({});

/**
 * Map a verified JWT principal to the authorization caller.
 * Structural: no worker import. JWT `sub` lands in `claims.sub`; app
 * claims come from `attrs`. Classes fall back to the single `class`.
 */
export const callerFromVerified = (verified: {
  readonly principal: {
    readonly sub?: string;
    readonly db: string;
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
    database: DatabaseId.make(verified.principal.db),
    claims,
    classes: verified.principal.classes ?? [verified.principal.class],
  };
};

const entityNameFromTypeIdent = (ident: string): string | undefined => {
  if (!ident.startsWith(":") || ident.length < 2) return undefined;
  const name = ident.slice(1);
  if (name.length === 0 || name.includes("/")) return undefined;
  return name;
};

const selectSubject = (
  caller: AuthenticatedCaller,
  unit: InstalledCatalogUnitV1,
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
      return typeof value === "number" && Number.isInteger(value);
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
  unit: InstalledCatalogUnitV1,
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
  const typeDatom = await currentDb.first(Index.EAVT, { e: eid, a: RAMOSE_TYPE });
  if (typeDatom === undefined || typeof typeDatom.v !== "string") return Result.fail(deny());
  const name = entityNameFromTypeIdent(typeDatom.v);
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

const catalogTargetOf = (unit: InstalledCatalogUnitV1) => ({
  database: unit.catalog.database,
  catalog: unit.catalog.id,
  catalogVersion: unit.catalog.version,
  schemaFingerprint: unit.catalog.fingerprint,
});

const requirePreparedUnit = (
  unit: InstalledCatalogUnitV1,
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
  unit: InstalledCatalogUnitV1,
  principal: AuthorizationPrincipal,
  currentDb: Db,
): Result.Result<ReturnType<typeof compileReadFilter>, Unauthorized> => {
  try {
    return Result.succeed(compileReadFilter({ unit, principal, currentDb }));
  } catch {
    return Result.fail(deny());
  }
};

const constructFilteredDb = <R>(
  input: AuthorizedRequestInput<R>,
): Effect.Effect<Db, Unauthorized, R> =>
  Effect.gen(function* () {
    const caller = yield* input.authenticate.pipe(Effect.mapError(() => deny()));
    const deployed = yield* Effect.fromResult(
      resolveDeployedCatalog(input.catalogs, input.catalogRef),
    ).pipe(Effect.mapError(opaqueCatalogDenial));
    yield* Effect.fromResult(requirePreparedUnit(deployed.unit));
    if (caller.database !== deployed.unit.catalog.database) {
      return yield* deny();
    }
    const subject = yield* Effect.fromResult(selectSubject(caller, deployed.unit));
    yield* Effect.fromResult(validateCallerClaims(caller.claims, deployed.unit.policy.claims));
    const current = yield* input.currentDb.pipe(Effect.mapError(() => deny()));
    const resolved = yield* Effect.tryPromise({
      try: () => resolveMe(deployed.unit, subject, caller, current),
      catch: () => deny(),
    });
    const principal = yield* Effect.fromResult(resolved);
    const predicate = yield* Effect.fromResult(
      compilePredicate(deployed.unit, principal, current),
    );
    return requestedView(current, input.view).filter(predicate);
  });

export const executeAuthorizedRequest = Effect.fn("Authorization.executeAuthorizedRequest")(
  function* <A, E, R>(
    input: AuthorizedRequestInput<R>,
    execute: (filteredDb: Db) => Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, Unauthorized | E, R> {
    const program = Effect.gen(function* () {
      const filteredDb = yield* constructFilteredDb(input).pipe(
        Effect.catchCause(() => Effect.fail(deny())),
      );
      return yield* execute(filteredDb);
    });
    return yield* program.pipe(
      Effect.timeoutOrElse({
        duration: input.interruptAfter ?? MAX_READ_LEASE_MS,
        orElse: () => Effect.fail(deny()),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.fail(deny()) : Effect.failCause(cause),
      ),
    );
  },
);
