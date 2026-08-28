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
 * runtime acceptance — template binding is #384; installed decode is
 * not {@link InstalledAuthorizationIRV1}. Revalidation is #368.
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
import {
  EntityDescriptor,
  FieldDescriptor,
  OperationDescriptor,
  TraitComposition,
  TraitDescriptor,
  type CatalogDescriptor,
} from "./catalog.ts";
import {
  InstalledCatalogUnit,
  LegacyInstalledCatalogUnitV1,
  type InstalledCatalogUnit as InstalledCatalogUnitType,
  type LegacyInstalledCatalogUnitV1 as LegacyInstalledCatalogUnitV1Type,
} from "./catalog-unit.ts";
import { InvalidIR } from "./failures.ts";
import {
  CatalogUnitHash,
  EntityId,
  FieldId,
  OperationId,
  PolicyHash,
  RuleId,
  SchemaFingerprint,
  TraitId,
} from "./identities.ts";
import {
  normalizeEntities,
  normalizeFields,
  normalizeOperations,
  normalizeTraitComposition,
  normalizeTraits,
} from "./install/normalize.ts";
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
import {
  AUTHORIZATION_CATALOG_SCHEMA_HASH_DOMAIN_V1,
  AUTHORIZATION_CATALOG_UNIT_HASH_DOMAIN_V2,
  AUTHORIZATION_POLICY_HASH_DOMAIN_V1,
  AUTHORIZATION_RULE_HASH_DOMAIN_V1,
} from "./version.ts";
import { sha256Hex } from "../core/bytes.ts";

const STRICT = { onExcessProperty: "error" as const };
const UTF8 = new TextEncoder();

export type PolicyTemplateIREncoded = typeof PolicyTemplateIR.Encoded;
export type InstalledAuthorizationIREncoded = typeof InstalledAuthorizationIR.Encoded;
export type InstalledCatalogUnitEncoded = typeof InstalledCatalogUnit.Encoded;
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

/** Structural document only. Not {@link InstalledAuthorizationIRV1}. */
export const decodeInstalledAuthorizationResult = (
  input: unknown,
): Result.Result<InstalledAuthorizationIRType, InvalidIR> =>
  decodeDocument(
    Schema.decodeUnknownResult(InstalledAuthorizationIR, STRICT),
    (rule) => encodedJson(Schema.encodeUnknownSync(CanonicalAuthorizationRule)(rule)),
    input,
  );

/** Decode the persisted v1 shape so upgrades fail with a migration diagnostic. */
export const decodeLegacyInstalledCatalogUnitV1Result = (
  input: unknown,
): Result.Result<LegacyInstalledCatalogUnitV1Type, InvalidIR> =>
  decodeDocument(
    Schema.decodeUnknownResult(LegacyInstalledCatalogUnitV1, STRICT),
    (rule) => encodedJson(Schema.encodeUnknownSync(CanonicalAuthorizationRule)(rule)),
    input,
  );

/** Structural v2 document only. Not {@link InstalledCatalogUnitV2}. */
export const decodeInstalledCatalogUnitResult = (
  input: unknown,
): Result.Result<InstalledCatalogUnitType, InvalidIR> => {
  const current = decodeDocument(
    Schema.decodeUnknownResult(InstalledCatalogUnit, STRICT),
    (rule) => encodedJson(Schema.encodeUnknownSync(CanonicalAuthorizationRule)(rule)),
    input,
  );
  if (Result.isSuccess(current)) return current;
  const legacy = decodeLegacyInstalledCatalogUnitV1Result(input);
  if (Result.isSuccess(legacy)) {
    return Result.fail(
      new InvalidIR({
        message:
          legacy.success.catalog.operations.length === 0
            ? "legacy catalog unit v1 requires resealing by deployment"
            : "legacy catalog unit v1 has operation descriptors that cannot be migrated; redeploy the catalog",
      }),
    );
  }
  return current;
};

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

export const decodeInstalledCatalogUnit = Effect.fn("decodeInstalledCatalogUnit")(
  function* (input: unknown): Effect.fn.Return<InstalledCatalogUnitType, InvalidIR> {
    return yield* Effect.fromResult(decodeInstalledCatalogUnitResult(input));
  },
);

