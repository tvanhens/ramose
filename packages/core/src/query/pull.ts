/**
 * Pull: declarative, nested entity projection.
 *
 *   [*]                                     every attribute (+ :db/id); refs as {:db/id n}
 *   [:user/name :user/email]                selected attributes
 *   [{:user/friends [:user/name]}]          nested pull through refs
 *   [:user/_friends]                        reverse refs (entities pointing here)
 *   [(:user/name :as "name") (limit :user/friends 5) (default :user/age 0)]
 *   [{:user/friends ...}]                    recursive (cycle-safe), or a depth number
 *
 * A cardinality-many attribute (forward ref, backlink or scalar) may also
 * carry `where` / `order` / `offset` / `limit` — see {@link PullElemPred}.
 * They run in that order, on the collection only: a nested collection that
 * filters to nothing is omitted (or takes its `default`); it never removes the
 * entity the pull is rooted at, so an outer `:limit` still returns its rows.
 */

import { type Datom, Index, ValueTag } from "../datom.ts";
import { Db, datomJsValue } from "../db.ts";
import type { PullAttrSpec, PullElemOp, PullElemOrder, PullElemPred, PullPattern } from "./ast.ts";
import { PREDICATES, compareJs, sortKeys, sortRows, vkey } from "./builtins.ts";
import { parsePullPattern } from "./parse.ts";

const DEFAULT_LIMIT = 1000;

export async function pull(db: Db, eid: number, pattern: PullPattern | string | unknown[]): Promise<Record<string, unknown> | null> {
  const pat = normalizePattern(pattern);
  return pullOne(db, eid, pat, new Map());
}

export async function pullMany(
  db: Db,
  eids: readonly number[],
  pattern: PullPattern | string | unknown[],
): Promise<(Record<string, unknown> | null)[]> {
  const pat = normalizePattern(pattern);
  const cache = new Map<string, Record<string, unknown> | null>();
  const out: (Record<string, unknown> | null)[] = [];
  for (const e of eids) out.push(await pullOne(db, e, pat, cache));
  return out;
}

function normalizePattern(p: PullPattern | string | unknown[]): PullPattern {
  if (typeof p === "string") return parsePullPattern(p);
  if (Array.isArray(p) && p.length > 0 && typeof p[0] === "object" && p[0] !== null && "kind" in (p[0] as any)) return p as PullPattern;
  return parsePullPattern(p);
}

