/**
 * Trust-boundary decoding and canonical serialization.
 *
 * Effect Schema models from this module remain the single source of truth.
 * This file applies those codecs: JSON-only validation, strict decode to
 * plain frozen data, RFC 8785 canonical encode, and SHA-256 identities.
 *
 * Decode, encode, and canonicalization are pure. Cryptographic hashing
 * lives in the Effect orchestration shell via the Web Crypto API
 * (`crypto.subtle.digest`), matching #337. Structural success is not
 * runtime acceptance — binding is #384.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  MAX_COLLECTION_SIZE,
  MAX_JSON_DEPTH,
  MAX_JSON_ENCODED_BYTES,
  MAX_JSON_NODES,
  MAX_STRING_LENGTH,
} from "./bounds.ts";
import { canonicalizeJson, hasLoneSurrogate } from "./canonical-json.ts";
import { OperationDescriptor, TraitComposition } from "./catalog.ts";
import { InvalidIR } from "./failures.ts";
import { OperationId, PolicyHash, RuleId } from "./identities.ts";
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
import type { JsonValue } from "./json.ts";
import { sha256Hex } from "../core/bytes.ts";

const STRICT = { onExcessProperty: "error" as const };
const UTF8 = new TextEncoder();

export type PolicyTemplateIREncoded = typeof PolicyTemplateIR.Encoded;
export type InstalledAuthorizationIREncoded = typeof InstalledAuthorizationIR.Encoded;
export type RelativeAuthorizationRuleEncoded = typeof RelativeAuthorizationRule.Encoded;
export type CanonicalAuthorizationRuleEncoded = typeof CanonicalAuthorizationRule.Encoded;

export const decodePolicyTemplateResult = (
  input: unknown,
): Result.Result<PolicyTemplateIRType, InvalidIR> =>
  decodeDocument(
    Schema.decodeUnknownResult(PolicyTemplateIR, STRICT),
    (rule) => encodedJson(Schema.encodeUnknownSync(RelativeAuthorizationRule)(rule)),
    input,
  );

export const decodeInstalledAuthorizationResult = (
  input: unknown,
): Result.Result<InstalledAuthorizationIRType, InvalidIR> =>
  decodeDocument(
    Schema.decodeUnknownResult(InstalledAuthorizationIR, STRICT),
    (rule) => encodedJson(Schema.encodeUnknownSync(CanonicalAuthorizationRule)(rule)),
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

// Hoisted for the same reason as the two above: a `Schema.*Sync` call sitting
// inside an `Effect.fn` generator turns an encode failure into a defect rather
// than a typed failure. Encoding a value that is already the schema's `Type`
// cannot fail, so the sync form is right — it just belongs out here.
const encodeRelativeRule = (
  rule: RelativeAuthorizationRuleType,
): RelativeAuthorizationRuleEncoded => Schema.encodeUnknownSync(RelativeAuthorizationRule)(rule);

const encodeCanonicalRule = (
  rule: CanonicalAuthorizationRuleType,
): CanonicalAuthorizationRuleEncoded => Schema.encodeUnknownSync(CanonicalAuthorizationRule)(rule);

export const canonicalizePolicyTemplate = (document: PolicyTemplateIRType): string =>
  canonicalizeJson(encodedJson(encodePolicyTemplate(document)));

export const canonicalizeInstalledAuthorization = (
  document: InstalledAuthorizationIRType,
): string => canonicalizeJson(encodedJson(encodeInstalledAuthorization(document)));

/**
 * SHA-256 of RFC 8785 JCS text via Web Crypto. Consumes only
 * schema-encoded JSON — not arbitrary `unknown`.
 */
