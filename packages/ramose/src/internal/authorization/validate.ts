/**
 * Semantic validation kernel public surface.
 *
 * Implementation lives in {@link ./validation/validate.ts} and its
 * dependency-directed modules. This file re-exports the orchestration API
 * so existing internal imports stay stable.
 */

export {
  defaultValidationLimits,
  validateBoundAuthorization,
  validateBoundAuthorizationResult,
  validateBoundAuthorizationResultForTest,
  type ValidateFailure,
  type ValidationLimits,
} from "./validation/validate.ts";

export {
  prepareAuthorizationCatalog,
  type PreparedAuthorizationCatalog,
} from "./validation/catalog.ts";
