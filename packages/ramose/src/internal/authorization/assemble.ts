/**
 * Access-plan derivation and installed-IR assembly public surface.
 *
 * Implementation lives under {@link ./assembly/}. This file re-exports the
 * orchestration API so internal imports stay stable. The only path from a
 * raw template to runtime-acceptable installed IR is
 * {@link bindInstalledAuthorization} /
 * {@link bindInstalledAgainstAuthoritativeCatalog}.
 */

export {
  assembleInstalledAuthorization,
  assembleInstalledAuthorizationResult,
  bindInstalledAgainstAuthoritativeCatalog,
  bindInstalledAuthorization,
  bindInstalledAuthorizationResult,
  type AssembleFailure,
} from "./assembly/assemble.ts";

export {
  accessPlanCovers,
  deriveAccessPlans,
  deriveRuleAccessPlan,
  missingAccessLookups,
  requireCompleteAccessPlan,
} from "./assembly/plan.ts";
