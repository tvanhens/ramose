/**
 * Effect orchestration for canonical membership (ID-1–ID-5, WR-5).
 *
 * Catalog lookup, write validation, occupancy, and atomic stamp
 * application live here. Closure derivation and comparison stay in
 * {@link ../membership.ts}. Membership facts are values — this module
 * does not allocate an Effect per stamp.
 *
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import {
  decideMembership,
  deriveLocalMembership,
  membershipFailureOf,
  occupiedCompositionFailure,
  type LocalMembership,
  type MembershipCatalogView,
  type MembershipFailure,
  type MembershipWrite,
  type ObservedMembership,
} from "../membership.ts";
import { AuthorizationDenied } from "../failures.ts";
import { toAuthorizationDenied } from "./deny.ts";

export interface MembershipCatalogService {
  readonly closure: (
    typeIdent: string,
  ) => Effect.Effect<LocalMembership, MembershipFailure>;
  readonly view: Effect.Effect<MembershipCatalogView, MembershipFailure>;
}

export class MembershipCatalog extends Context.Service<
  MembershipCatalog,
  MembershipCatalogService
>()("ramose/authorization/runtime/MembershipCatalog") {}

export interface MembershipTransactorService {
  readonly read: (entity: number) => Effect.Effect<ObservedMembership>;
  readonly occupied: (typeIdent: string) => Effect.Effect<boolean>;
  readonly apply: (
    entity: number,
    membership: LocalMembership,
  ) => Effect.Effect<void>;
}

export class MembershipTransactor extends Context.Service<
  MembershipTransactor,
  MembershipTransactorService
>()("ramose/authorization/runtime/MembershipTransactor") {}

export const validateMembershipWrite = (
  write: MembershipWrite,
): Effect.Effect<LocalMembership, MembershipFailure, MembershipCatalog> =>
  Effect.gen(function* () {
    const catalog = yield* MembershipCatalog;
    const view = yield* catalog.view;
    const decision = decideMembership(view, write);
    if (decision._tag !== "ok") {
      return yield* membershipFailureOf(decision, undefined, write.observed);
    }
    return decision.expected;
  });

export const applyMembershipWrite = (
  entity: number,
  write: MembershipWrite,
): Effect.Effect<
  LocalMembership,
  MembershipFailure,
  MembershipCatalog | MembershipTransactor
> =>
  Effect.gen(function* () {
    const expected = yield* validateMembershipWrite(write);
    const transactor = yield* MembershipTransactor;
    yield* transactor.apply(entity, expected);
    return expected;
  });

export const rejectOccupiedComposition = (
  typeIdent: string,
  before: readonly string[],
  after: readonly string[],
): Effect.Effect<void, MembershipFailure, MembershipTransactor> =>
  Effect.gen(function* () {
    const transactor = yield* MembershipTransactor;
    const occupied = yield* transactor.occupied(typeIdent);
    if (!occupied) return;
    return yield* occupiedCompositionFailure(typeIdent, before, after);
  });

/** Uniform external denial — does not name the inner membership check (FC-1). */
export const denyMembershipFailure = (
  _failure: MembershipFailure,
): Effect.Effect<never, AuthorizationDenied> => toAuthorizationDenied();

export const membershipCatalogLayer = (
  view: MembershipCatalogView,
): Layer.Layer<MembershipCatalog> =>
  Layer.succeed(MembershipCatalog, {
    view: Effect.succeed(view),
    closure: (typeIdent) => {
      const derived = deriveLocalMembership(view, typeIdent);
      return Result.isFailure(derived)
        ? Effect.fail(derived.failure)
        : Effect.succeed(derived.success);
    },
  });

export const memoryMembershipTransactorLayer = (options?: {
  readonly occupied?: ReadonlySet<string>;
  readonly applied?: Map<number, LocalMembership>;
}): Layer.Layer<MembershipTransactor> => {
  const occupied = options?.occupied ?? new Set<string>();
  const applied = options?.applied ?? new Map<number, LocalMembership>();
  return Layer.succeed(MembershipTransactor, {
    read: (entity) => {
      const have = applied.get(entity);
      return Effect.succeed(
        have === undefined
          ? { types: [], traits: [] }
          : { types: [have.type], traits: have.traits },
      );
    },
    occupied: (typeIdent) => Effect.succeed(occupied.has(typeIdent)),
    apply: (entity, membership) =>
      Effect.sync(() => {
        applied.set(entity, membership);
      }),
  });
};
