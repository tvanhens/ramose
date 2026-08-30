/**
 * Pure implementations for the v1 expression standard library (#507).
 *
 * This module is deliberately *not* re-exported from the package barrel: a
 * public name resolves to a card, and only the registry can reach the code
 * behind it. Nothing here is an alias of an engine function, so a public name
 * can never be used to name or probe internal machinery.
 *
 * Every implementation is a total function of its arguments alone. No clock,
 * no randomness, no environment, no filesystem, no network, no mutation of an
 * argument, no lambda parameters, no recursion into user input, and no
 * caller-supplied regex. Arity, declared argument types, and `propagate` null
 * handling are enforced by the registry before an implementation runs, so the
 * casts below are checked facts rather than assumptions.
 */

import type { StdlibImplementation, StdlibValue } from "./types.ts";
import {
  canonicalKey,
  clampIndex,
  codePoints,
  deepEquals,
  isTimestamp,
} from "./values.ts";

const bool = (args: readonly StdlibValue[], index: number): boolean | null =>
  args[index] as boolean | null;
const num = (args: readonly StdlibValue[], index: number): number =>
  args[index] as number;
const txt = (args: readonly StdlibValue[], index: number): string =>
  args[index] as string;
const coll = (
  args: readonly StdlibValue[],
  index: number,
): readonly StdlibValue[] => args[index] as readonly StdlibValue[];

/** Round half away from zero, so `-1.5` and `1.5` are symmetric. */
const roundHalfAwayFromZero = (value: number): number =>
  value < 0 ? -Math.round(-value) : Math.round(value);

/** Code-point index of `needle` in `value`, or `-1`. Empty needle is `0`. */
const codePointIndexOf = (value: string, needle: string): number => {
  if (needle.length === 0) return 0;
  const unitIndex = value.indexOf(needle);
  if (unitIndex < 0) return -1;
  return codePoints(value.slice(0, unitIndex)).length;
};

/**
 * The public v1 allowlist, keyed by stable public name.
 *
 * Kept in the same order as the manifest so the two read as one table; the
 * integrity check proves the correspondence rather than trusting the order.
 */
