/**
 * Canonical structural keys for standing reads.
 *
 * The key is a deterministic serialization of the **post-binding** lowered
 * query AST — the same JSON that goes on the wire (`POST /db/:name/query`)
 * — not a second IR. Object keys are sorted so insertion order cannot fork
 * the key. A params spelling and its inline equivalent share an entry when
 * the bound forms match; {@link paramsKey} is not part of the identity.
 *
 * `queryAstKey` is memoized on the query object when there are no bindings
 * (hoisted queries lower once; a render-fresh object lowers again). An
 * impure generator body (`Date.now()`, captured mutable state) is hidden
 * by that memo: the key freezes on first lower while `db.live` re-lowers
 * every pass. Dev-mode double-lowers at subscription setup
 * ({@link assertLoweringPurity}) and warns on mismatch; keep bodies pure.
 */

import { toJson } from "../internal/core/json.ts";
import { lowerQueryAst, lowerQueryObject, type AnyQueryObject } from "./query/index.ts";

const astKeyMemo = new WeakMap<object, string>();
const structureKeyMemo = new WeakMap<object, string>();
let nextErrorKey = 1;

/** Sort own keys at every object so `JSON.stringify` is canonical. */
const sortKeys = (v: unknown): unknown => {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
  return out;
};

/** Canonical JSON of a lowered query AST (or any JSON-shaped value). */
export const canonicalAstKey = (ast: unknown): string =>
  JSON.stringify(sortKeys(toJson(ast)));

const bindingsOf = (
  params?: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  if (params === undefined || params === null) return undefined;
  if (typeof params !== "object" || Array.isArray(params)) return undefined;
  return params as Readonly<Record<string, unknown>>;
};

const hasBindings = (params?: unknown): boolean => {
  const bound = bindingsOf(params);
  return bound !== undefined && Object.keys(bound).length > 0;
};

const ERROR_PREFIX = "\0error:";

/** Always compute a post-binding key — used by the purity guard. */
export const computeAstKey = (query: AnyQueryObject, params?: unknown): string => {
  try {
    return canonicalAstKey(lowerQueryObject(query, bindingsOf(params)).query);
  } catch {
    // Per-call token: two broken queries with the same message must not
    // share a retainLive entry.
    return `${ERROR_PREFIX}${nextErrorKey++}`;
  }
};

/**
 * Structural identity of a query: the post-binding lowered AST. Memoized
 * on the query object when there are no bindings — hoisted queries lower
 * once; a render-fresh object lowers again (small ASTs). Bindings re-lower
 * so a params spelling and its inline equivalent collide when the bound
 * forms match.
 */
export const queryAstKey = (query: AnyQueryObject, params?: unknown): string => {
  if (hasBindings(params)) return computeAstKey(query, params);
  const cached = astKeyMemo.get(query);
  if (cached !== undefined) return cached;
  const key = computeAstKey(query, params);
  astKeyMemo.set(query, key);
  return key;
};

/**
 * Holed / pre-binding AST — resetKeys and the churn warning watch this so a
 * params-only change does not blank rows or look like query-shape churn.
 * Becomes the same as {@link queryAstKey} once declared params go away.
 */
export const queryStructureKey = (query: AnyQueryObject): string => {
  const cached = structureKeyMemo.get(query);
  if (cached !== undefined) return cached;
  let key: string;
  try {
    key = canonicalAstKey(lowerQueryAst(query));
  } catch {
    key = `${ERROR_PREFIX}${nextErrorKey++}`;
  }
  structureKeyMemo.set(query, key);
  return key;
};

/**
 * Full live-subscription identity: `(viewKey, post-binding astKey)`.
 * `viewKey` is {@link DbSeam.key}. A params query and an already-substituted
 * / inline-value query share one cache entry when the bound forms match.
 */
export const liveSubscriptionKey = (
  viewKey: string,
  query: AnyQueryObject,
  params?: unknown,
): string => `${viewKey}\0${queryAstKey(query, params)}`;

const PURITY_WARNING =
  "ramose/react: query body is not pure — two lowerings produced different " +
  "ASTs. Generator bodies re-run on every lower; Date.now() or other impurity " +
  "keys the subscription on a stale AST (WeakMap memo). Keep the body deterministic.";

/**
 * Dev-mode: lower twice at subscription setup. The WeakMap memo hides an
 * impure body from the key (and from the churn warning); a mismatch here
 * is that footgun.
 */
export const assertLoweringPurity = (
  query: AnyQueryObject,
  params?: unknown,
): void => {
  const memoized = queryAstKey(query, params);
  const fresh = computeAstKey(query, params);
  if (
    memoized !== fresh &&
    !memoized.startsWith(ERROR_PREFIX) &&
    !fresh.startsWith(ERROR_PREFIX)
  ) {
    console.warn(PURITY_WARNING);
  }
};
