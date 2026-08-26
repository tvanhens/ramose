/**
 * Trust-boundary decoding and canonical serialization.
 *
 * Effect Schema models from this module remain the single source of truth.
 * This file applies those codecs: JSON-only validation, strict decode to
 * plain frozen data, canonical encode, and SHA-256 identities.
 *
 * Canonicalization, hashing, and decode-to-plain-data are pure and
 * synchronous. Effect appears only at the outer typed-failure boundary.
 * Structural success is not runtime acceptance — binding is #358.
 */

import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  MAX_COLLECTION_SIZE,
  MAX_JSON_DEPTH,
  MAX_STRING_LENGTH,
} from "./bounds.ts";
import { InvalidIR } from "./failures.ts";
import { PolicyHash, RuleId } from "./identities.ts";
import {
  CanonicalAuthorizationRule,
  InstalledAuthorizationIR,
  PolicyTemplateIR,
  RelativeAuthorizationRule,
  type CanonicalAuthorizationRule as CanonicalAuthorizationRuleType,
  type InstalledAuthorizationIR as InstalledAuthorizationIRType,
  type PolicyTemplateIR as PolicyTemplateIRType,
  type RelativeAuthorizationRule as RelativeAuthorizationRuleType,
} from "./ir.ts";

const STRICT = { onExcessProperty: "error" as const };

const TrustJson = Schema.Json.pipe(
  Schema.check(
    Schema.makeFilter((input) => {
      const reason = jsonBoundViolation(input);
      return reason === undefined ? undefined : reason;
    }),
  ),
);

export type PolicyTemplateIREncoded = typeof PolicyTemplateIR.Encoded;
export type InstalledAuthorizationIREncoded = typeof InstalledAuthorizationIR.Encoded;
export type RelativeAuthorizationRuleEncoded = typeof RelativeAuthorizationRule.Encoded;
export type CanonicalAuthorizationRuleEncoded = typeof CanonicalAuthorizationRule.Encoded;

export const decodePolicyTemplateResult = (
  input: unknown,
): Result.Result<PolicyTemplateIRType, InvalidIR> =>
  decodeDocument(
    Schema.decodeUnknownResult(PolicyTemplateIR, STRICT),
    (rule) => Schema.encodeUnknownSync(RelativeAuthorizationRule)(rule),
    input,
  );

export const decodeInstalledAuthorizationResult = (
  input: unknown,
): Result.Result<InstalledAuthorizationIRType, InvalidIR> =>
  decodeDocument(
    Schema.decodeUnknownResult(InstalledAuthorizationIR, STRICT),
    (rule) => Schema.encodeUnknownSync(CanonicalAuthorizationRule)(rule),
    input,
  );

export const decodePolicyTemplate = Effect.fn("decodePolicyTemplate")(function* (
  input: unknown,
): Effect.fn.Return<PolicyTemplateIRType, InvalidIR> {
  return yield* Effect.fromResult(decodePolicyTemplateResult(input));
});

export const decodeInstalledAuthorization = Effect.fn("decodeInstalledAuthorization")(
  function* (input: unknown): Effect.fn.Return<InstalledAuthorizationIRType, InvalidIR> {
    return yield* Effect.fromResult(decodeInstalledAuthorizationResult(input));
  },
);

export const encodePolicyTemplate = (document: PolicyTemplateIRType): PolicyTemplateIREncoded =>
  Schema.encodeUnknownSync(PolicyTemplateIR)(document);

export const encodeInstalledAuthorization = (
  document: InstalledAuthorizationIRType,
): InstalledAuthorizationIREncoded => Schema.encodeUnknownSync(InstalledAuthorizationIR)(document);

export const canonicalizeJson = (value: unknown): string => JSON.stringify(sortJson(value));

export const canonicalizePolicyTemplate = (document: PolicyTemplateIRType): string =>
  canonicalizeJson(encodePolicyTemplate(document));

export const canonicalizeInstalledAuthorization = (
  document: InstalledAuthorizationIRType,
): string => canonicalizeJson(encodeInstalledAuthorization(document));

export const sha256Hex = (canonical: string): string =>
  createHash("sha256").update(canonical, "utf8").digest("hex");

export const hashCanonical = (value: unknown): string => sha256Hex(canonicalizeJson(value));

export const hashPolicyTemplate = (document: PolicyTemplateIRType): PolicyHash =>
  PolicyHash.make(sha256Hex(canonicalizePolicyTemplate(document)));

export const hashInstalledAuthorization = (document: InstalledAuthorizationIRType): PolicyHash =>
  PolicyHash.make(sha256Hex(canonicalizeInstalledAuthorization(document)));

