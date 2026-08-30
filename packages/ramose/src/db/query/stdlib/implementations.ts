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

const roundHalfAwayFromZero = (value: number): number =>
  value < 0 ? -Math.round(-value) : Math.round(value);

const codePointIndexOf = (value: string, needle: string): number => {
  if (needle.length === 0) return 0;
  const unitIndex = value.indexOf(needle);
  if (unitIndex < 0) return -1;
  return codePoints(value.slice(0, unitIndex)).length;
};

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

export const standardLibraryImplementationsV1: {
  readonly [name: string]: StdlibImplementation;
} = {
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
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(txt(args, 0))) {
      return null;
    }
    const parsed = Number(txt(args, 0));
    return Number.isFinite(parsed) ? parsed : null;
  },

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
    if (search.length === 0) return value;
    const replacement = txt(args, 2);
    const produced =
      value.length + occurrences(value, search) * (replacement.length - search.length);
    if (produced > MAX_PRODUCED_TEXT_UNITS) return OUTPUT_TOO_LARGE;
    return value.split(search).join(replacement);
  },
  "text.split": (args) => {
    const separator = txt(args, 1);
    if (separator.length === 0) return [txt(args, 0)];
    return txt(args, 0).split(separator);
  },
  "text.join": (args) => {
    const items = coll(args, 0);
    const separator = txt(args, 1);
    const parts: string[] = [];
    let produced = 0;
    for (const item of items) {
      if (typeof item !== "string") return null;
      parts.push(item);
      produced += item.length;
    }
    if (parts.length > 1) produced += (parts.length - 1) * separator.length;
    if (produced > MAX_PRODUCED_TEXT_UNITS) return OUTPUT_TOO_LARGE;
    return parts.join(separator);
  },

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

  "time.before": (args) => num(args, 0) < num(args, 1),
  "time.after": (args) => num(args, 0) > num(args, 1),
  "time.addMillis": (args) => {
    const millis = num(args, 1);
    if (!Number.isSafeInteger(millis)) return null;
    const shifted = num(args, 0) + millis;
    if (!Number.isSafeInteger(shifted)) return null;
    return isTimestamp(shifted) ? shifted : null;
  },
  "time.diffMillis": (args) => {
    const difference = num(args, 1) - num(args, 0);
    return Number.isSafeInteger(difference) ? difference : null;
  },
};
