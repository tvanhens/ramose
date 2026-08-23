/**
 * Canonical structural keys for standing reads.
 *
 * The key is a deterministic serialization of the lowered query AST — the
 * same JSON that goes on the wire (`POST /db/:name/query`) — not a second
 * IR. Object keys are sorted so insertion order cannot fork the key.
 *
 * A params query keys as that AST with holes left in (`{$param: key}`) plus
 * {@link paramsKey}. An already-substituted / inline-value query keys as its
 * own AST. Both spellings go through one cache; they collide when the
 * lowered forms match.
 */

import { toJson } from "../internal/core/json.ts";
import { paramsKey } from "./Params.ts";
import { lowerQueryAst, type AnyQueryObject } from "./query/index.ts";

const astKeyMemo = new WeakMap<object, string>();
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

/**
 * Structural identity of a query: the lowered AST with param holes left
 * in place. Memoized on the query object — hoisted queries lower once;
 * a render-fresh object lowers again (small ASTs).
 */
export const queryAstKey = (query: AnyQueryObject): string => {
  const cached = astKeyMemo.get(query);
  if (cached !== undefined) return cached;
  let key: string;
  try {
    key = canonicalAstKey(lowerQueryAst(query));
  } catch {
    // Per-object token: two broken queries with the same message must not
    // share a retainLive entry. The WeakMap keeps the token stable per object.
    key = `\0error:${nextErrorKey++}`;
  }
  astKeyMemo.set(query, key);
  return key;
};

/**
 * Full live-subscription identity: `(viewKey, astKey[, paramsKey])`.
 * `viewKey` is {@link DbSeam.key}. An empty params record is omitted so a
 * no-params query and a future inline-value query that lower to the same
 * AST share one cache entry.
 */
export const liveSubscriptionKey = (
  viewKey: string,
  query: AnyQueryObject,
  params?: unknown,
): string => {
  const ast = queryAstKey(query);
  const p = paramsKey(params);
  return p === "" ? `${viewKey}\0${ast}` : `${viewKey}\0${ast}\0${p}`;
};