export const hashCanonicalJson = Effect.fn("Authorization.hashCanonicalJson")(function* (
  json: JsonValue,
) {
  return yield* Effect.tryPromise({
    try: () => sha256Hex(UTF8.encode(canonicalizeJson(json))),
    catch: (cause) =>
      new InvalidIR({
        message: `canonical hash failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
});

export const hashPolicyTemplate = Effect.fn("Authorization.hashPolicyTemplate")(function* (
  document: PolicyTemplateIRType,
) {
  const digest = yield* hashCanonicalJson(encodedJson(encodePolicyTemplate(document)));
  return PolicyHash.make(digest);
});

export const hashInstalledAuthorization = Effect.fn("Authorization.hashInstalledAuthorization")(
  function* (document: InstalledAuthorizationIRType) {
    const digest = yield* hashCanonicalJson(
      omitKey(encodedJson(encodeInstalledAuthorization(document)), "policyHash"),
    );
    return PolicyHash.make(digest);
  },
);

export const hashRelativeRule = Effect.fn("Authorization.hashRelativeRule")(function* (
  rule: RelativeAuthorizationRuleType,
) {
  const digest = yield* hashCanonicalJson(
    omitKey(encodedJson(encodeRelativeRule(rule)), "id"),
  );
  return RuleId.make(digest);
});

export const hashCanonicalRule = Effect.fn("Authorization.hashCanonicalRule")(function* (
  rule: CanonicalAuthorizationRuleType,
) {
  const digest = yield* hashCanonicalJson(
    omitKey(encodedJson(encodeCanonicalRule(rule)), "id"),
  );
  return RuleId.make(digest);
});

/**
 * Schema-encoded IR is JSON by construction. This is the only cast from
 * encode output into {@link JsonValue}; callers must not hash `unknown`.
 */
const encodedJson = (encoded: unknown): JsonValue => encoded as JsonValue;

const decodeDocument = <A>(
  decode: (input: unknown) => Result.Result<A, Schema.SchemaError>,
  encodeRule: (rule: unknown) => JsonValue,
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
  encodeRule: (rule: unknown) => JsonValue,
): InvalidIR | undefined => {
  if (!isTemplate(document) && !isInstalled(document)) {
    return new InvalidIR({ message: "rejected malformed document" });
  }
  const collision =
    internByIdentity(
      document.rules.map((rule) => ({
        id: rule.id,
        body: canonicalizeJson(omitKey(encodeRule(rule), "id")),
      })),
      {
        collision: (id) => `rule identity collision: ${id} maps to different canonical bodies`,
        duplicate: (id) => `duplicate rule identity: ${id}`,
      },
    ) ?? decisionCollisions(document.decisions);
  if (collision !== undefined) return collision;
  if (isInstalled(document)) {
    return (
      identityTableCollisions(document.identities) ??
      operationDescriptorCollisions(document.operations) ??
      traitCompositionCollisions(document.traitComposition) ??
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
  uniqueEncoded(decisions.entities.map((entry) => entry.target), "entity decision target") ??
  uniqueEncoded(decisions.traits.map((entry) => entry.target), "trait decision target") ??
  uniqueEncoded(decisions.fields.map((entry) => entry.target), "field decision target") ??
  uniqueEncoded(decisions.operations.map((entry) => entry.target), "operation decision target");

const identityTableCollisions = (
  identities: InstalledAuthorizationIRType["identities"],
): InvalidIR | undefined =>
  uniqueEncoded(identities.entities, "entity identity") ??
  uniqueEncoded(identities.traits, "trait identity") ??
  uniqueEncoded(identities.fields, "field identity") ??
  uniqueEncoded(identities.operations, "operation identity");

const operationDescriptorCollisions = (
  operations: InstalledAuthorizationIRType["operations"],
): InvalidIR | undefined =>
  internByIdentity(
    operations.map((operation) => {
      const encoded = encodedJson(Schema.encodeUnknownSync(OperationDescriptor)(operation));
      return {
        id: canonicalizeJson(encodedJson(Schema.encodeUnknownSync(OperationId)(operation.id))),
        body: canonicalizeJson(omitKey(encoded, "id")),
      };
    }),
    {
      collision: (id) =>
        `operation identity collision: ${id} maps to different canonical bodies`,
      duplicate: (id) => `duplicate operation identity: ${id}`,
    },
  );

const traitCompositionCollisions = (
  compositions: InstalledAuthorizationIRType["traitComposition"],
): InvalidIR | undefined =>
  internByIdentity(
    compositions.map((row) => {
      const encoded = encodedJson(Schema.encodeUnknownSync(TraitComposition)(row));
      return {
        id: canonicalizeJson(omitKey(encoded, "transitive")),
        body: canonicalizeJson(ownJsonField(encoded, "transitive")),
      };
    }),
    {
      collision: (id) =>
        `trait-composition identity collision: ${id} maps to different canonical bodies`,
      duplicate: (id) => `duplicate trait-composition identity: ${id}`,
    },
  );

const accessPlanCollisions = (
  plans: InstalledAuthorizationIRType["accessPlans"],
): InvalidIR | undefined =>
  internByIdentity(
    plans.map((plan) => ({
      id: plan.rule,
      body: canonicalizeJson(encodedJson({ lookups: plan.lookups })),
    })),
    {
      collision: (id) =>
        `access-plan identity collision: ${id} maps to different canonical bodies`,
      duplicate: (id) => `duplicate access-plan identity: ${id}`,
    },
  );

const internByIdentity = (
  entries: ReadonlyArray<{ readonly id: string; readonly body: string }>,
  labels: {
    readonly collision: (id: string) => string;
    readonly duplicate: (id: string) => string;
  },
): InvalidIR | undefined => {
  const bodies = new Map<string, string>();
  for (const entry of entries) {
    const previous = bodies.get(entry.id);
    if (previous !== undefined && previous !== entry.body) {
      return new InvalidIR({ message: labels.collision(entry.id) });
    }
    if (previous !== undefined) {
      return new InvalidIR({ message: labels.duplicate(entry.id) });
    }
    bodies.set(entry.id, entry.body);
  }
  return undefined;
};

const uniqueEncoded = (values: ReadonlyArray<unknown>, label: string): InvalidIR | undefined => {
  const seen = new Set<string>();
  for (const value of values) {
    const key = canonicalizeJson(encodedJson(value));
    if (seen.has(key)) {
      return new InvalidIR({ message: `duplicate ${label}` });
    }
    seen.add(key);
  }
  return undefined;
};

const omitKey = (encoded: JsonValue, key: string): JsonValue => {
  if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
    return encoded;
  }
  const body: Record<string, JsonValue> = Object.create(null);
  for (const name of Object.keys(encoded)) {
    if (name !== key) body[name] = ownJsonField(encoded, name);
  }
  return body;
};

const ownJsonField = (encoded: JsonValue, key: string): JsonValue => {
  if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
    throw new TypeError("ramose/authorization: expected JSON object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(encoded, key);
  if (descriptor === undefined || descriptor.get !== undefined) {
    throw new TypeError("ramose/authorization: expected own JSON data");
  }
  return descriptor.value as JsonValue;
};

type Work = {
  nodes: number;
  bytes: number;
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
 * Parsed JSON is a tree: a repeated object identity is either a cycle or a
 * DAG alias, and both fail closed. Optional safe alias support is deferred.
 */
const inspectRawJson = (input: unknown): string | undefined => {
  const work: Work = { nodes: 0, bytes: 0 };
  const root = jsonLeafViolation(input, work);
  if (root !== undefined) return root;
  if (typeof input !== "object" || input === null) return undefined;

  // `false` = on the current path (a cycle). `true` = already validated (an alias).
  const seen = new WeakMap<object, boolean>();
  const stack: WalkFrame[] = [];
  const opened = enterObject(input, 0, seen, stack, work);
  if (opened !== undefined) return opened;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = nextChild(frame);
    if (next === undefined) {
      seen.set(frame.value, true);
      stack.pop();
      continue;
    }
    if (next.violation !== undefined) return next.violation;
    const leaf = jsonLeafViolation(next.value, work);
    if (leaf !== undefined) return leaf;
    if (typeof next.value === "object" && next.value !== null) {
      const reason = enterObject(next.value, frame.depth + 1, seen, stack, work);
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
};

const charge = (work: Work, nodes: number, bytes: number): string | undefined => {
  work.nodes += nodes;
  work.bytes += bytes;
  if (work.nodes > MAX_JSON_NODES || work.bytes > MAX_JSON_ENCODED_BYTES) {
    return "rejected oversized document";
  }
  return undefined;
};

const enterObject = (
  value: object,
  depth: number,
  seen: WeakMap<object, boolean>,
  stack: WalkFrame[],
  work: Work,
): string | undefined => {
  const cached = seen.get(value);
  if (cached === false) return "rejected cycle";
  if (cached === true) return "rejected alias";
  if (depth > MAX_JSON_DEPTH) return "rejected oversized depth";
  const shape = objectShapeViolation(value, work);
  if (shape !== undefined) return shape;
  seen.set(value, false);
  if (Array.isArray(value)) {
    stack.push({ value, keys: value.length, index: 0, depth });
  } else {
    stack.push({
      value,
      keys: Object.getOwnPropertyNames(value),
      index: 0,
      depth,
    });
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
  return childFromDescriptor(frame.value, frame.keys[frame.index++]!, false);
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

const objectShapeViolation = (value: object, work: Work): string | undefined => {
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_SIZE) return "rejected oversized collection";
    if (Object.getPrototypeOf(value) !== Array.prototype) return "rejected prototype";
    if (Object.getOwnPropertySymbols(value).length > 0) return "rejected symbol";
    for (const name of Object.getOwnPropertyNames(value)) {
      if (name === "length") continue;
      if (!/^(0|[1-9]\d*)$/.test(name)) return "rejected non-JSON array";
      const index = Number(name);
      if (!Number.isInteger(index) || index < 0 || index >= value.length) {
        return "rejected non-JSON array";
      }
    }
    return charge(work, 1, 0);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    return "rejected prototype";
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length > MAX_COLLECTION_SIZE) return "rejected oversized collection";
  if (Object.getOwnPropertySymbols(value).length > 0) return "rejected symbol";
  const objectCharge = charge(work, 1, 0);
  if (objectCharge !== undefined) return objectCharge;
  for (const name of names) {
    if (name.length > MAX_STRING_LENGTH) return "rejected oversized string";
    if (hasLoneSurrogate(name)) return "rejected unicode";
    const keyCharge = charge(work, 1, UTF8.encode(name).byteLength);
    if (keyCharge !== undefined) return keyCharge;
  }
  return undefined;
};

const jsonLeafViolation = (value: unknown, work: Work): string | undefined => {
  if (value === undefined) return "rejected undefined";
  if (typeof value === "function") return "rejected function";
  if (typeof value === "symbol") return "rejected symbol";
  if (typeof value === "bigint") return "rejected bigint";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "rejected NaN";
    if (!Number.isFinite(value)) return "rejected Infinity";
    return charge(work, 1, stringLengthOfNumber(value));
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) return "rejected oversized string";
    if (hasLoneSurrogate(value)) return "rejected unicode";
    return charge(work, 1, UTF8.encode(value).byteLength);
  }
  if (value === null) return charge(work, 1, 4);
  if (typeof value === "boolean") return charge(work, 1, value ? 4 : 5);
  return undefined;
};

const stringLengthOfNumber = (value: number): number =>
  Object.is(value, -0) || value === 0 ? 1 : String(value).length;

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
