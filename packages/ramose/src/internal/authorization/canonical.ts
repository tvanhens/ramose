/** Deterministic canonical JSON for hashing and golden serialization. */

import type { JsonValue } from "./json.ts";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const encode = (value: unknown): string => {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item)).join(",")}]`;
  }
  if (!isPlainObject(value)) {
    throw new Error("canonicalJson: non-JSON value");
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(value[key])}`).join(",")}}`;
};

/** Stable, key-sorted JSON with no whitespace. */
export const canonicalJson = (value: unknown): string => encode(value);

export const canonicalParse = (text: string): JsonValue =>
  JSON.parse(text) as JsonValue;

/** Drop derived fields so rule identity hashes the focus + expression only. */
export const canonicalRuleBody = (rule: {
  readonly focus: unknown;
  readonly expr: unknown;
}): string => canonicalJson({ focus: rule.focus, expr: rule.expr });
