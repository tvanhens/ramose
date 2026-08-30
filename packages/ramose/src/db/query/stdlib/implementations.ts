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
 * caller-supplied regex. Arity, declared argument types, well-formedness of
 * text, and `propagate` null handling are enforced by the registry before an
 * implementation runs, so the casts below are checked facts rather than
 * assumptions.
 *
 * Nothing here reads a host Unicode table. Case mapping and whitespace are
 * pinned in `./values.ts`, because those tables move with the engine's
 * Unicode version and a v1 document must mean the same thing on Bun, on
 * workerd, and on workerd after a runtime upgrade.
 *
 * Output size is bounded before allocation wherever a call can produce more
 * than the sum of its inputs — `text.concat`, `text.replace` and `text.join`
 * — by computing the exact result length first and returning
 * {@link OUTPUT_TOO_LARGE} instead. The rest cannot amplify: `text.split`,
 * `collection.slice` and `collection.distinct` are bounded by their input,
 * `collection.concat` by the sum of its two, and `number.toText` by a fixed
 * maximum. Milestone 2's runtime budget accounting subsumes this static cap.
 */

import { OUTPUT_TOO_LARGE, type StdlibImplementation, type StdlibValue } from "./types.ts";
import {
  MAX_PRODUCED_TEXT_UNITS,
  asciiLower,
  asciiUpper,
  canonicalKey,
  clampIndex,
  codePoints,
  deepEquals,
  isTimestamp,
  trimPinned,
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

/**
 * Code-point index of `needle` in `value`, or `-1`. Empty needle is `0`.
 *
 * Safe to translate a code-unit offset into a code-point index because both
 * arguments are well-formed Unicode by the time an implementation runs. In a
 * well-formed string every low surrogate is preceded by its high surrogate,
 * so a well-formed needle can neither begin nor end inside a pair, and every
 * match therefore lands on a code-point boundary. Ill-formed text is not a
 * value of the domain and never reaches here.
 */
const codePointIndexOf = (value: string, needle: string): number => {
  if (needle.length === 0) return 0;
  const unitIndex = value.indexOf(needle);
  if (unitIndex < 0) return -1;
  return codePoints(value.slice(0, unitIndex)).length;
};

/** Count non-overlapping left-to-right occurrences without allocating. */
const occurrences = (value: string, search: string): number => {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = value.indexOf(search, from);
    if (at < 0) return count;
    count += 1;
    from = at + search.length;
  }
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
  // Case mapping and whitespace are pinned in `./values.ts` rather than taken
  // from the host, whose Unicode tables move with its version. Every index
  // and length is measured in code points, which is well defined because
  // ill-formed text is rejected before an implementation runs.
  "text.lower": (args) => asciiLower(txt(args, 0)),
  "text.upper": (args) => asciiUpper(txt(args, 0)),
  "text.trim": (args) => trimPinned(txt(args, 0)),
  "text.length": (args) => codePoints(txt(args, 0)).length,
  "text.concat": (args) => {
    const left = txt(args, 0);
    const right = txt(args, 1);
    if (left.length + right.length > MAX_PRODUCED_TEXT_UNITS) return OUTPUT_TOO_LARGE;
    return left + right;
  },
  "text.contains": (args) => txt(args, 0).includes(txt(args, 1)),
  "text.startsWith": (args) => txt(args, 0).startsWith(txt(args, 1)),
  "text.endsWith": (args) => txt(args, 0).endsWith(txt(args, 1)),
  "text.equalsIgnoreCase": (args) =>
    asciiLower(txt(args, 0)) === asciiLower(txt(args, 1)),
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
    const value = txt(args, 0);
    const search = txt(args, 1);
    // An empty search would match at every position; returning the input
    // keeps the function total and its output bounded by its input.
    if (search.length === 0) return value;
    const replacement = txt(args, 2);
    // Replacement is multiplicative: n single-character matches and an
    // n-character replacement is Θ(n²) output from two small inputs. Size
    // the result from the match count first and decline before allocating.
    const produced =
      value.length + occurrences(value, search) * (replacement.length - search.length);
    if (produced > MAX_PRODUCED_TEXT_UNITS) return OUTPUT_TOO_LARGE;
    // `split`/`join` rather than `replaceAll`: the replacement is a literal,
    // never a `$&`-style pattern the caller could use to amplify output.
    return value.split(search).join(replacement);
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
    const separator = txt(args, 1);
    const parts: string[] = [];
    let produced = 0;
    for (const item of items) {
      // Well-formedness is already settled: the argument check walks the whole
      // collection. What is left is whether the element is text at all.
      if (typeof item !== "string") return null;
      parts.push(item);
      produced += item.length;
    }
    // Item count times separator length is the amplification here.
    if (parts.length > 1) produced += (parts.length - 1) * separator.length;
    if (produced > MAX_PRODUCED_TEXT_UNITS) return OUTPUT_TOO_LARGE;
    return parts.join(separator);
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
    // A sum past integer precision is a rounded sum. Instants are exact
    // integers by declaration, so an inexact one is absence, not a value that
    // is nearly right — an off-by-a-few instant would quietly change what a
    // filter matched.
    if (!Number.isSafeInteger(shifted)) return null;
    return isTimestamp(shifted) ? shifted : null;
  },
  "time.diffMillis": (args) => {
    // The admitted instant range spans more than 2^53 milliseconds, so a
    // difference across it can exceed integer precision and silently round:
    // -8.64e15 to 8639999999999999 is exactly 17279999999999999 ms, which a
    // double reports as 17280000000000000. Absence, for the same reason
    // dividing by zero is absence — the library does not return a number it
    // cannot stand behind.
    const difference = num(args, 1) - num(args, 0);
    return Number.isSafeInteger(difference) ? difference : null;
  },
};
