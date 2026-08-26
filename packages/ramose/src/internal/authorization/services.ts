/**
 * Effect services that surround the pure authorization kernel:
 * catalog binding, budgets, leases, and cryptographic identity.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AuthorizationBudgetExceeded, CatalogMismatch, LeaseExpired } from "./errors.ts";
import type { CatalogBinding, IrIdentities } from "./ir.ts";

export interface ResolvedCatalog extends CatalogBinding {
  readonly identities: IrIdentities;
  readonly classes: readonly string[];
  readonly claimKeys: readonly string[];
}

export class CatalogResolver extends Context.Service<
  CatalogResolver,
  {
    readonly resolve: (
      expected?: CatalogBinding,
    ) => Effect.Effect<ResolvedCatalog, CatalogMismatch>;
  }
>()("ramose/authorization/CatalogResolver") {}

export const StaticCatalogResolver = {
  layer: (catalog: ResolvedCatalog) =>
    Layer.succeed(CatalogResolver, {
      resolve: (expected) =>
        Effect.gen(function* () {
          if (expected !== undefined) {
            if (
              expected.databaseId !== catalog.databaseId ||
              expected.catalogName !== catalog.catalogName ||
              expected.catalogVersion !== catalog.catalogVersion ||
              expected.schemaFingerprint !== catalog.schemaFingerprint
            ) {
              return yield* Effect.fail(
                new CatalogMismatch({ reason: "catalog binding does not match the resolver" }),
              );
            }
          }
          return catalog;
        }),
    }),
};

export class AuthorizationBudget extends Context.Service<
  AuthorizationBudget,
  {
    readonly consume: (cost: number) => Effect.Effect<void, AuthorizationBudgetExceeded>;
  }
>()("ramose/authorization/AuthorizationBudget") {}

export const UnlimitedBudget = Layer.succeed(AuthorizationBudget, {
  consume: () => Effect.void,
});

export const countedBudget = (limit: number): AuthorizationBudget["Service"] => {
  let used = 0;
  return {
    consume: (cost) =>
      Effect.gen(function* () {
        used += cost;
        if (used > limit) {
          return yield* Effect.fail(
            new AuthorizationBudgetExceeded({
              reason: `authorization budget exceeded (${used} > ${limit})`,
            }),
          );
        }
      }),
  };
};

export const CountedBudget = {
  layer: (limit: number) => Layer.sync(AuthorizationBudget, () => countedBudget(limit)),
};

export class AuthorizationLease extends Context.Service<
  AuthorizationLease,
  {
    readonly assertValid: Effect.Effect<void, LeaseExpired>;
  }
>()("ramose/authorization/AuthorizationLease") {}

export const UnboundedLease = Layer.succeed(AuthorizationLease, {
  assertValid: Effect.void,
});

/** 5-second lease. Deterministic under an Effect test clock. */
export const timedLease = (issuedAtMillis: number, ttlMillis = 5_000): AuthorizationLease["Service"] => ({
  assertValid: Effect.gen(function* () {
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    if (now >= issuedAtMillis + ttlMillis) {
      return yield* Effect.fail(new LeaseExpired({ reason: "authorization lease expired" }));
    }
  }),
});

export const TimedLease = {
  layer: (issuedAtMillis: number, ttlMillis = 5_000) =>
    Layer.succeed(AuthorizationLease, timedLease(issuedAtMillis, ttlMillis)),
};
