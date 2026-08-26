/**
 * Canonical JSON + cryptographic policy/rule identity.
 * Rule ids and policy hashes are SHA-256 hex of the canonical body.
 */

import { createHash } from "node:crypto";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const next = value[key];
      if (next !== undefined) out[key] = canonicalize(next);
    }
    return out;
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

export const sha256Hex = (canonical: string): string =>
  createHash("sha256").update(canonical, "utf8").digest("hex");

export const hashPolicy = (body: unknown): string => sha256Hex(canonicalJson(body));

export const ruleIdOf = (
  focus: { readonly kind: string; readonly ns: string },
  expr: unknown,
): string => `r:${focus.kind}:${focus.ns}:${sha256Hex(canonicalJson(expr))}`;
