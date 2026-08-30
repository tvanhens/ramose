/**
 * Value classification and structural helpers for the v1 expression
 * standard library (#507).
 *
 * Everything here is pure and total. Nothing reads a clock, a database, the
 * environment, or any ambient state, and nothing throws: an undefined case is
 * a `null` or a `false`, never an exception.
 */

import { MAX_VALUE_DEPTH } from "./types.ts";
import type {
  DomainViolation,
  StdlibValue,
  ValueType,
  ValueTypeName,
} from "./types.ts";

/**
 * Largest absolute epoch-millisecond value treated as a timestamp. Matches
 * the representable instant range, so a timestamp always round-trips.
 */
export const MAX_TIMESTAMP_MILLIS = 8_640_000_000_000_000;

/**
 * Largest text a single call may produce, in UTF-16 code units (1 MiB of
 * them). Enforced before allocation by the functions that can produce more
 * than the sum of their inputs, so a small document cannot ask for a large
 * allocation. Milestone 2's runtime budget accounting subsumes this static
 * floor; it is budget policy, not function semantics.
 */
export const MAX_PRODUCED_TEXT_UNITS = 1 << 20;

/**
 * Is this string well-formed Unicode — every surrogate paired?
 *
 * JSON can carry an escaped unpaired surrogate, and such a string has no
 * meaning as a sequence of code points, so it is not a value of the
 * expression domain. Written out rather than delegated to
 * `String.prototype.isWellFormed`, which is newer than this package's
 * language target.
 */
export const isWellFormedText = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    // A low surrogate here was not consumed as the tail of a pair.
    if (unit >= 0xdc00) return false;
    if (index + 1 >= value.length) return false;
    const next = value.charCodeAt(index + 1);
    if (next < 0xdc00 || next > 0xdfff) return false;
    index += 1;
  }
  return true;
};

/** What a runtime value is. Never inspects a collection's contents. */
export const classify = (value: StdlibValue): ValueTypeName => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "collection";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return isWellFormedText(value) ? "text" : "malformedText";
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
 *
 * A string that is not well-formed Unicode satisfies *no* declared type,
 * `any` included: it is outside the value domain, not a mistyped member of
 * it. This is the shallow check — kind, plus well-formedness of a top-level
 * string. {@link domainViolation} is the deep one that also screens
 * collection contents and nesting depth; argument checking runs both.
 */
