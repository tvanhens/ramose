/**
 * Value classification and structural helpers for the v1 expression
 * standard library (#507).
 *
 * Everything here is pure and total. Nothing reads a clock, a database, the
 * environment, or any ambient state, and nothing throws: an undefined case is
 * a `null` or a `false`, never an exception.
 */

import type { StdlibValue, ValueType, ValueTypeName } from "./types.ts";

/**
 * Largest absolute epoch-millisecond value treated as a timestamp. Matches
 * the representable instant range, so a timestamp always round-trips.
 */
export const MAX_TIMESTAMP_MILLIS = 8_640_000_000_000_000;

/** What a runtime value is. Never inspects the value's contents. */
export const classify = (value: StdlibValue): ValueTypeName => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "collection";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "text";
    default:
      return "object";
  }
};

/** A JSON number: finite, never `NaN` or an infinity. */
export const isFiniteNumber = (value: StdlibValue): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A safe-integer epoch-millisecond instant inside the representable range. */
export const isTimestamp = (value: StdlibValue): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  Math.abs(value) <= MAX_TIMESTAMP_MILLIS;

/**
 * Does a runtime value satisfy a declared type?
 *
 * `null` satisfies every declared type — absence is representable everywhere,
 * and what a function does with it is its declared null behaviour, not a
 * type error.
 */
export const matchesValueType = (value: StdlibValue, type: ValueType): boolean => {
  if (value === null) return true;
  switch (type) {
    case "any":
      return true;
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return isFiniteNumber(value);
    case "timestamp":
      return isTimestamp(value);
    case "text":
      return typeof value === "string";
    case "collection":
      return Array.isArray(value);
  }
};

/**
 * Structural equality over JSON values.
 *
 * Arrays compare element-wise in order; objects compare by own enumerable
 * keys regardless of key order; numbers compare with `===`, so `-0` and `0`
 * are equal, matching how both serialize.
 */
export const deepEquals = (left: StdlibValue, right: StdlibValue): boolean => {
  if (left === right) return true;
  if (left === null || right === null) return false;

  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const a = left as readonly StdlibValue[];
    const b = right as readonly StdlibValue[];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof left !== "object" || typeof right !== "object") return false;

  const a = left as { readonly [key: string]: StdlibValue };
  const b = right as { readonly [key: string]: StdlibValue };
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!deepEquals(a[key], b[key])) return false;
  }
  return true;
};

/**
 * A canonical string key for a value, used to deduplicate in linear time.
 * Object keys are sorted so key order never changes the key, and the type
 * tag prefixes keep `1` and `"1"` distinct.
 */
export const canonicalKey = (value: StdlibValue): string => {
  if (value === null) return "z";
  if (Array.isArray(value)) {
    const items = value as readonly StdlibValue[];
    return `a[${items.map(canonicalKey).join(",")}]`;
  }
  switch (typeof value) {
    case "boolean":
      return value ? "b1" : "b0";
    case "number":
      // `-0` and `0` are equal under `deepEquals`; normalize so they key alike.
      return `n${value === 0 ? 0 : value}`;
    case "string":
      return `s${JSON.stringify(value)}`;
    default: {
      const record = value as { readonly [key: string]: StdlibValue };
      const keys = Object.keys(record).sort();
      const body = keys
        .map((key) => `${JSON.stringify(key)}:${canonicalKey(record[key])}`)
        .join(",");
      return `o{${body}}`;
    }
  }
};

/**
 * Split text into Unicode code points.
 *
 * Every text index and length in the library is measured in code points, so
 * an astral character counts once and never splits into a lone surrogate.
 */
export const codePoints = (text: string): readonly string[] => Array.from(text);

/** Clamp an index into `[0, length]`. Negative never means "from the end". */
export const clampIndex = (index: number, length: number): number => {
  if (!Number.isFinite(index)) return 0;
  const whole = Math.trunc(index);
  if (whole < 0) return 0;
  if (whole > length) return length;
  return whole;
};
