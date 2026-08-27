/**
 * Rule projection (TCB-2).
 *
 * The policy evaluator is the only holder. Lookups may follow grant
 * edges the principal cannot read; those facts must not appear in an
 * application snapshot. Tag, constructor, and granting Layer stay
 * module-private.
 *
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { DatabaseId, PolicyHash, RuleId } from "../identities.ts";
import type { AuthorizationPrincipal } from "../principal.ts";
import type { Truth } from "../truth.ts";
import type { RuleSnapshot } from "./brands.ts";
import type { RuleSnapshotFailure } from "./failures.ts";

export interface RuleSnapshotRequest {
  readonly database: DatabaseId;
  readonly basisT: number;
  readonly policyHash: PolicyHash;
  readonly principal: AuthorizationPrincipal;
}

export interface RuleSnapshotAccessService {
  readonly project: (
    request: RuleSnapshotRequest,
  ) => Effect.Effect<RuleSnapshot, RuleSnapshotFailure>;
  readonly evaluateRule: (
    snapshot: RuleSnapshot,
    ruleId: RuleId,
  ) => Effect.Effect<Truth, RuleSnapshotFailure>;
}

export class RuleSnapshotAccess extends Context.Service<
  RuleSnapshotAccess,
  RuleSnapshotAccessService
>()("ramose/authorization/runtime/RuleSnapshotAccess") {}
