/**
 * Static bounds for the initial authorization language and leases.
 * Structural decoding (#357) enforces JSON-tree bounds. Semantic
 * validation (#358) and the evaluator enforce language bounds again.
 */

/** LANG-2: typed fixed-depth ref traversal. Validated again at install. */
export const MAX_TRAVERSAL_DEPTH = 3;

/** Explicit work budget so a valid policy cannot scan unboundedly. */
export const DEFAULT_AUTHORIZATION_BUDGET = 10_000;

/** REV-1: a read authorization lease lasts at most five seconds. */
export const MAX_READ_LEASE_MS = 5_000;

/** Hostile-input ceiling for object/array nesting at the trust boundary. */
export const MAX_JSON_DEPTH = 64;

/** Hostile-input ceiling for arrays and object key counts. */
export const MAX_COLLECTION_SIZE = 1_024;

/** Hostile-input ceiling for JSON string literals and identity strings. */
export const MAX_STRING_LENGTH = 4_096;

/**
 * Global work ceiling: every JSON value and every object key counts as one
 * node. Per-collection and depth limits do not bound a broad tree.
 */
export const MAX_JSON_NODES = 4_096;

/**
 * Global encoded-size ceiling in UTF-8 bytes across string values, object
 * keys, and number literals. Combined with {@link MAX_JSON_NODES} this
 * bounds traversal, canonicalization, and hashing work.
 */
export const MAX_JSON_ENCODED_BYTES = 65_536;

export type AuthorizationBudget = {
  readonly limit: number;
  readonly spent: number;
};