export const hashRelativeRule = (rule: RelativeAuthorizationRuleType): RuleId =>
  RuleId.make(hashCanonical(ruleIdentityBody(Schema.encodeUnknownSync(RelativeAuthorizationRule)(rule))));

export const hashCanonicalRule = (rule: CanonicalAuthorizationRuleType): RuleId =>
  RuleId.make(hashCanonical(ruleIdentityBody(Schema.encodeUnknownSync(CanonicalAuthorizationRule)(rule))));

const decodeDocument = <A>(
  decode: (input: unknown) => Result.Result<A, Schema.SchemaError>,
  encodeRule: (rule: unknown) => unknown,
  input: unknown,
): Result.Result<A, InvalidIR> => {
  const json = Schema.decodeUnknownResult(TrustJson)(input);
  if (Result.isFailure(json)) {
    return Result.fail(toInvalidIR(json.failure.message, input));
  }
  const decoded = decode(json.success);
  if (Result.isFailure(decoded)) {
    return Result.fail(new InvalidIR({ message: decoded.failure.message }));
  }
  const collision = identityCollision(decoded.success, encodeRule);
  if (collision !== undefined) {
    return Result.fail(collision);
  }
  return Result.succeed(freezePlain(decoded.success));
};

const identityCollision = (
  document: unknown,
  encodeRule: (rule: unknown) => unknown,
): InvalidIR | undefined => {
  if (!isTemplate(document) && !isInstalled(document)) {
    return new InvalidIR({ message: "rejected malformed document" });
  }
  const bodies = new Map<string, string>();
  for (const rule of document.rules) {
    const encoded = encodeRule(rule);
    const body = canonicalizeJson(ruleIdentityBody(encoded));
    const previous = bodies.get(rule.id);
    if (previous !== undefined && previous !== body) {
      return new InvalidIR({
        message: `rule identity collision: ${rule.id} maps to different canonical bodies`,
      });
    }
    if (previous !== undefined) {
      return new InvalidIR({
        message: `duplicate rule identity: ${rule.id}`,
      });
    }
    bodies.set(rule.id, body);
  }
  if (isTemplate(document)) {
    return decisionCollisions(document.decisions);
  }
  if (isInstalled(document)) {
    return (
      decisionCollisions(document.decisions) ??
      identityTableCollisions(document.identities) ??
      accessPlanCollisions(document.accessPlans)
    );
  }
  return undefined;
};

const isTemplate = (document: unknown): document is PolicyTemplateIRType =>
  typeof document === "object" &&
  document !== null &&
  (document as { readonly _tag?: unknown })._tag === "PolicyTemplateIR";

const isInstalled = (document: unknown): document is InstalledAuthorizationIRType =>
  typeof document === "object" &&
  document !== null &&
  (document as { readonly _tag?: unknown })._tag === "InstalledAuthorizationIR";

const decisionCollisions = (decisions: {
  readonly entities: ReadonlyArray<{ readonly target: unknown }>;
  readonly traits: ReadonlyArray<{ readonly target: unknown }>;
  readonly fields: ReadonlyArray<{ readonly target: unknown }>;
  readonly operations: ReadonlyArray<{ readonly target: unknown }>;
}): InvalidIR | undefined =>
  uniqueTargets(decisions.entities, "entity") ??
  uniqueTargets(decisions.traits, "trait") ??
  uniqueTargets(decisions.fields, "field") ??
  uniqueTargets(decisions.operations, "operation");

const uniqueTargets = (
  entries: ReadonlyArray<{ readonly target: unknown }>,
  kind: string,
): InvalidIR | undefined => {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = canonicalizeJson(entry.target);
    if (seen.has(key)) {
      return new InvalidIR({ message: `duplicate ${kind} decision target` });
    }
    seen.add(key);
  }
  return undefined;
};

const identityTableCollisions = (
  identities: InstalledAuthorizationIRType["identities"],
): InvalidIR | undefined =>
  uniqueEncoded(identities.entities, "entity identity") ??
  uniqueEncoded(identities.traits, "trait identity") ??
  uniqueEncoded(identities.fields, "field identity") ??
  uniqueEncoded(identities.operations, "operation identity");

const accessPlanCollisions = (
  plans: InstalledAuthorizationIRType["accessPlans"],
): InvalidIR | undefined => {
  const bodies = new Map<string, string>();
  for (const plan of plans) {
    const body = canonicalizeJson({ lookups: plan.lookups });
    const previous = bodies.get(plan.rule);
    if (previous !== undefined && previous !== body) {
      return new InvalidIR({
        message: `access-plan identity collision: ${plan.rule} maps to different canonical bodies`,
      });
    }
    if (previous !== undefined) {
      return new InvalidIR({ message: `duplicate access-plan identity: ${plan.rule}` });
    }
    bodies.set(plan.rule, body);
  }
  return undefined;
};

