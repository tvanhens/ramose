import type { JsonValue } from "./json.ts";

/**
 * Canonical JSON profile for authorization identities.
 *
 * Versioned contract: `rfc8785-jcs/1`.
 *
 * This is RFC 8785 JSON Canonicalization Scheme (JCS), restricted to
 * `JsonValue` already accepted by the structural codecs: finite numbers
 * only, no holes, no functions, no `undefined`.
 *
 * Members are emitted in RFC 8785 UTF-16 code-unit order. The writer
 * never rebuilds an object, so it does not lose an own `__proto__` key
 * or fall back to JavaScript integer-index enumeration order.
 *
 * Changing this profile after installed policies exist would invalidate
 * persistent `RuleId` / `PolicyHash` identities. Do not vary it in place.
 */
export const AUTHORIZATION_CANONICAL_JSON_VERSION = "rfc8785-jcs/1" as const;

/**
 * RFC 8785 §3.2.3: lexicographic order of UTF-16 code units, not Unicode
 * code points. Matches ECMAScript `<` on strings.
 */
export const compareCanonicalKeys = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const hex4 = (code: number): string => code.toString(16).padStart(4, "0");

/**
 * RFC 8785 §3.2.2.2 / ECMA-262 JSON.stringify string serialization.
 * Predefined controls use `\b \t \n \f \r`; remaining U+0000–U+001F use
 * lowercase `\uhhhh`. `"` and `\` are escaped; every other code unit is
 * copied as-is.
 */
const escapeRfc8785String = (value: string): string => {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    switch (code) {
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      default:
        if (code <= 0x1f) {
          out += `\\u${hex4(code)}`;
        } else {
          out += value[i]!;
        }
    }
  }
  return `${out}"`;
};

/**
 * RFC 8785 §3.2.2.3: ECMAScript NumberToString, with `-0` emitted as `0`.
 * Callers have already rejected non-finite numbers.
 */
const serializeRfc8785Number = (value: number): string => {
  if (Object.is(value, -0) || value === 0) return "0";
  return String(value);
};

const ownJson = (value: object, key: string): JsonValue => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new TypeError("ramose/authorization: canonicalizeJson expects own JSON data");
  }
  return descriptor.value as JsonValue;
};

const writeRfc8785 = (value: JsonValue): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serializeRfc8785Number(value);
  if (typeof value === "string") return escapeRfc8785String(value);
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      out += writeRfc8785(value[i] as JsonValue);
    }
    return `${out}]`;
  }
  const keys = Object.keys(value).sort(compareCanonicalKeys);
  let out = "{";
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ",";
    const key = keys[i]!;
    out += `${escapeRfc8785String(key)}:${writeRfc8785(ownJson(value, key))}`;
  }
  return `${out}}`;
};

/**
 * Emit RFC 8785 JCS text for schema-encoded, validated JSON.
 *
 * Do not pass arbitrary `unknown` values. `JSON.stringify` would drop
 * functions/`undefined`, convert array holes, and invoke getters.
 */
export const canonicalizeJson = (json: JsonValue): string => writeRfc8785(json);
