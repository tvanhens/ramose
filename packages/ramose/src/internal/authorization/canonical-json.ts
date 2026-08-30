import type { JsonValue } from "./json.ts";

export const AUTHORIZATION_CANONICAL_JSON_VERSION = "rfc8785-jcs/1" as const;

export const compareCanonicalKeys = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const hex4 = (code: number): string => code.toString(16).padStart(4, "0");

export const hasLoneSurrogate = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

const escapeRfc8785String = (value: string): string => {
  if (hasLoneSurrogate(value)) {
    throw new TypeError("ramose/authorization: canonicalizeJson rejects lone surrogates");
  }
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

export const canonicalizeJson = (json: JsonValue): string => writeRfc8785(json);
