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
import { sha256Hex } from "./sha256.ts";
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

/**
 * Lexical canonical JSON. Object members are emitted in `sort()` order so
 * integer-like keys and `__proto__` are not rewritten by JS enumeration
 * or the inherited prototype setter.
 */
export const canonicalizeJson = (value: unknown): string => {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError("ramose/authorization: canonicalizeJson expects JSON");
  }
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      out += canonicalizeJson(value[i]);
    }
    return `${out}]`;
  }
  const keys = Object.keys(value).sort();
  let out = "{";
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ",";
    const key = keys[i];
    out += `${JSON.stringify(key)}:${canonicalizeJson((value as Record<string, unknown>)[key])}`;
  }
  return `${out}}`;
};

export const canonicalizePolicyTemplate = (document: PolicyTemplateIRType): string =>
  canonicalizeJson(encodePolicyTemplate(document));

export const canonicalizeInstalledAuthorization = (
  document: InstalledAuthorizationIRType,
): string => canonicalizeJson(encodeInstalledAuthorization(document));

export { sha256Hex } from "./sha256.ts";

export const hashCanonical = (value: unknown): string => sha256Hex(canonicalizeJson(value));

export const hashPolicyTemplate = (document: PolicyTemplateIRType): PolicyHash =>
  PolicyHash.make(sha256Hex(canonicalizePolicyTemplate(document)));

export const hashInstalledAuthorization = (document: InstalledAuthorizationIRType): PolicyHash =>
  PolicyHash.make(
    hashCanonical(omitKey(encodeInstalledAuthorization(document), "policyHash")),
  );

export const hashRelativeRule = (rule: RelativeAuthorizationRuleType): RuleId =>
  RuleId.make(hashCanonical(omitKey(Schema.encodeUnknownSync(RelativeAuthorizationRule)(rule), "id")));

export const hashCanonicalRule = (rule: CanonicalAuthorizationRuleType): RuleId =>
  RuleId.make(hashCanonical(omitKey(Schema.encodeUnknownSync(CanonicalAuthorizationRule)(rule), "id")));

const decodeDocument = <A>(
  decode: (input: unknown) => Result.Result<A, Schema.SchemaError>,
  encodeRule: (rule: unknown) => unknown,
  input: unknown,
): Result.Result<A, InvalidIR> => {
  const hostile = inspectRawJson(input);
  if (hostile !== undefined) {
    return Result.fail(new InvalidIR({ message: hostile }));
  }
  const json = Schema.decodeUnknownResult(Schema.Json)(input);
  if (Result.isFailure(json)) {
    return Result.fail(new InvalidIR({ message: json.failure.message }));
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
    const body = canonicalizeJson(omitKey(encodeRule(rule), "id"));
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

const omitKey = (encoded: unknown, key: string): unknown => {
  if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
    return encoded;
  }
  const body: Record<string, unknown> = Object.create(null);
  for (const name of Object.keys(encoded)) {
    if (name !== key) body[name] = (encoded as Record<string, unknown>)[name];
  }
  return body;
};

type WalkFrame = {
  readonly value: object;
  readonly keys: ReadonlyArray<string> | number;
  index: number;
  readonly depth: number;
};

/**
 * Iterative JSON-only inspect. Reads property descriptors so accessors and
 * deep hostile trees fail as `InvalidIR` before Schema walks the input.
 */
const inspectRawJson = (input: unknown): string | undefined => {
  const root = jsonLeafViolation(input);
  if (root !== undefined) return root;
  if (typeof input !== "object" || input === null) return undefined;

  // `false` = on the current path (a cycle). `true` = already validated (a DAG).
  const seen = new WeakMap<object, boolean>();
  const stack: WalkFrame[] = [];
  const opened = enterObject(input, 0, seen, stack);
  if (opened !== undefined) return opened;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const next = nextChild(frame);
    if (next === undefined) {
      seen.set(frame.value, true);
      stack.pop();
      continue;
    }
    if (next.violation !== undefined) return next.violation;
    const leaf = jsonLeafViolation(next.value);
    if (leaf !== undefined) return leaf;
    if (typeof next.value === "object" && next.value !== null) {
      const reason = enterObject(next.value, frame.depth + 1, seen, stack);
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
};

const enterObject = (
  value: object,
  depth: number,
  seen: WeakMap<object, boolean>,
  stack: WalkFrame[],
): string | undefined => {
  const cached = seen.get(value);
  if (cached === false) return "rejected cycle";
  if (cached === true) return undefined;
  if (depth > MAX_JSON_DEPTH) return "rejected oversized depth";
  const shape = objectShapeViolation(value);
  if (shape !== undefined) return shape;
  seen.set(value, false);
  if (Array.isArray(value)) {
    stack.push({ value, keys: value.length, index: 0, depth });
  } else {
    stack.push({ value, keys: Object.getOwnPropertyNames(value), index: 0, depth });
  }
  return undefined;
};

const nextChild = (
  frame: WalkFrame,
): { readonly value: unknown; readonly violation?: undefined } | { readonly violation: string } | undefined => {
  if (typeof frame.keys === "number") {
    if (frame.index >= frame.keys) return undefined;
    const name = String(frame.index++);
    return childFromDescriptor(frame.value, name, true);
  }
  if (frame.index >= frame.keys.length) return undefined;
  return childFromDescriptor(frame.value, frame.keys[frame.index++], false);
};

const childFromDescriptor = (
  value: object,
  name: string,
  arrayIndex: boolean,
): { readonly value: unknown; readonly violation?: undefined } | { readonly violation: string } => {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) {
    return { violation: arrayIndex ? "rejected undefined" : "rejected prototype" };
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    return { violation: "rejected prototype" };
  }
  return { value: descriptor.value };
};

const objectShapeViolation = (value: object): string | undefined => {
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_SIZE) return "rejected oversized collection";
    if (Object.getOwnPropertySymbols(value).length > 0) return "rejected symbol";
    const extra = Object.getOwnPropertyNames(value).some(
      (name) => name !== "length" && !/^(0|[1-9]\d*)$/.test(name),
    );
    return extra ? "rejected non-JSON array" : undefined;
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
  return undefined;
};

const jsonLeafViolation = (value: unknown): string | undefined => {
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
  return undefined;
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
