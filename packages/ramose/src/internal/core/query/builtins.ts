import { compareStrings } from "../datom.ts";

export type QueryFn = (...args: any[]) => unknown;

export function vkey(v: unknown): string {
  switch (typeof v) {
    case "number":
      return "n" + v;
    case "string":
      return "s" + v;
    case "boolean":
      return v ? "T" : "F";
    case "bigint":
      return "n" + Number(v);
    case "undefined":
      return "_";
    case "object": {
      if (v === null) return "_";
      if (v instanceof Date) return "d" + v.getTime();
      if (v instanceof Uint8Array) {
        let s = "y";
        for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
        return s;
      }
      const o = v as any;
      if ("vt" in o && "v" in o) return vkey(o.v);
      if (Array.isArray(v)) return "[" + v.map(vkey).join(",") + "]";
      return "o" + JSON.stringify(v);
    }
    default:
      return String(v);
  }
}

export function compareJs(a: unknown, b: unknown): number {
  if (a === b) return 0;
  const ta = rank(a), tb = rank(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  switch (ta) {
    case 1: {
      const x = a as number, y = b as number;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case 2:
      return compareStrings(a as string, b as string);
    case 3:
      return (a ? 1 : 0) - (b ? 1 : 0);
    case 4: {
      const x = (a as Date).getTime(), y = (b as Date).getTime();
      return x < y ? -1 : x > y ? 1 : 0;
    }
    default: {
      const x = vkey(a), y = vkey(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
  }
}
function rank(v: unknown): number {
  switch (typeof v) {
    case "number":
    case "bigint":
      return 1;
    case "string":
      return 2;
    case "boolean":
      return 3;
    case "object":
      if (v instanceof Date) return 4;
      if (v && "vt" in (v as any)) return rank((v as any).v);
      return 5;
    default:
      return 0;
  }
}

export interface SortKey {
  col: number;
  dir: 1 | -1;
  emptyLast: boolean;
}

export function sortKeys<T extends { dir: "asc" | "desc"; empty?: "first" | "last" }>(
  order: readonly T[],
  col: (o: T) => number,
): SortKey[] {
  return order.map((o) => ({ col: col(o), dir: o.dir === "desc" ? -1 : 1, emptyLast: o.empty !== "first" }));
}

export function compareCells(x: unknown, y: unknown, k: SortKey): number {
  const ex = x === null || x === undefined;
  const ey = y === null || y === undefined;
  return ex || ey ? (ex && ey ? 0 : (ex ? 1 : -1) * (k.emptyLast ? 1 : -1)) : compareJs(x, y) * k.dir;
}

export function sortRows(rows: unknown[][], keys: readonly SortKey[]): void {
  rows.sort((a, b) => {
    for (const k of keys) {
      const c = compareCells(a[k.col], b[k.col], k);
      if (c !== 0) return c;
    }
    return 0;
  });
}

function num(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "bigint") return Number(x);
  if (x instanceof Date) return x.getTime();
  throw new TypeError(`expected a number, got ${String(x)}`);
}

export const PREDICATES: Record<string, QueryFn> = {
  "=": (a, b) => vkey(a) === vkey(b),
  "==": (a, b) => vkey(a) === vkey(b),
  "!=": (a, b) => vkey(a) !== vkey(b),
  "not=": (a, b) => vkey(a) !== vkey(b),
  "<": (a, b) => compareJs(a, b) < 0,
  ">": (a, b) => compareJs(a, b) > 0,
  "<=": (a, b) => compareJs(a, b) <= 0,
  ">=": (a, b) => compareJs(a, b) >= 0,
  "even?": (a) => num(a) % 2 === 0,
  "odd?": (a) => num(a) % 2 !== 0,
  "zero?": (a) => num(a) === 0,
  "pos?": (a) => num(a) > 0,
  "neg?": (a) => num(a) < 0,
  "nil?": (a) => a === null || a === undefined,
  "some?": (a) => a !== null && a !== undefined,
  "true?": (a) => a === true,
  "false?": (a) => a === false,
  "string?": (a) => typeof a === "string",
  "number?": (a) => typeof a === "number",
  "boolean?": (a) => typeof a === "boolean",
  "starts-with?": (s, p) => String(s).startsWith(String(p)),
  "ends-with?": (s, p) => String(s).endsWith(String(p)),
  "includes?": (s, p) => String(s).includes(String(p)),
  "clojure.string/starts-with?": (s, p) => String(s).startsWith(String(p)),
  "clojure.string/ends-with?": (s, p) => String(s).endsWith(String(p)),
  "clojure.string/includes?": (s, p) => String(s).includes(String(p)),
  "clojure.string/blank?": (s) => s == null || String(s).trim() === "",
  "re-matches?": (re, s) => new RegExp("^(?:" + String(re) + ")$").test(String(s)),
  "re-find?": (re, s) => new RegExp(String(re)).test(String(s)),
};

export const FUNCTIONS: Record<string, QueryFn> = {
  "+": (...xs) => xs.reduce((a: number, b) => a + num(b), 0),
  "-": (a, ...xs) => (xs.length === 0 ? -num(a) : xs.reduce((acc: number, b) => acc - num(b), num(a))),
  "*": (...xs) => xs.reduce((a: number, b) => a * num(b), 1),
  "/": (a, ...xs) => xs.reduce((acc: number, b) => acc / num(b), num(a)),
  quot: (a, b) => Math.trunc(num(a) / num(b)),
  rem: (a, b) => num(a) % num(b),
  mod: (a, b) => ((num(a) % num(b)) + num(b)) % num(b),
  inc: (a) => num(a) + 1,
  dec: (a) => num(a) - 1,
  abs: (a) => Math.abs(num(a)),
  min: (...xs) => xs.reduce((a, b) => (compareJs(a, b) <= 0 ? a : b)),
  max: (...xs) => xs.reduce((a, b) => (compareJs(a, b) >= 0 ? a : b)),
  str: (...xs) => xs.map((x) => (x === null || x === undefined ? "" : x instanceof Date ? x.toISOString() : String(x))).join(""),
  subs: (s, start, end) => String(s).substring(num(start), end === undefined ? undefined : num(end)),
  "clojure.string/lower-case": (s) => String(s).toLowerCase(),
  "clojure.string/upper-case": (s) => String(s).toUpperCase(),
  "lower-case": (s) => String(s).toLowerCase(),
  "upper-case": (s) => String(s).toUpperCase(),
  "clojure.string/trim": (s) => String(s).trim(),
  trim: (s) => String(s).trim(),
  count: (x) => (typeof x === "string" || Array.isArray(x) ? x.length : x instanceof Set || x instanceof Map ? x.size : 0),
  identity: (x) => x,
  ground: (x) => x,
  vector: (...xs) => xs,
  tuple: (...xs) => xs,
  untuple: (x) => x,
  "re-find": (re, s) => {
    const m = new RegExp(String(re)).exec(String(s));
    return m ? (m.length === 1 ? m[0] : [...m]) : null;
  },
  "re-matches": (re, s) => {
    const m = new RegExp("^(?:" + String(re) + ")$").exec(String(s));
    return m ? (m.length === 1 ? m[0] : [...m]) : null;
  },
  "re-seq": (re, s) => [...String(s).matchAll(new RegExp(String(re), "g"))].map((m) => (m.length === 1 ? m[0] : [...m])),
  "clojure.string/split": (s, re) => String(s).split(new RegExp(String(re))),
  split: (s, re) => String(s).split(new RegExp(String(re))),
  "clojure.string/join": (sep, xs) => (Array.isArray(sep) ? sep.join("") : (xs as unknown[]).join(String(sep))),
  rand: (n?: unknown) => (n === undefined ? Math.random() : Math.random() * num(n)),
  "rand-int": (n) => Math.floor(Math.random() * num(n)),
  now: () => new Date(),
};

export type AggFn = (values: unknown[], ...consts: unknown[]) => unknown;

function sorted(values: unknown[]): unknown[] {
  return values.slice().sort(compareJs);
}
function nums(values: unknown[]): number[] {
  return values.map(num);
}

export const AGGREGATES: Record<string, AggFn> = {
  count: (vs) => vs.length,
  "count-distinct": (vs) => new Set(vs.map(vkey)).size,
  sum: (vs) => nums(vs).reduce((a, b) => a + b, 0),
  avg: (vs) => (vs.length ? nums(vs).reduce((a, b) => a + b, 0) / vs.length : null),
  min: (vs, n?) => (n === undefined ? (vs.length ? sorted(vs)[0] : null) : distinctSorted(vs).slice(0, num(n))),
  max: (vs, n?) =>
    n === undefined ? (vs.length ? sorted(vs)[vs.length - 1] : null) : distinctSorted(vs).slice(-num(n)).reverse(),
  median: (vs) => {
    if (!vs.length) return null;
    const s = nums(vs).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  },
  variance: (vs) => {
    if (!vs.length) return null;
    const ns = nums(vs);
    const mean = ns.reduce((a, b) => a + b, 0) / ns.length;
    return ns.reduce((a, b) => a + (b - mean) ** 2, 0) / ns.length;
  },
  stddev: (vs) => {
    if (!vs.length) return null;
    const ns = nums(vs);
    const mean = ns.reduce((a, b) => a + b, 0) / ns.length;
    return Math.sqrt(ns.reduce((a, b) => a + (b - mean) ** 2, 0) / ns.length);
  },
  distinct: (vs) => distinctSorted(vs),
  sample: (vs, n) => shuffle(distinctSorted(vs)).slice(0, num(n)),
  rand: (vs, n) => Array.from({ length: num(n) }, () => vs[Math.floor(Math.random() * vs.length)]),
};

function distinctSorted(vs: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of sorted(vs)) {
    const k = vkey(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}
function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}
