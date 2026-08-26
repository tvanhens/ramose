/** Effect services around the pure authorization kernel. */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CatalogDescriptor } from "./descriptor.ts";
import {
  AuthorizationBudgetExceeded,
  CatalogMismatch,
  HashFailure,
  IncompleteRuleSnapshot,
  LeaseExpired,
} from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import type { CatalogId } from "./identity.ts";
import type { RuleAccessPlan } from "./plan.ts";
import type { RuleSnapshotData } from "./eval.ts";

export class AuthorizationHash extends Context.Service<
  AuthorizationHash,
  {
    readonly digest: (canonical: string) => Effect.Effect<string, HashFailure>;
  }
>()("Ramose.Authorization.Hash") {}

export const AuthorizationHashLive = Layer.succeed(AuthorizationHash, {
  digest: (canonical) => Effect.sync(() => sha256Hex(canonical)),
});

export class CatalogResolver extends Context.Service<
  CatalogResolver,
  {
    readonly resolve: (
      catalogId: CatalogId,
      catalogVersion?: string,
    ) => Effect.Effect<CatalogDescriptor, CatalogMismatch>;
  }
>()("Ramose.Authorization.CatalogResolver") {}

export interface AuthorizationBudget {
  readonly limit: number;
  readonly remaining: () => number;
  readonly consume: (
    n?: number,
  ) => Effect.Effect<void, AuthorizationBudgetExceeded>;
}

export class AuthorizationBudgetService extends Context.Service<
  AuthorizationBudgetService,
  {
    readonly make: (limit: number) => AuthorizationBudget;
  }
>()("Ramose.Authorization.Budget") {}

export const AuthorizationBudgetLive = Layer.succeed(
  AuthorizationBudgetService,
  {
    make: (limit) => {
      let remaining = limit;
      return {
        limit,
        remaining: () => remaining,
        consume: (n = 1) => {
          remaining -= n;
          return remaining < 0
            ? Effect.fail(
                new AuthorizationBudgetExceeded({
                  message: "authorization work budget exhausted",
                }),
              )
            : Effect.void;
        },
      };
    },
  },
);

/**
 * Trusted rule-snapshot projection. Completeness, budgets, and cancellation
 * live here — not in the per-datom evaluator.
 */
export class RuleSnapshot extends Context.Service<
  RuleSnapshot,
  {
    readonly project: (
      plan: RuleAccessPlan,
      budget: AuthorizationBudget,
    ) => Effect.Effect<
      RuleSnapshotData,
      IncompleteRuleSnapshot | AuthorizationBudgetExceeded
    >;
  }
>()("Ramose.Authorization.RuleSnapshot") {}

/** Clock / lease handles for #347. Defined here so consumers share one shape. */
export interface AuthorizationLease {
  readonly epoch: number;
  readonly expiresAt: number;
}

export class AuthorizationClock extends Context.Service<
  AuthorizationClock,
  {
    readonly now: Effect.Effect<number>;
    readonly lease: (
      ttlMs: number,
      epoch: number,
    ) => Effect.Effect<AuthorizationLease>;
    readonly assertFresh: (
      lease: AuthorizationLease,
    ) => Effect.Effect<void, LeaseExpired>;
  }
>()("Ramose.Authorization.Clock") {}

export const AuthorizationClockLive = Layer.effect(
  AuthorizationClock,
  Effect.sync(() => ({
    now: Clock.currentTimeMillis,
    lease: (ttlMs: number, epoch: number) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => ({
          epoch,
          expiresAt: now + Math.min(ttlMs, 5_000),
        })),
      ),
    assertFresh: (lease: AuthorizationLease) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          now > lease.expiresAt
            ? Effect.fail(
                new LeaseExpired({
                  message: "authorization lease expired",
                  expiresAt: lease.expiresAt,
                }),
              )
            : Effect.void,
        ),
      ),
  })),
);

export type InternalAuthEvent = {
  readonly _tag: string;
  readonly detail: string;
};

/**
 * Internal authorization telemetry. Must not reach application output.
 */
export class AuthorizationTelemetry extends Context.Service<
  AuthorizationTelemetry,
  {
    readonly record: (event: InternalAuthEvent) => Effect.Effect<void>;
  }
>()("Ramose.Authorization.Telemetry") {}

export const AuthorizationTelemetrySilent = Layer.succeed(
  AuthorizationTelemetry,
  {
    record: () => Effect.void,
  },
);

export const inMemoryCatalogResolver = (
  catalog: CatalogDescriptor,
): Layer.Layer<CatalogResolver> =>
  Layer.succeed(CatalogResolver, {
    resolve: (catalogId, catalogVersion) => {
      if (catalogId !== catalog.catalogId) {
        return Effect.fail(
          new CatalogMismatch({
            message: "catalog identity does not match",
            catalogId,
            catalogVersion,
          }),
        );
      }
      if (
        catalogVersion !== undefined &&
        catalogVersion !== catalog.catalogVersion
      ) {
        return Effect.fail(
          new CatalogMismatch({
            message: "catalog version is stale",
            catalogId,
            catalogVersion,
          }),
        );
      }
      return Effect.succeed(catalog);
    },
  });
