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
import type { Db } from "../core/db.ts";
import { MAX_READ_LEASE_MS } from "./bounds.ts";
import type { InstalledCatalogUnitV1 } from "./catalog-unit.ts";
import {
  opaqueCatalogDenial,
  resolveDeployedCatalog,
  type CatalogBoundRef,
  type DeployedCatalogs,
} from "./deployed.ts";
import { EntityId } from "./identities.ts";
import type { JsonValue } from "./json.ts";
import type { AuthorizationPrincipal } from "./principal.ts";
import { compileReadFilter } from "./read-filter.ts";
import { prepareAuthorizationCatalog } from "./validation/catalog.ts";

export type AuthenticatedCaller = {
  readonly subject: string;
  readonly claims: Readonly<Record<string, JsonValue>>;
  readonly classes: readonly string[];
};

export type AuthorizedRequestView =
  | { readonly kind: "current" }
  | { readonly kind: "asOf"; readonly t: number }
  | { readonly kind: "history" };

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
 * Structural: no worker import. Claims prefer `attrs`; classes fall back
 * to the single `class` claim.
 */
export const callerFromVerified = (verified: {
  readonly principal: {
    readonly sub?: string;
    readonly class: string;
    readonly classes?: readonly string[];
    readonly claims: { readonly attrs?: Record<string, unknown> };
  };
}): AuthenticatedCaller => {
  const attrs = verified.principal.claims.attrs;
  const claims: Record<string, JsonValue> = {};
  if (attrs !== undefined) {
    for (const [key, value] of Object.entries(attrs)) {
      claims[key] = value as JsonValue;
    }
  }
  return {
    subject: verified.principal.sub ?? "",
    claims,
    classes: verified.principal.classes ?? [verified.principal.class],
  };
};

const resolveMe = async (
  unit: InstalledCatalogUnitV1,
  caller: AuthenticatedCaller,
  currentDb: Db,
): Promise<AuthorizationPrincipal> => {
  const principal: AuthorizationPrincipal = {
    subject: caller.subject,
    claims: caller.claims,
    classes: [...caller.classes],
  };
  const field = unit.policy.principal.entity;
  if (field === undefined) return principal;
  const eid = await currentDb.entid([`:${field.owner.name}/${field.localName}`, caller.subject]);
  if (eid === undefined) return principal;
  return {
    ...principal,
    me: {
      entity: EntityId.make({ catalog: field.catalog, name: field.owner.name }),
      eid,
    },
  };
};

const requestedView = (current: Db, view: AuthorizedRequestView | undefined): Db => {
  if (view === undefined || view.kind === "current") return current;
  if (view.kind === "asOf") return current.asOf(view.t);
  return current.history();
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
    const current = yield* input.currentDb.pipe(Effect.mapError(() => deny()));
    const principal = yield* Effect.tryPromise({
      try: () => resolveMe(deployed.unit, caller, current),
      catch: () => deny(),
    });
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
