import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { canonicalizeJson } from "./canonical-json.ts";
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
  AUTHORIZATION_POLICY_HASH_DOMAIN_V2,
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

export const decodeInstalledAuthorizationResult = (
  input: unknown,
): Result.Result<InstalledAuthorizationIRType, InvalidIR> =>
  decodeDocument(
    Schema.decodeUnknownResult(InstalledAuthorizationIR, STRICT),
    (rule) => encodedJson(Schema.encodeUnknownSync(CanonicalAuthorizationRule)(rule)),
    input,
  );

export const decodeLegacyInstalledCatalogUnitV1Result = (
  input: unknown,
): Result.Result<LegacyInstalledCatalogUnitV1Type, InvalidIR> =>
  decodeDocument(
    Schema.decodeUnknownResult(LegacyInstalledCatalogUnitV1, STRICT),
    (rule) => encodedJson(Schema.encodeUnknownSync(CanonicalAuthorizationRule)(rule)),
    input,
  );

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

const canonicalizeJsonResult = (json: JsonValue): Result.Result<string, InvalidIR> => {
  try {
    return Result.succeed(canonicalizeJson(json));
  } catch (cause) {
    return Result.fail(digestFailure(cause));
  }
};

export const hashCanonicalJson = Effect.fn("Authorization.hashCanonicalJson")(function* (
  json: JsonValue,
) {
  return yield* Effect.tryPromise({
    try: () => sha256Hex(UTF8.encode(canonicalizeJson(json))),
    catch: digestFailure,
  });
});

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
    AUTHORIZATION_POLICY_HASH_DOMAIN_V2,
    encodedJson(encodePolicyTemplate(document)),
  );
  return PolicyHash.make(digest);
});

export const hashInstalledAuthorization = Effect.fn("Authorization.hashInstalledAuthorization")(
  function* (document: InstalledAuthorizationIRType) {
    const digest = yield* hashDomainSeparatedCanonicalJson(
      AUTHORIZATION_POLICY_HASH_DOMAIN_V2,
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

export const canonicalAuthorizationRuleJson = (
  rule: CanonicalAuthorizationRuleType,
): JsonValue => omitKey(encodedJson(encodeCanonicalRule(rule)), "id");

export const canonicalAuthorizationRuleMaterial = (
  rule: CanonicalAuthorizationRuleType,
): Result.Result<string, InvalidIR> => canonicalizeJsonResult(canonicalAuthorizationRuleJson(rule));

const encodedJson = (encoded: unknown): JsonValue => encoded as JsonValue;

const decodeDocument = <A>(
  decode: (input: unknown) => Result.Result<A, Schema.SchemaError>,
  encodeRule: (rule: unknown) => JsonValue,
  input: unknown,
): Result.Result<A, InvalidIR> =>
  Result.gen(function* () {
    const json = yield* Result.mapError(
      Schema.decodeUnknownResult(Schema.Json)(input),
      (failure) => new InvalidIR({ message: failure.message }),
    );
    const decoded = yield* Result.mapError(
      decode(json),
      (failure) => new InvalidIR({ message: failure.message }),
    );
    const collision = yield* Result.try({
      try: () => identityCollision(decoded, encodeRule),
      catch: digestFailure,
    });
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
  readonly operations?: ReadonlyArray<{ readonly target: unknown }>;
}): InvalidIR | undefined =>
  uniqueEncoded(decisions.entities.map((entry) => entry.target), "entity decision target") ??
  uniqueEncoded(decisions.traits.map((entry) => entry.target), "trait decision target") ??
  uniqueEncoded(decisions.fields.map((entry) => entry.target), "field decision target") ??
  uniqueEncoded((decisions.operations ?? []).map((entry) => entry.target), "operation decision target");

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