export const standardLibraryImplementationsV1: {
  readonly [name: string]: StdlibImplementation;
} = {
  // ── logic ────────────────────────────────────────────────────────────────
  // The connectives are Kleene three-valued: `null` means unknown, and a
  // known argument that already decides the result wins over an unknown one.
  "logic.and": (args) => {
    const a = bool(args, 0);
    const b = bool(args, 1);
    if (a === false || b === false) return false;
    if (a === true && b === true) return true;
    return null;
  },
  "logic.or": (args) => {
    const a = bool(args, 0);
    const b = bool(args, 1);
    if (a === true || b === true) return true;
    if (a === false && b === false) return false;
    return null;
  },
  "logic.not": (args) => {
    const a = bool(args, 0);
    return a === null ? null : !a;
  },
  "logic.eq": (args) => deepEquals(args[0], args[1]),
  "logic.ne": (args) => !deepEquals(args[0], args[1]),
  "logic.isNull": (args) => args[0] === null,
  "logic.coalesce": (args) => (args[0] === null ? args[1] : args[0]),
  "logic.if": (args) => (args[0] === true ? args[1] : args[2]),

  // ── number ───────────────────────────────────────────────────────────────
  // A result that overflows to a non-finite number is `null`, not `Infinity`:
  // the registry re-checks every numeric result against the declared type.
  "number.add": (args) => num(args, 0) + num(args, 1),
  "number.subtract": (args) => num(args, 0) - num(args, 1),
  "number.multiply": (args) => num(args, 0) * num(args, 1),
  "number.divide": (args) => {
    const divisor = num(args, 1);
    return divisor === 0 ? null : num(args, 0) / divisor;
  },
  "number.abs": (args) => Math.abs(num(args, 0)),
  "number.negate": (args) => -num(args, 0),
  "number.min": (args) => Math.min(num(args, 0), num(args, 1)),
  "number.max": (args) => Math.max(num(args, 0), num(args, 1)),
  "number.round": (args) => roundHalfAwayFromZero(num(args, 0)),
  "number.floor": (args) => Math.floor(num(args, 0)),
  "number.ceil": (args) => Math.ceil(num(args, 0)),
  "number.gt": (args) => num(args, 0) > num(args, 1),
  "number.gte": (args) => num(args, 0) >= num(args, 1),
  "number.lt": (args) => num(args, 0) < num(args, 1),
  "number.lte": (args) => num(args, 0) <= num(args, 1),
  "number.toText": (args) => String(num(args, 0)),
  "number.parse": (args) => {
    // A fixed JSON-number grammar, not a caller-supplied pattern: no
    // whitespace, no sign-only text, no hex, no `Infinity`, no `NaN`.
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(txt(args, 0))) {
      return null;
    }
    const parsed = Number(txt(args, 0));
    return Number.isFinite(parsed) ? parsed : null;
  },

  // ── text ─────────────────────────────────────────────────────────────────
  // Case mapping is the locale-independent Unicode default mapping, and every
  // index and length is measured in code points.
  "text.lower": (args) => txt(args, 0).toLowerCase(),
  "text.upper": (args) => txt(args, 0).toUpperCase(),
  "text.trim": (args) => txt(args, 0).trim(),
  "text.length": (args) => codePoints(txt(args, 0)).length,
  "text.concat": (args) => txt(args, 0) + txt(args, 1),
  "text.contains": (args) => txt(args, 0).includes(txt(args, 1)),
  "text.startsWith": (args) => txt(args, 0).startsWith(txt(args, 1)),
  "text.endsWith": (args) => txt(args, 0).endsWith(txt(args, 1)),
  "text.equalsIgnoreCase": (args) =>
    txt(args, 0).toLowerCase() === txt(args, 1).toLowerCase(),
  "text.compare": (args) => {
    const a = txt(args, 0);
    const b = txt(args, 1);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  },
  "text.slice": (args) => {
    const points = codePoints(txt(args, 0));
    const start = clampIndex(num(args, 1), points.length);
    const end = clampIndex(num(args, 2), points.length);
    return end <= start ? "" : points.slice(start, end).join("");
  },
  "text.indexOf": (args) => codePointIndexOf(txt(args, 0), txt(args, 1)),
  "text.replace": (args) => {
    const search = txt(args, 1);
    // An empty search would match at every position; returning the input
    // keeps the function total and its output bounded by its input.
    if (search.length === 0) return txt(args, 0);
    // `split`/`join` rather than `replaceAll`: the replacement is a literal,
    // never a `$&`-style pattern the caller could use to amplify output.
    return txt(args, 0).split(search).join(txt(args, 2));
  },
  "text.split": (args) => {
    const separator = txt(args, 1);
    // An empty separator would fan one value out into one element per code
    // point. v1 returns the whole value instead; splitting into characters
    // can be added later as its own named function.
    if (separator.length === 0) return [txt(args, 0)];
    return txt(args, 0).split(separator);
  },
  "text.join": (args) => {
    const items = coll(args, 0);
    const parts: string[] = [];
    for (const item of items) {
      if (typeof item !== "string") return null;
      parts.push(item);
    }
    return parts.join(txt(args, 1));
  },

  // ── collection ───────────────────────────────────────────────────────────
  "collection.size": (args) => coll(args, 0).length,
  "collection.isEmpty": (args) => coll(args, 0).length === 0,
  "collection.contains": (args) => {
    if (args[0] === null) return null;
    const items = coll(args, 0);
    for (const item of items) {
      if (deepEquals(item, args[1])) return true;
    }
    return false;
  },
  "collection.first": (args) => {
    const items = coll(args, 0);
    return items.length === 0 ? null : items[0];
  },
  "collection.last": (args) => {
    const items = coll(args, 0);
    return items.length === 0 ? null : items[items.length - 1];
  },
  "collection.at": (args) => {
    const items = coll(args, 0);
    const index = num(args, 1);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) return null;
    return items[index];
  },
  "collection.distinct": (args) => {
    const seen = new Set<string>();
    const out: StdlibValue[] = [];
    for (const item of coll(args, 0)) {
      const key = canonicalKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  },
  "collection.slice": (args) => {
    const items = coll(args, 0);
    const start = clampIndex(num(args, 1), items.length);
    const end = clampIndex(num(args, 2), items.length);
    return end <= start ? [] : items.slice(start, end);
  },
  "collection.concat": (args) => [...coll(args, 0), ...coll(args, 1)],

  // ── time ─────────────────────────────────────────────────────────────────
  // Timestamps arrive only as constants, explicit parameters, or already
  // bound values. There is no implicit clock, so a query's meaning does not
  // change between a retry and the page that follows it.
  "time.before": (args) => num(args, 0) < num(args, 1),
  "time.after": (args) => num(args, 0) > num(args, 1),
  "time.addMillis": (args) => {
    const millis = num(args, 1);
    if (!Number.isSafeInteger(millis)) return null;
    const shifted = num(args, 0) + millis;
    return isTimestamp(shifted) ? shifted : null;
  },
  "time.diffMillis": (args) => num(args, 1) - num(args, 0),
};