async function pullOne(
  db: Db,
  eid: number,
  pattern: PullPattern,
  cache: Map<string, Record<string, unknown> | null>,
  path: Set<number> = new Set(),
  depthLeft: Map<string, number> = new Map(),
): Promise<Record<string, unknown> | null> {
  if (typeof eid !== "number") return null;
  const key = eid + "|" + patternKey(pattern) + "|" + [...depthLeft].join(",");
  if (path.size === 0 && cache.has(key)) return cache.get(key)!;
  const datoms = await db.datomsArray(Index.EAVT, { e: eid });
  const hasWildcard = pattern.some((s) => s.kind === "wildcard");
  const result: Record<string, unknown> = {};
  let any = false;

  if (hasWildcard) {
    result[":db/id"] = eid;
    any = datoms.length > 0;
    for (const d of datoms) {
      const attr = db.attr(d.a);
      const name = attr?.ident ?? String(d.a);
      const val = d.vt === ValueTag.Ref ? { ":db/id": d.v } : datomJsValue(d);
      if (attr?.cardinality === "many") ((result[name] ??= []) as unknown[]).push(val);
      else result[name] = val;
    }
  }

  const nextPath = new Set(path).add(eid);
  for (const spec of pattern) {
    if (spec.kind === "wildcard") continue;
    if (spec.attr === ":db/id") {
      result[spec.as ?? ":db/id"] = eid;
      any = any || datoms.length > 0;
      continue;
    }
    const attr = db.attr(spec.attr);
    if (!attr) continue; // unknown attribute → omitted (Datomic throws; be lenient)
    const outName = spec.as ?? (spec.reverse ? reverseName(spec.attr) : spec.attr);
    const limit = spec.limit === undefined ? DEFAULT_LIMIT : spec.limit; // null → unlimited

    // recursion handling
    let subPattern: PullPattern | undefined = spec.sub;
    let nextDepth = depthLeft;
    if (spec.recursion !== undefined) {
      const dkey = spec.attr + (spec.reverse ? "_r" : "");
      const remaining = depthLeft.get(dkey);
      if (spec.recursion !== "..." && remaining === undefined) {
        nextDepth = new Map(depthLeft).set(dkey, spec.recursion - 1);
        if (spec.recursion <= 0) subPattern = undefined;
        else subPattern = pattern;
      } else if (spec.recursion !== "...") {
        if (remaining! <= 0) {
          subPattern = undefined;
        } else {
          nextDepth = new Map(depthLeft).set(dkey, remaining! - 1);
          subPattern = pattern;
        }
      } else {
        subPattern = pattern;
      }
      if (spec.recursion !== "..." && subPattern === undefined) {
        // depth exhausted: emit refs as {:db/id}
      }
    }

    // Collect the whole collection first, then filter → order → offset →
    // limit, and only then resolve the survivors: `limit` must count the
    // elements `where`/`order` kept, not the head of the index.
    let elems: Elem[];
    let cardMany: boolean;
    if (!spec.reverse) {
      const ds = datoms.filter((d) => d.a === attr.id);
      cardMany = attr.cardinality === "many";
      elems = ds.map((d) => (d.vt === ValueTag.Ref ? { datom: d, eid: d.v as number, value: d.v } : { datom: d, value: datomJsValue(d) }));
    } else {
      if (attr.valueType !== ValueTag.Ref) continue;
      const ds = await db.datomsArray(Index.VAET, { vt: ValueTag.Ref, v: eid, a: attr.id });
      cardMany = !attr.isComponent;
      elems = ds.map((d) => ({ datom: d, eid: d.e, value: d.e }));
    }
    if (spec.where?.length) elems = await filterElems(db, elems, spec.where);
    if (spec.order?.length) elems = await orderElems(db, elems, spec.order);
    const from = spec.offset ?? 0;
    if (from > 0) elems = elems.slice(from);
    if (limit !== null && elems.length > limit) elems = elems.slice(0, limit);

    let vals: unknown[] = [];
    for (const el of elems) {
      if (!spec.reverse) {
        vals.push(await refOrValue(db, el.datom!, subPattern, cache, nextPath, nextDepth, spec.recursion !== undefined));
        continue;
      }
      const other = el.eid!;
      if (subPattern) {
        if (nextPath.has(other) && spec.recursion !== undefined) {
          vals.push({ ":db/id": other });
        } else {
          const sub = await pullOne(db, other, subPattern, cache, nextPath, nextDepth);
          if (sub) vals.push(sub);
        }
      } else vals.push({ ":db/id": other });
    }
    vals = vals.filter((v) => v !== null && v !== undefined);
    if (vals.length === 0) {
      if (spec.default !== undefined) {
        result[outName] = spec.default;
        any = true;
      }
      continue;
    }
    any = true;
    result[outName] = cardMany ? vals : vals[0];
  }
  const res = any ? result : null;
  if (path.size === 0) cache.set(key, res);
  return res;
}

// --- nested collections: where / order --------------------------------------

/**
 * One element of a cardinality-many collection, before it is resolved into the
 * pull result: the datom it came from, the entity `where`/`order` paths walk
 * from (a ref target, or the referring entity of a backlink), and the value a
 * zero-length path compares — the scalar itself, or the entity id for a ref.
 */
interface Elem {
  /** absent on a sub-element a quantifier's path reached, which is no datom */
  datom?: Datom;
  eid?: number;
  value: unknown;
}

/** `op(elementValue, spec.value)` for every operator that takes an operand. */
const ELEM_OPS: Record<Exclude<PullElemOp, "exists" | "missing">, (v: unknown, arg: unknown) => boolean> = {
  "=": (v, x) => vkey(v) === vkey(x),
  "!=": (v, x) => vkey(v) !== vkey(x),
  "<": (v, x) => compareJs(v, x) < 0,
  "<=": (v, x) => compareJs(v, x) <= 0,
  ">": (v, x) => compareJs(v, x) > 0,
  ">=": (v, x) => compareJs(v, x) >= 0,
  in: (v, xs) => (Array.isArray(xs) ? xs.some((x) => vkey(x) === vkey(v)) : false),
  "starts-with?": (v, x) => PREDICATES["starts-with?"](v, x) as boolean,
  "ends-with?": (v, x) => PREDICATES["ends-with?"](v, x) as boolean,
  "includes?": (v, x) => PREDICATES["includes?"](v, x) as boolean,
  // the engine's regex predicates take the pattern first
  "re-find?": (v, x) => PREDICATES["re-find?"](x, v) as boolean,
  "re-matches?": (v, x) => PREDICATES["re-matches?"](x, v) as boolean,
};

/**
 * Every value `path` reaches from `el`. An empty path is the element itself; a
 * hop that lands on several values fans out (so a predicate over the result is
 * existential), and `:db/id` is the current entity id.
 */