export const encodePolicyTemplate = (document: PolicyTemplateIRType): PolicyTemplateIREncoded =>
  Schema.encodeUnknownSync(PolicyTemplateIR)(document);

export const encodeInstalledAuthorization = (
  document: InstalledAuthorizationIRType,
): InstalledAuthorizationIREncoded => Schema.encodeUnknownSync(InstalledAuthorizationIR)(document);

export const encodeInstalledCatalogUnit = (
  document: InstalledCatalogUnitType,
): InstalledCatalogUnitEncoded => Schema.encodeUnknownSync(InstalledCatalogUnit)(document);

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

export const canonicalizeInstalledCatalogUnit = (document: InstalledCatalogUnitType): string =>
  canonicalizeJson(encodedJson(encodeInstalledCatalogUnit(document)));

const concatUtf8 = (prefix: string, text: string): Uint8Array => {
  const left = UTF8.encode(prefix);
  const right = UTF8.encode(text);
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
};

const digestFailure = (cause: unknown): InvalidIR =>
  new InvalidIR({
    message: `canonical hash failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/** JCS text, or {@link InvalidIR} for lone surrogates and other JCS violations. */
const canonicalizeJsonResult = (json: JsonValue): Result.Result<string, InvalidIR> => {
  try {
    return Result.succeed(canonicalizeJson(json));
  } catch (cause) {
    return Result.fail(digestFailure(cause));
  }
};

/**
 * SHA-256 of RFC 8785 JCS text via Web Crypto. Consumes only
 * schema-encoded JSON — not arbitrary `unknown`. Unprefixed; rule and
 * policy identities use {@link hashDomainSeparatedCanonicalJson}.
 */
export const hashCanonicalJson = Effect.fn("Authorization.hashCanonicalJson")(function* (
  json: JsonValue,
) {
  return yield* Effect.tryPromise({
    try: () => sha256Hex(UTF8.encode(canonicalizeJson(json))),
    catch: digestFailure,
  });
});

/**
 * SHA-256 of `domain || RFC 8785 JCS` via Web Crypto. The domain prefix
 * separates rule/policy identities by authorization language version.
 */
export const hashDomainSeparatedCanonicalText = Effect.fn(
  "Authorization.hashDomainSeparatedCanonicalText",
)(function* (domain: string, canonicalText: string) {
  return yield* Effect.tryPromise({
    try: () => sha256Hex(concatUtf8(domain, canonicalText)),
    catch: digestFailure,
  });
});

export const hashDomainSeparatedCanonicalJson = Effect.fn(
  "Authorization.hashDomainSeparatedCanonicalJson",
)(function* (domain: string, json: JsonValue) {
  const canonicalText = yield* Effect.fromResult(canonicalizeJsonResult(json));
  return yield* hashDomainSeparatedCanonicalText(domain, canonicalText);
});

export const hashPolicyTemplate = Effect.fn("Authorization.hashPolicyTemplate")(function* (
  document: PolicyTemplateIRType,
) {
  const digest = yield* hashDomainSeparatedCanonicalJson(
    AUTHORIZATION_POLICY_HASH_DOMAIN_V1,
    encodedJson(encodePolicyTemplate(document)),
  );
  return PolicyHash.make(digest);
});

export const hashInstalledAuthorization = Effect.fn("Authorization.hashInstalledAuthorization")(
  function* (document: InstalledAuthorizationIRType) {
    const digest = yield* hashDomainSeparatedCanonicalJson(
      AUTHORIZATION_POLICY_HASH_DOMAIN_V1,
      omitKey(encodedJson(encodeInstalledAuthorization(document)), "policyHash"),
    );
    return PolicyHash.make(digest);
  },
);

export const hashInstalledCatalogUnit = Effect.fn("Authorization.hashInstalledCatalogUnit")(
  function* (document: InstalledCatalogUnitType) {
    const digest = yield* hashDomainSeparatedCanonicalJson(
      AUTHORIZATION_CATALOG_UNIT_HASH_DOMAIN_V2,
      omitKey(encodedJson(encodeInstalledCatalogUnit(document)), "unitHash"),
    );
    return CatalogUnitHash.make(digest);
  },
);

/**
 * SHA-256 of the normalized catalog schema tables. Material is RFC 8785
 * JCS of `entities` / `traits` / `fields` / `operations` /
 * `traitComposition` after the same normalize pass assemble uses.
 * Identity fields (`id`, `database`, `version`, `fingerprint`) and
 * policy / `unitHash` are excluded so unused field flags participate
 * in {@link SchemaFingerprint} without a live catalog.
 */
export const hashCatalogSchemaFingerprint = Effect.fn(
  "Authorization.hashCatalogSchemaFingerprint",
)(function* (
  tables: Pick<CatalogDescriptor, "entities" | "traits" | "fields" | "operations" | "traitComposition"> &
    Partial<Pick<CatalogDescriptor, "id" | "database" | "version" | "fingerprint">>,
) {
  const [entities, traits, fields, operations, traitComposition] = yield* Effect.fromResult(
    Result.all([
      normalizeEntities(tables.entities),
      normalizeTraits(tables.traits),
      normalizeFields(tables.fields),
      normalizeOperations(tables.operations),
      normalizeTraitComposition(tables.traitComposition),
    ]),
  );
  const digest = yield* hashDomainSeparatedCanonicalJson(
    AUTHORIZATION_CATALOG_SCHEMA_HASH_DOMAIN_V1,
    encodedJson({
      entities: entities.map((entity) => Schema.encodeUnknownSync(EntityDescriptor)(entity)),
      traits: traits.map((trait) => Schema.encodeUnknownSync(TraitDescriptor)(trait)),
      fields: fields.map((field) => Schema.encodeUnknownSync(FieldDescriptor)(field)),
      operations: operations.map((operation) =>
        Schema.encodeUnknownSync(OperationDescriptor)(operation),
      ),
      traitComposition: traitComposition.map((row) =>
        Schema.encodeUnknownSync(TraitComposition)(row),
      ),
    }),
  );
  return SchemaFingerprint.make(digest);
});

export const hashRelativeRule = Effect.fn("Authorization.hashRelativeRule")(function* (
  rule: RelativeAuthorizationRuleType,
) {
  const digest = yield* hashDomainSeparatedCanonicalJson(
    AUTHORIZATION_RULE_HASH_DOMAIN_V1,
    omitKey(encodedJson(encodeRelativeRule(rule)), "id"),
  );
  return RuleId.make(digest);
});

export const hashCanonicalRule = Effect.fn("Authorization.hashCanonicalRule")(function* (
  rule: CanonicalAuthorizationRuleType,
) {
  const material = yield* Effect.fromResult(canonicalAuthorizationRuleMaterial(rule));
  const digest = yield* hashDomainSeparatedCanonicalText(
    AUTHORIZATION_RULE_HASH_DOMAIN_V1,
    material,
  );
  return RuleId.make(digest);
});

/**
 * Canonical rule body for {@link RuleId}: schema-encoded JSON minus `id`.
 * The semantic kernel produces this material; the Effect shell hashes it.
 */
export const canonicalAuthorizationRuleJson = (
  rule: CanonicalAuthorizationRuleType,
): JsonValue => omitKey(encodedJson(encodeCanonicalRule(rule)), "id");

/**
 * RFC 8785 JCS of the canonical rule body. JCS-invalid strings (lone
 * surrogates) become {@link InvalidIR} instead of throwing.
 */
export const canonicalAuthorizationRuleMaterial = (
  rule: CanonicalAuthorizationRuleType,
): Result.Result<string, InvalidIR> => canonicalizeJsonResult(canonicalAuthorizationRuleJson(rule));

/**
 * Schema-encoded IR is JSON by construction. This is the only cast from
 * encode output into {@link JsonValue}; callers must not hash `unknown`.
 */
const encodedJson = (encoded: unknown): JsonValue => encoded as JsonValue;

const decodeDocument = <A>(
  decode: (input: unknown) => Result.Result<A, Schema.SchemaError>,
  encodeRule: (rule: unknown) => JsonValue,
  input: unknown,
): Result.Result<A, InvalidIR> =>
  Result.gen(function* () {
    const hostile = inspectRawJson(input);
    if (hostile !== undefined) {
      return yield* Result.fail(new InvalidIR({ message: hostile }));
    }
    const json = yield* Result.mapError(
      Schema.decodeUnknownResult(Schema.Json)(input),
      (failure) => new InvalidIR({ message: failure.message }),
    );
    const decoded = yield* Result.mapError(
      decode(json),
      (failure) => new InvalidIR({ message: failure.message }),
    );
    const collision = identityCollision(decoded, encodeRule);
    if (collision !== undefined) {
      return yield* Result.fail(collision);
    }
    return freezePlain(decoded);
  });

const identityCollision = (
  document: unknown,
  encodeRule: (rule: unknown) => JsonValue,
): InvalidIR | undefined => {
  if (isCatalogUnit(document)) {
    return (
      entityDescriptorCollisions(document.catalog.entities) ??
      traitDescriptorCollisions(document.catalog.traits) ??
      fieldDescriptorCollisions(document.catalog.fields) ??
      operationDescriptorCollisions(document.catalog.operations) ??
      traitCompositionCollisions(document.catalog.traitComposition) ??
      identityCollision(document.policy, encodeRule)
    );
  }
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
    return accessPlanCollisions(document.accessPlans);
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

const isCatalogUnit = (document: unknown): document is InstalledCatalogUnitType =>
  typeof document === "object" &&
  document !== null &&
  (document as { readonly _tag?: unknown })._tag === "InstalledCatalogUnit";

const decisionCollisions = (decisions: {
  readonly entities: ReadonlyArray<{ readonly target: unknown }>;
  readonly traits: ReadonlyArray<{ readonly target: unknown }>;
  readonly fields: ReadonlyArray<{ readonly target: unknown }>;
}): InvalidIR | undefined =>
  uniqueEncoded(decisions.entities.map((entry) => entry.target), "entity decision target") ??
  uniqueEncoded(decisions.traits.map((entry) => entry.target), "trait decision target") ??
  uniqueEncoded(decisions.fields.map((entry) => entry.target), "field decision target");

const entityDescriptorCollisions = (
  entities: CatalogDescriptor["entities"],
): InvalidIR | undefined =>
  internByIdentity(
    entities.map((entity) => {
      const encoded = encodedJson(Schema.encodeUnknownSync(EntityDescriptor)(entity));
      return {
        id: canonicalizeJson(encodedJson(Schema.encodeUnknownSync(EntityId)(entity.id))),
        body: canonicalizeJson(omitKey(encoded, "id")),
      };
    }),
    {
      collision: (id) => `entity identity collision: ${id} maps to different canonical bodies`,
      duplicate: (id) => `duplicate entity identity: ${id}`,
    },
  );

const traitDescriptorCollisions = (
  traits: CatalogDescriptor["traits"],
): InvalidIR | undefined =>
  internByIdentity(
    traits.map((trait) => {
      const encoded = encodedJson(Schema.encodeUnknownSync(TraitDescriptor)(trait));
      return {
        id: canonicalizeJson(encodedJson(Schema.encodeUnknownSync(TraitId)(trait.id))),
        body: canonicalizeJson(omitKey(encoded, "id")),
      };
    }),
    {
      collision: (id) => `trait identity collision: ${id} maps to different canonical bodies`,
      duplicate: (id) => `duplicate trait identity: ${id}`,
    },
  );

const fieldDescriptorCollisions = (
  fields: CatalogDescriptor["fields"],
): InvalidIR | undefined =>
  internByIdentity(
    fields.map((field) => {
      const encoded = encodedJson(Schema.encodeUnknownSync(FieldDescriptor)(field));
      return {
        id: canonicalizeJson(encodedJson(Schema.encodeUnknownSync(FieldId)(field.id))),
        body: canonicalizeJson(omitKey(encoded, "id")),
      };
    }),
    {
      collision: (id) => `field identity collision: ${id} maps to different canonical bodies`,
      duplicate: (id) => `duplicate field identity: ${id}`,
    },
  );

const operationDescriptorCollisions = (
  operations: ReadonlyArray<{ readonly id: OperationId }>,
): InvalidIR | undefined =>
  internByIdentity(
    operations.map((operation) => {
      // Both persisted v1 rows and current rows have already crossed a strict
      // schema decode, so canonicalize the decoded row without forcing the v2
      // operation codec onto the legacy shape.
      const encoded = encodedJson(operation);
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
  compositions: CatalogDescriptor["traitComposition"],
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
