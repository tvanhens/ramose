/**
 * Canonical structural keys for standing reads.
 *
 * The key is a deterministic serialization of the lowered query AST — the
 * same JSON that goes on the wire (`POST /db/:name/query`) — not a second
 * IR. Object keys are sorted so insertion order cannot fork the key.
 * Pull patterns use the same canonical JSON of `lowerPullPattern`, plus
 * a client-only `optional` marker — optionality is applied by
 * `reshapePullResult` and never reaches the wire.
 *
 * `queryAstKey` is memoized on the query object (hoisted queries lower
 * once; a render-fresh object lowers again). An impure generator body
 * (`Date.now()`, captured mutable state) is hidden by that memo: the key
 * freezes on first lower while `db.live` re-lowers every pass. Dev-mode
 * double-lowers at subscription setup ({@link assertLoweringPurity}) and
 * warns on mismatch; keep bodies pure. `pullPatternKey` memos the same
 * way so a hoisted shape lowers once.
 */

import { toJson } from "../internal/core/json.ts";
import {
  inspectPullField,
  isAgain,
  isAllShape,
  lowerPullPattern,
} from "./Pull.ts";
import { lowerQueryObject, type AnyQueryObject } from "./query/index.ts";

const astKeyMemo = new WeakMap<object, string>();
const pullKeyMemo = new WeakMap<object, string>();

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

const ERROR_PREFIX = "\0error:";

/** Always compute a key — used by the purity guard. */
export const computeAstKey = (query: AnyQueryObject): string => {
  try {
    return canonicalAstKey(lowerQueryObject(query).query);
  } catch (e) {
    // Render-fresh inline construction is the documented spelling. A
    // per-call token would change the hook key every render and loop
    // (teardown → InvalidRequest → setState → re-render). Key on the
    // message so two independently built queries with the same failure
    // share a subscription, the same as a successful AST.
    const message = e instanceof Error ? e.message : String(e);
    return `${ERROR_PREFIX}${message}`;
  }
};

/**
 * Structural identity of a query: the lowered AST. Memoized on the query
 * object — hoisted queries lower once; a render-fresh object lowers again
 * (small ASTs).
 */
export const queryAstKey = (query: AnyQueryObject): string => {
  const cached = astKeyMemo.get(query);
  if (cached !== undefined) return cached;
  const key = computeAstKey(query);
  astKeyMemo.set(query, key);
  return key;
};

/**
 * Same as {@link queryAstKey}. Kept so resetKeys / the churn warning keep
 * a stable name for "the query half of the subscription identity".
 */
export const queryStructureKey = (query: AnyQueryObject): string =>
  queryAstKey(query);

/**
 * Lowered peer shape plus a client-only `optional` flag. `.optional` is
 * applied by `reshapePullResult` and never emitted by `lowerPullPattern`,
 * so two maps that differ only there would otherwise share a key and
 * a suspense slot while producing different `data`.
 */
const withOptionalMarkers = (pattern: unknown): unknown => {
  if (isAgain(pattern) || isAllShape(pattern) || Array.isArray(pattern)) {
    return lowerPullPattern(pattern);
  }
  if (typeof pattern !== "object" || pattern === null) {
    return lowerPullPattern(pattern);
  }
  const lowered = lowerPullPattern(pattern);
  if (!Array.isArray(lowered)) return lowered;
  const fields = Object.entries(pattern as Record<string, unknown>);
  return lowered.map((spec, i) => {
    const field = fields[i]?.[1];
    if (field === undefined || spec === null || typeof spec !== "object") {
      return spec;
    }
    const info = inspectPullField(field);
    const out: Record<string, unknown> = {
      ...(spec as Record<string, unknown>),
    };
    if (info.optional) out.optional = true;
    if (info.nestedPattern !== undefined && "sub" in out) {
      out.sub = withOptionalMarkers(info.nestedPattern);
    }
    return out;
  });
};

/** Always compute a pull-pattern key — used when the object is new. */
export const computePullPatternKey = (pattern: unknown): string => {
  try {
    return canonicalAstKey(withOptionalMarkers(pattern));
  } catch (e) {
    // Same rule as {@link computeAstKey}: a per-call token would change
    // the suspend key every retry render and hot-loop. Key on the
    // message so two independently built failures share a slot.
    const message = e instanceof Error ? e.message : String(e);
    return `${ERROR_PREFIX}${message}`;
  }
};

/**
 * Structural identity of a pull pattern: the lowered peer shape plus
 * client-only `.optional` markers. Memoized on the pattern object —
 * hoisted shapes lower once; a render-fresh `{ title: Todo.title }`
 * lowers again (small).
 */
export const pullPatternKey = (pattern: unknown): string => {
  if (typeof pattern === "object" && pattern !== null) {
    const cached = pullKeyMemo.get(pattern);
    if (cached !== undefined) return cached;
    const key = computePullPatternKey(pattern);
    pullKeyMemo.set(pattern, key);
    return key;
  }
  return computePullPatternKey(pattern);
};

/**
 * Full live-subscription identity: `(viewKey, astKey)`.
 * `viewKey` is {@link DbSeam.key}.
 */
export const liveSubscriptionKey = (
  viewKey: string,
  query: AnyQueryObject,
): string => `${viewKey}\0${queryAstKey(query)}`;

const PURITY_WARNING =
  "ramose/react: query body is not pure — two lowerings produced different " +
  "ASTs. Generator bodies re-run on every lower; Date.now() or other impurity " +
  "keys the subscription on a stale AST (WeakMap memo). Keep the body deterministic.";

/**
 * Dev-mode: lower twice at subscription setup. The WeakMap memo hides an
 * impure body from the key (and from the churn warning); a mismatch here
 * is that footgun.
 */
export const assertLoweringPurity = (query: AnyQueryObject): void => {
  const memoized = queryAstKey(query);
  const fresh = computeAstKey(query);
  if (
    memoized !== fresh &&
    !memoized.startsWith(ERROR_PREFIX) &&
    !fresh.startsWith(ERROR_PREFIX)
  ) {
    console.warn(PURITY_WARNING);
  }
};
