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
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { DEFAULT_AUTHORIZATION_BUDGET } from "../bounds.ts";
import type { CatalogDescriptor } from "../catalog.ts";
import type { FieldId } from "../identities.ts";
import { isVerifiedInstalledAuthorization } from "../install.ts";
import type { InstalledAuthorizationIRV1 } from "../ir.ts";
import type { AuthorizationPrincipal } from "../principal.ts";
import {
  AuthorizationBudgetExceeded,
  CatalogMismatch,
  IncompleteRuleSnapshot,
  InvalidIR,
  InvalidTraversal,
  MissingMe,
  NotLoaded,
} from "../failures.ts";
import type { Truth } from "../truth.ts";
import {
  BudgetExhaustedProjection,
  type IncompleteProjected,
  type Projected,
} from "../truth.ts";
import {
  RuleSnapshotUnavailable,
  SnapshotCancelled,
  type RuleSnapshotFailure,
} from "./failures.ts";
import {
  projectFieldFromDb,
  traverseFieldsFromDb,
  traverseFromMeFromDb,
} from "./projection.ts";
import {
  checkRuleSnapshot,
  createRuleSnapshot,
  physicalCurrentDb,
  ruleProjectionState,
  type RawSnapshot,
  type RuleSnapshot,
} from "./snapshots.ts";

export interface RuleSnapshotRequest {
  readonly raw: RawSnapshot;
  readonly installed: InstalledAuthorizationIRV1;
  readonly catalog: CatalogDescriptor;
  readonly principal: AuthorizationPrincipal;
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

const requireLiveRule = (snapshot: RuleSnapshot) => {
  const checked = checkRuleSnapshot(snapshot);
  if (Result.isFailure(checked)) return Effect.fail(checked.failure);
  const state = ruleProjectionState(snapshot);
  if (state === undefined) {
    return Effect.fail(new SnapshotCancelled({ message: "snapshot is not a live capability" }));
  }
  return Effect.succeed(state);
};

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

export const projectRuleSnapshot = Effect.fn("Authorization.projectRuleSnapshot")(
  function* (request: RuleSnapshotRequest) {
    if (!isVerifiedInstalledAuthorization(request.installed)) {
      return yield* new InvalidIR({ message: "compiled policy is not sealed installed IR" });
    }
    if (request.principal.subject.length === 0) {
      return yield* new RuleSnapshotUnavailable({ message: "verified principal is required" });
    }
    if (
      request.catalog.id !== request.installed.catalog ||
      request.catalog.version !== request.installed.catalogVersion ||
      request.catalog.database !== request.installed.database ||
      request.catalog.fingerprint !== request.installed.schemaFingerprint
    ) {
      return yield* new CatalogMismatch({
        message: "catalog identity does not match installed policy",
        expected: request.installed.catalog,
        actual: request.catalog.id,
        expectedVersion: request.installed.catalogVersion,
        actualVersion: request.catalog.version,
        expectedFingerprint: request.installed.schemaFingerprint,
        actualFingerprint: request.catalog.fingerprint,
        expectedDatabase: request.installed.database,
        actualDatabase: request.catalog.database,
      });
    }
    if (request.raw.database !== request.installed.database) {
      return yield* new CatalogMismatch({
        message: "raw snapshot database does not match installed policy",
        expectedDatabase: request.installed.database,
        actualDatabase: request.raw.database,
      });
    }
    const current = physicalCurrentDb(request.raw);
    if (current === undefined) {
      return yield* new SnapshotCancelled({ message: "raw snapshot is not a live capability" });
    }
    if (request.basisT > current.basisT) {
      return yield* new RuleSnapshotUnavailable({ message: "rule basis is ahead of storage" });
    }
    const view = request.basisT < current.basisT ? current.asOf(request.basisT) : current;
    return createRuleSnapshot({
      database: request.installed.database,
      catalog: request.catalog,
      installed: request.installed,
      principal: request.principal,
      current: view,
      basisT: request.basisT,
      leaseEpoch: request.leaseEpoch ?? request.raw.leaseEpoch,
      budgetLimit: request.budgetLimit ?? DEFAULT_AUTHORIZATION_BUDGET,
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
    });
  },
);

export const lookupRuleField = Effect.fn("Authorization.lookupRuleField")(function* (
  snapshot: RuleSnapshot,
  eid: number,
  field: FieldId,
) {
  const state = yield* requireLiveRule(snapshot);
  const projected = yield* Effect.tryPromise({
    try: () => projectFieldFromDb(state.current, state.fields, eid, field, state.budget),
    catch: () => new RuleSnapshotUnavailable({ message: "rule lookup failed" }),
  });
  if (projected._tag === "BudgetExhausted") {
    return yield* new AuthorizationBudgetExceeded({
      message: "rule projection budget exhausted",
      spent: state.budget.spent,
      limit: state.budget.limit,
    });
  }
  return yield* requireComplete(projected);
});

export const traverseRuleFields = Effect.fn("Authorization.traverseRuleFields")(function* (
  snapshot: RuleSnapshot,
  eid: number,
  steps: readonly FieldId[],
) {
  const state = yield* requireLiveRule(snapshot);
  const projected = yield* Effect.tryPromise({
    try: () => traverseFieldsFromDb(state.current, state.fields, eid, steps, state.budget),
    catch: () => new RuleSnapshotUnavailable({ message: "rule traversal failed" }),
  });
  if (projected === BudgetExhaustedProjection || projected._tag === "BudgetExhausted") {
    return yield* new AuthorizationBudgetExceeded({
      message: "rule projection budget exhausted",
      spent: state.budget.spent,
      limit: state.budget.limit,
    });
  }
  return yield* requireComplete(projected);
});

export const traverseRuleFromMe = Effect.fn("Authorization.traverseRuleFromMe")(function* (
  snapshot: RuleSnapshot,
  steps: readonly FieldId[],
) {
  const state = yield* requireLiveRule(snapshot);
  const projected = yield* Effect.tryPromise({
    try: () =>
      traverseFromMeFromDb(state.current, state.fields, state.principal, steps, state.budget),
    catch: () => new RuleSnapshotUnavailable({ message: "rule me traversal failed" }),
  });
  if (projected._tag === "BudgetExhausted") {
    return yield* new AuthorizationBudgetExceeded({
      message: "rule projection budget exhausted",
      spent: state.budget.spent,
      limit: state.budget.limit,
    });
  }
  return yield* requireComplete(projected);
});

export const evaluateRuleUnwired: Effect.Effect<never, RuleSnapshotUnavailable> =
  Effect.fail(new RuleSnapshotUnavailable({ message: "policy evaluator is not wired" }));
