/**
 * Static bounds for the initial authorization language and leases.
 * Semantic validation (#358) and the evaluator enforce these again.
 */

/** LANG-2: typed fixed-depth ref traversal. Validated again at install. */
export const MAX_TRAVERSAL_DEPTH = 3;

/** Nested `exists` is bounded; same-entity self-joins are not recursion. */
export const MAX_EXISTS_DEPTH = 3;

/** Explicit work budget so a valid policy cannot scan unboundedly. */
export const DEFAULT_AUTHORIZATION_BUDGET = 10_000;

/** REV-1: a read authorization lease lasts at most five seconds. */
export const MAX_READ_LEASE_MS = 5_000;

export type AuthorizationBudget = {
  readonly limit: number;
  readonly spent: number;
};