async function elemValues(db: Db, el: Elem, path: readonly string[], reverse: readonly boolean[] | undefined): Promise<unknown[]> {
  if (path.length === 0) return el.value === undefined || el.value === null ? [] : [el.value];
  let current: unknown[] = el.eid === undefined ? [] : [el.eid];
  for (let i = 0; i < path.length && current.length > 0; i++) {
    const ident = path[i];
    const next: unknown[] = [];
    if (ident === ":db/id") {
      for (const e of current) if (typeof e === "number") next.push(e);
    } else {
      const a = db.attr(ident);
      if (a === undefined) return [];
      for (const e of current) {
        if (typeof e !== "number") continue;
        if (reverse?.[i]) {
          if (a.valueType !== ValueTag.Ref) continue;
          for (const d of await db.datomsArray(Index.VAET, { vt: ValueTag.Ref, v: e, a: a.id })) next.push(d.e);
        } else {
          for (const d of await db.datomsArray(Index.EAVT, { e, a: a.id })) next.push(d.vt === ValueTag.Ref ? d.v : datomJsValue(d));
        }
      }
    }
    current = next;
  }
  return current;
}

/**
 * The elements one quantified hop reaches, each as an element in its own
 * right: an entity when the hop lands on refs (so the sub-predicate can walk
 * on), the value itself when it lands on scalars (so `path: []` compares it).
 */
async function elemsAt(db: Db, el: Elem, path: readonly string[], reverse: readonly boolean[] | undefined): Promise<Elem[]> {
  const vals = await elemValues(db, el, path, reverse);
  const last = path.length - 1;
  const entity =
    path.length === 0 ? el.eid !== undefined : path[last] === ":db/id" || reverse?.[last] === true || db.attr(path[last])?.valueType === ValueTag.Ref;
  return vals.map((v) => (entity && typeof v === "number" ? { eid: v, value: v } : { value: v }));
}

async function testElem(db: Db, el: Elem, p: PullElemPred): Promise<boolean> {
  if ("and" in p) {
    for (const q of p.and) if (!(await testElem(db, el, q))) return false;
    return true;
  }
  if ("or" in p) {
    for (const q of p.or) if (await testElem(db, el, q)) return true;
    return false;
  }
  if ("not" in p) return !(await testElem(db, el, p.not));
  if ("every" in p) {
    // no reached element fails — and nothing fails when nothing is reached
    for (const sub of await elemsAt(db, el, p.every.path, p.every.reverse)) {
      if (!(await testElem(db, sub, p.every.pred))) return false;
    }
    return true;
  }
  if ("some" in p) {
    for (const sub of await elemsAt(db, el, p.some.path, p.some.reverse)) {
      if (await testElem(db, sub, p.some.pred)) return true;
    }
    return false;
  }
  const vals = await elemValues(db, el, p.path, p.reverse);
  if (p.op === "exists") return vals.length > 0;
  if (p.op === "missing") return vals.length === 0;
  const f = ELEM_OPS[p.op];
  if (!f) throw new Error(`unknown pull :where op ${String(p.op)}`);
  return vals.some((v) => f(v, p.value));
}

async function filterElems(db: Db, elems: Elem[], where: readonly PullElemPred[]): Promise<Elem[]> {
  const out: Elem[] = [];
  outer: for (const el of elems) {
    for (const p of where) if (!(await testElem(db, el, p))) continue outer;
    out.push(el);
  }
  return out;
}

/** Sort by the same rules as the query's `:order` — see {@link sortRows}. */
async function orderElems(db: Db, elems: Elem[], order: readonly PullElemOrder[]): Promise<Elem[]> {
  const rows: unknown[][] = [];
  for (let i = 0; i < elems.length; i++) {
    const row: unknown[] = [];
    for (const o of order) {
      const vals = await elemValues(db, elems[i], o.path, o.reverse);
      row.push(vals.length ? vals[0] : undefined);
    }
    row.push(i);
    rows.push(row);
  }
  sortRows(rows, sortKeys(order.map((o, col) => ({ ...o, col })), (o) => o.col));
  return rows.map((r) => elems[r[order.length] as number]);
}

async function refOrValue(
  db: Db,
  d: Datom,
  sub: PullPattern | undefined,
  cache: Map<string, Record<string, unknown> | null>,
  path: Set<number>,
  depth: Map<string, number>,
  recursive: boolean,
): Promise<unknown> {
  if (d.vt !== ValueTag.Ref) return datomJsValue(d);
  const target = d.v as number;
  if (!sub) return { ":db/id": target };
  if (recursive && path.has(target)) return { ":db/id": target }; // cycle
  const r = await pullOne(db, target, sub, cache, path, depth);
  return r ?? { ":db/id": target };
}

function reverseName(attr: string): string {
  const slash = attr.lastIndexOf("/");
  return slash >= 0 ? attr.slice(0, slash + 1) + "_" + attr.slice(slash + 1) : ":_" + attr.slice(1);
}

function patternKey(p: PullPattern): string {
  return JSON.stringify(p);
}

export function normalizePullPattern(p: unknown): PullPattern {
  return normalizePattern(p as any);
}

export type { PullAttrSpec };