export const matchesValueType = (value: StdlibValue, type: ValueType): boolean => {
  if (value === null) return true;
  if (typeof value === "string" && !isWellFormedText(value)) return false;
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

const asArray = (value: StdlibValue): readonly StdlibValue[] =>
  value as readonly StdlibValue[];

const asRecord = (value: StdlibValue): { readonly [key: string]: StdlibValue } =>
  value as { readonly [key: string]: StdlibValue };

/**
 * Is this value inside the domain, and if not, why?
 *
 * Checks both membership conditions in one pass over the whole value: every
 * string well-formed, and nesting within {@link MAX_VALUE_DEPTH}. The
 * traversal uses an explicit stack, so its totality does not depend on the
 * host's call-stack depth even for a value that would fail the limit.
 */
export const domainViolation = (value: StdlibValue): DomainViolation | undefined => {
  const stack: { readonly node: StdlibValue; readonly depth: number }[] = [
    { node: value, depth: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const node = frame.node;
    if (typeof node === "string") {
      if (!isWellFormedText(node)) return "malformedText";
      continue;
    }
    if (node === null || typeof node !== "object") continue;

    const depth = frame.depth + 1;
    if (depth > MAX_VALUE_DEPTH) return "tooDeep";
    if (Array.isArray(node)) {
      for (const item of asArray(node)) stack.push({ node: item, depth });
    } else {
      const record = asRecord(node);
      for (const key of Object.keys(record)) {
        stack.push({ node: record[key], depth });
      }
    }
  }
  return undefined;
};

/**
 * Structural equality over JSON values.
 *
 * Arrays compare element-wise in order; objects compare by own enumerable
 * keys regardless of key order; numbers compare with `===`, so `-0` and `0`
 * are equal, matching how both serialize.
 *
 * Iterative on purpose. Nesting is bounded by the domain check, but a public
 * predicate whose totality rests on the host's call-stack depth is a crash
 * waiting for the one path that skips that check, so this walks an explicit
 * stack and cannot overflow whatever it is handed.
 */
export const deepEquals = (left: StdlibValue, right: StdlibValue): boolean => {
  const stack: (readonly [StdlibValue, StdlibValue])[] = [[left, right]];
  while (stack.length > 0) {
    const pair = stack.pop();
    if (pair === undefined) break;
    const a = pair[0];
    const b = pair[1];
    if (a === b) continue;
    if (a === null || b === null) return false;

    const aIsArray = Array.isArray(a);
    if (aIsArray !== Array.isArray(b)) return false;
    if (aIsArray) {
      const x = asArray(a);
      const y = asArray(b);
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i += 1) stack.push([x[i], y[i]]);
      continue;
    }

    // Two scalars that are not `===` are unequal; only objects go deeper.
    if (typeof a !== "object" || typeof b !== "object") return false;
    const x = asRecord(a);
    const y = asRecord(b);
    const xKeys = Object.keys(x);
    if (xKeys.length !== Object.keys(y).length) return false;
    for (const key of xKeys) {
      if (!Object.hasOwn(y, key)) return false;
      stack.push([x[key], y[key]]);
    }
  }
  return true;
};

/**
 * A canonical string key for a value, used to deduplicate by structure.
 *
 * A prefix encoding: each node emits a type tag, containers emit their size
 * before their contents, and object keys are emitted in sorted order so key
 * order never changes the key. Counts and tags make the token stream
 * uniquely parseable, which is what makes the key injective — equal keys mean
 * structurally equal values. Written iteratively for the same reason as
 * {@link deepEquals}.
 */
export const canonicalKey = (value: StdlibValue): string => {
  type Frame = { readonly emit: string } | { readonly node: StdlibValue };
  const parts: string[] = [];
  const stack: Frame[] = [{ node: value }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if ("emit" in frame) {
      parts.push(frame.emit);
      continue;
    }

    const node = frame.node;
    if (node === null) {
      parts.push("z");
      continue;
    }
    if (Array.isArray(node)) {
      const items = asArray(node);
      parts.push(`a${items.length}`);
      // Reverse so the stack pops them in order.
      for (let i = items.length - 1; i >= 0; i -= 1) stack.push({ node: items[i] });
      continue;
    }
    switch (typeof node) {
      case "boolean":
        parts.push(node ? "b1" : "b0");
        continue;
      case "number":
        // `-0` and `0` are equal under `deepEquals`; normalize so they key alike.
        parts.push(`n${node === 0 ? 0 : node}`);
        continue;
      case "string":
        parts.push(`s${JSON.stringify(node)}`);
        continue;
      default: {
        const record = asRecord(node);
        const keys = Object.keys(record).sort();
        parts.push(`o${keys.length}`);
        for (let i = keys.length - 1; i >= 0; i -= 1) {
          const key = keys[i];
          stack.push({ node: record[key] });
          stack.push({ emit: `k${JSON.stringify(key)}` });
        }
        continue;
      }
    }
  }

  return parts.join("");
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

/**
 * Case mapping is ASCII only, and deliberately so.
 *
 * The host's `toLowerCase` / `toUpperCase` read the engine's Unicode case
 * tables, and those tables move with the engine's Unicode version — U+1C89
 * is unchanged under Unicode 15.1 and lowercases under Unicode 17, so the
 * same document would filter differently on Bun, on workerd, and on the same
 * workerd after a runtime upgrade. That is exactly the determinism this
 * language promises not to break, so v1 commits to the one mapping every
 * engine agrees on forever: A–Z ↔ a–z, everything else unchanged. A wider
 * mapping can arrive later under its own name, pinned to a stated Unicode
 * version, which keeps the growth additive.
 */
const ASCII_UPPERCASE = /[A-Z]/g;
const ASCII_LOWERCASE = /[a-z]/g;

const shiftCase = (character: string, delta: number): string =>
  String.fromCharCode(character.charCodeAt(0) + delta);

/** Lowercase A–Z; every other code point passes through unchanged. */
export const asciiLower = (value: string): string =>
  value.replace(ASCII_UPPERCASE, (character) => shiftCase(character, 32));

/** Uppercase a–z; every other code point passes through unchanged. */
export const asciiUpper = (value: string): string =>
  value.replace(ASCII_LOWERCASE, (character) => shiftCase(character, -32));

/**
 * The whitespace `text.trim` removes, written out rather than delegated to
 * the host.
 *
 * `String.prototype.trim` strips whatever the engine currently considers a
 * space separator, which is another Unicode-version-dependent table. This is
 * that set as of the pinned version — the ECMAScript WhiteSpace and
 * LineTerminator productions — frozen as a literal so it cannot drift.
 */
const PINNED_WHITESPACE_LEADING = /^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+/;
const PINNED_WHITESPACE_TRAILING = /[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$/;

/** Remove leading and trailing characters of the pinned whitespace set. */
export const trimPinned = (value: string): string =>
  value.replace(PINNED_WHITESPACE_LEADING, "").replace(PINNED_WHITESPACE_TRAILING, "");
