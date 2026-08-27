/**
 * Rule projection (TCB-2, HIST-2, CUR-4).
 *
 * The policy evaluator is the only holder. Lookups may follow grant
 * edges the principal cannot read; those facts must not appear in an
 * application snapshot. Tag, constructor, and granting Layer stay
 * module-private.
 *
 * {@link evaluateRule} stays unwired — leftover #337 evaluation is out
 * of scope. The accessor is the completeness-aware projection.
 *
 * Physical rule state stays in the snapshot WeakMap. This module calls
 * only lease-checked, bounded projection operations.
 *
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { CatalogDescriptor } from "../catalog.ts";
import type { FieldId } from "../identities.ts";
import type { InstalledAuthorizationIRV1 } from "../ir.ts";
import {
  AuthorizationBudgetExceeded,
  IncompleteRuleSnapshot,
  InvalidTraversal,
  MissingMe,
  NotLoaded,
} from "../failures.ts";
import type { Truth } from "../truth.ts";
import { type IncompleteProjected, type Projected } from "../truth.ts";
import type { AdmissionTicket } from "./authentication.ts";
import {
  RuleSnapshotUnavailable,
  type RuleSnapshotFailure,
} from "./failures.ts";
import {
  mintRuleSnapshot,
  projectLiveRuleField,
  traverseLiveRuleFields,
  traverseLiveRuleFromMe,
  type LiveRuleProjection,
  type RawSnapshot,
  type RuleSnapshot,
} from "./snapshots.ts";

export interface RuleSnapshotRequest {
  readonly raw: RawSnapshot;
  readonly installed: InstalledAuthorizationIRV1;
  readonly catalog: CatalogDescriptor;
  readonly ticket: AdmissionTicket;
  readonly basisT: number;
  readonly leaseEpoch?: number | undefined;
  readonly budgetLimit?: number | undefined;
  readonly expiresAt?: number | undefined;
}

export interface RuleSnapshotAccessService {
  readonly project: (
    request: RuleSnapshotRequest,
  ) => Effect.Effect<RuleSnapshot, RuleSnapshotFailure>;
  readonly lookup: (
    snapshot: RuleSnapshot,
    eid: number,
    field: FieldId,
  ) => Effect.Effect<Projected, RuleSnapshotFailure>;
  readonly traverse: (
    snapshot: RuleSnapshot,
    eid: number,
    steps: readonly FieldId[],
  ) => Effect.Effect<Projected, RuleSnapshotFailure>;
  readonly traverseFromMe: (
    snapshot: RuleSnapshot,
    steps: readonly FieldId[],
  ) => Effect.Effect<Projected, RuleSnapshotFailure>;
  readonly evaluateRule: (
    snapshot: RuleSnapshot,
    ruleId: string,
  ) => Effect.Effect<Truth, RuleSnapshotFailure>;
}

export class RuleSnapshotAccess extends Context.Service<
  RuleSnapshotAccess,
  RuleSnapshotAccessService
>()("ramose/authorization/runtime/RuleSnapshotAccess") {}

const projectedToFailure = (
  projected: IncompleteProjected,
): RuleSnapshotFailure => {
  switch (projected._tag) {
    case "NotLoaded":
      return new IncompleteRuleSnapshot({ message: "rule fact is not loaded", reason: NotLoaded });
    case "InvalidTraversal":
      return new IncompleteRuleSnapshot({ message: "invalid rule traversal", reason: InvalidTraversal });
    case "BudgetExhausted":
      return new AuthorizationBudgetExceeded({ message: "rule projection budget exhausted", spent: 0, limit: 0 });
    case "MissingMe":
      return new IncompleteRuleSnapshot({ message: "principal me is missing", reason: MissingMe });
  }
};

const requireComplete = (projected: Projected): Effect.Effect<Projected, RuleSnapshotFailure> => {
  if (
    projected._tag === "NotLoaded" ||
    projected._tag === "InvalidTraversal" ||
    projected._tag === "BudgetExhausted" ||
    projected._tag === "MissingMe"
  ) {
    return Effect.fail(projectedToFailure(projected));
  }
  return Effect.succeed(projected);
};

const completeLiveProjection = (
  outcome: LiveRuleProjection,
): Effect.Effect<Projected, RuleSnapshotFailure> => {
  if (outcome.projected._tag === "BudgetExhausted") {
    return Effect.fail(
      new AuthorizationBudgetExceeded({
        message: "rule projection budget exhausted",
        spent: outcome.budget.spent,
        limit: outcome.budget.limit,
      }),
    );
  }
  return requireComplete(outcome.projected);
};

export const projectRuleSnapshot = Effect.fn("Authorization.projectRuleSnapshot")(
  function* (request: RuleSnapshotRequest) {
    return yield* Effect.fromResult(mintRuleSnapshot(request));
  },
);

export const lookupRuleField = Effect.fn("Authorization.lookupRuleField")(function* (
  snapshot: RuleSnapshot,
  eid: number,
  field: FieldId,
) {
  const outcome = yield* Effect.tryPromise({
    try: () => projectLiveRuleField(snapshot, eid, field),
    catch: () => new RuleSnapshotUnavailable({ message: "rule lookup failed" }),
  });
  return yield* completeLiveProjection(yield* Effect.fromResult(outcome));
});

export const traverseRuleFields = Effect.fn("Authorization.traverseRuleFields")(function* (
  snapshot: RuleSnapshot,
  eid: number,
  steps: readonly FieldId[],
) {
  const outcome = yield* Effect.tryPromise({
    try: () => traverseLiveRuleFields(snapshot, eid, steps),
    catch: () => new RuleSnapshotUnavailable({ message: "rule traversal failed" }),
  });
  return yield* completeLiveProjection(yield* Effect.fromResult(outcome));
});

export const traverseRuleFromMe = Effect.fn("Authorization.traverseRuleFromMe")(function* (
  snapshot: RuleSnapshot,
  steps: readonly FieldId[],
) {
  const outcome = yield* Effect.tryPromise({
    try: () => traverseLiveRuleFromMe(snapshot, steps),
    catch: () => new RuleSnapshotUnavailable({ message: "rule me traversal failed" }),
  });
  return yield* completeLiveProjection(yield* Effect.fromResult(outcome));
});

export const evaluateRuleUnwired: Effect.Effect<never, RuleSnapshotUnavailable> =
  Effect.fail(new RuleSnapshotUnavailable({ message: "policy evaluator is not wired" }));