const uniqueEncoded = (values: ReadonlyArray<unknown>, label: string): InvalidIR | undefined => {
  const seen = new Set<string>();
  for (const value of values) {
    const key = canonicalizeJson(value);
    if (seen.has(key)) {
      return new InvalidIR({ message: `duplicate ${label}` });
    }
    seen.add(key);
  }
  return undefined;
};

const ruleIdentityBody = (encoded: unknown): unknown => {
  if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
    return encoded;
  }
  const { id: _id, ...body } = encoded as { readonly id?: unknown } & Record<string, unknown>;
  return body;
};

const toInvalidIR = (schemaMessage: string, input: unknown): InvalidIR =>
  new InvalidIR({ message: jsonRejectionMessage(input) ?? schemaMessage });

const jsonRejectionMessage = (input: unknown): string | undefined => {
  if (input === undefined) return "rejected undefined";
  if (typeof input === "function") return "rejected function";
  if (typeof input === "symbol") return "rejected symbol";
  if (typeof input === "bigint") return "rejected bigint";
  if (typeof input === "number") {
    if (Number.isNaN(input)) return "rejected NaN";
    if (!Number.isFinite(input)) return "rejected Infinity";
  }
  return firstJsonViolation(input);
};

const firstJsonViolation = (input: unknown): string | undefined => {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): string | undefined => {
    if (value === undefined) return "rejected undefined";
    if (typeof value === "function") return "rejected function";
    if (typeof value === "symbol") return "rejected symbol";
    if (typeof value === "bigint") return "rejected bigint";
    if (typeof value === "number") {
      if (Number.isNaN(value)) return "rejected NaN";
      if (!Number.isFinite(value)) return "rejected Infinity";
      return undefined;
    }
    if (typeof value === "string") {
      return value.length > MAX_STRING_LENGTH ? "rejected oversized string" : undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    if (seen.has(value)) return "rejected cycle";
    if (depth > MAX_JSON_DEPTH) return "rejected oversized depth";
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_SIZE) return "rejected oversized collection";
      const extra = Object.getOwnPropertyNames(value).filter(
        (name) => name !== "length" && !/^(0|[1-9]\d*)$/.test(name),
      );
      if (extra.length > 0) return "rejected non-JSON array";
      if (Object.getOwnPropertySymbols(value).length > 0) return "rejected symbol";
      for (const item of value) {
        const reason = visit(item, depth + 1);
        if (reason !== undefined) return reason;
      }
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== null &&
      prototype !== Object.prototype &&
      Object.getPrototypeOf(prototype) !== null
    ) {
      return "rejected prototype";
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length > MAX_COLLECTION_SIZE) return "rejected oversized collection";
    if (Object.getOwnPropertySymbols(value).length > 0) return "rejected symbol";
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
        return "rejected prototype";
      }
      const reason = visit((value as Record<string, unknown>)[name], depth + 1);
      if (reason !== undefined) return reason;
    }
    return undefined;
  };
  return visit(input, 0);
};

const jsonBoundViolation = (input: Schema.Json): string | undefined => {
  const visit = (value: Schema.Json, depth: number): string | undefined => {
    if (typeof value === "string") {
      return value.length > MAX_STRING_LENGTH ? "rejected oversized string" : undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    if (depth > MAX_JSON_DEPTH) return "rejected oversized depth";
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_SIZE) return "rejected oversized collection";
      if (Object.getOwnPropertySymbols(value).length > 0) return "rejected symbol";
      if (hasExtraArrayKeys(value)) return "rejected non-JSON array";
      for (const item of value) {
        const reason = visit(item, depth + 1);
        if (reason !== undefined) return reason;
      }
      return undefined;
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length > MAX_COLLECTION_SIZE) return "rejected oversized collection";
    if (Object.getOwnPropertySymbols(value).length > 0) return "rejected symbol";
    if (hasAccessor(value)) return "rejected prototype";
    const record = value as { readonly [key: string]: Schema.Json };
    for (const name of names) {
      const reason = visit(record[name], depth + 1);
      if (reason !== undefined) return reason;
    }
    return undefined;
  };
  return visit(input, 0);
};

const hasExtraArrayKeys = (value: object): boolean =>
  Object.getOwnPropertyNames(value).some(
    (name) => name !== "length" && !/^(0|[1-9]\d*)$/.test(name),
  );

const hasAccessor = (value: object): boolean =>
  Object.getOwnPropertyNames(value).some((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor?.get !== undefined || descriptor?.set !== undefined;
  });

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
};

const freezePlain = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) freezePlain(item);
  } else {
    for (const key of Object.keys(value)) {
      freezePlain((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
};
