/**
 * Fail-closed parse / serialize for the sealed installed IR.
 * Runtime accepts a JSON string of {@link InstalledAuthorizationIR} only.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PolicyError } from "../../db/SchemaErrors.ts";
import { canonicalJson, canonicalize } from "./canonical.ts";
import { InvalidIR } from "./errors.ts";
import type { InstalledAuthorizationIR } from "./ir.ts";
import { InstalledAuthorizationIRSchema, PolicyTemplateIRSchema } from "./schema.ts";
import { validateSemantics } from "./validate.ts";

const asPolicyError = (reason: string, cause?: unknown): never => {
  throw new PolicyError({ message: `ramose/authorization: ${reason}`, cause });
};

const decodeInstalled = (value: unknown): InstalledAuthorizationIR => {
  const decoded = Effect.runSync(
    Schema.decodeUnknownEffect(InstalledAuthorizationIRSchema)(value).pipe(
      Effect.mapError((error) => new InvalidIR({ reason: error.message })),
    ),
  );
  validateSemantics(decoded);
  return Object.freeze(decoded);
};

/** Decode a catalog-relative template (compile/install only). */
export const decodePolicyTemplate = (value: unknown): import("./ir.ts").PolicyTemplateIR => {
  const decoded = Effect.runSync(
    Schema.decodeUnknownEffect(PolicyTemplateIRSchema)(value).pipe(
      Effect.mapError((error) => new InvalidIR({ reason: error.message })),
    ),
  );
  validateSemantics(decoded);
  return decoded;
};

/**
 * Parse a JSON string of the sealed installed form. Objects and
 * templates are rejected — runtime must not accept unbound IR.
 */
export const parseAuthorizationIR = (input: unknown): InstalledAuthorizationIR => {
  if (typeof input !== "string" || input.length === 0) {
    return asPolicyError("compiled IR must be a non-empty JSON string");
  }
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (cause) {
    return asPolicyError("compiled IR is not valid JSON", cause);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return asPolicyError("compiled IR must be a JSON object");
  }
  const form = (value as { readonly form?: unknown }).form;
  if (form !== "installed") {
    return asPolicyError("runtime accepts only sealed installed authorization IR");
  }
  try {
    return decodeInstalled(value);
  } catch (error) {
    if (error instanceof InvalidIR) return asPolicyError(error.reason, error);
    if (error instanceof PolicyError) throw error;
    return asPolicyError(error instanceof Error ? error.message : String(error), error);
  }
};

/** Deterministic JSON. Same installed IR always yields the same string. */
export const serializeAuthorizationIR = (ir: InstalledAuthorizationIR): string => {
  if (ir.form !== "installed") {
    return asPolicyError("serialize expects sealed installed authorization IR");
  }
  const parsed = parseAuthorizationIR(JSON.stringify(canonicalize(ir)));
  return canonicalJson(parsed);
};
