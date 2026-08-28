/**
 * Installed catalog-unit assembly, seal, hash, and fail-closed checks.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  AUTHORIZATION_CATALOG_UNIT_HASH_DOMAIN_V1,
  AUTHORIZATION_POLICY_HASH_DOMAIN_V1,
  CatalogId,
  CatalogMismatch,
  CatalogUnitCorrupt,
  CatalogVersion,
  DatabaseId,
  EntityId,
  FieldId,
  INSTALLED_CATALOG_UNIT_VERSION,
  InvalidIR,
  OperationId,
  POLICY_TEMPLATE_IR_VERSION,
  RelativeFieldId,
  RuleId,
  SchemaFingerprint,
  TraitId,
  assembleInstalledCatalogUnit,
  canonicalizeInstalledCatalogUnit,
  catalogUnitCanonicalBytes,
  decodeInstalledCatalogUnitResult,
  encodeInstalledCatalogUnit,
  hashCatalogSchemaFingerprint,
  hashDomainSeparatedCanonicalJson,
  hashInstalledAuthorization,
  hashInstalledCatalogUnit,
  installAuthorization,
  normalizeAndValidateCatalogUnit,
  prepareAuthorizationCatalog,
  sealInstalledCatalogUnit,
  verifyInstalledCatalogUnit,
  type CatalogBindingInput,
  type CatalogDescriptor,
  type FieldRefTarget,
  type InstalledAuthorizationIR,
  type InstalledAuthorizationIRV1,
  type InstalledCatalogUnit,
  type InstalledCatalogUnitV1,
  type JsonValue,
  type OwnerRef,
  type PolicyTemplateIR,
} from "../../../src/internal/authorization/index.ts";
import { digestHex } from "./fixtures.ts";
import { operationMetadata } from "./operation-support.ts";

const catalog = CatalogId.make("app");
const database = DatabaseId.make("todos");
const version = CatalogVersion.make("1");

const issueOwner = { kind: "entity" as const, name: "issue" };
const userOwner = { kind: "entity" as const, name: "user" };
const taggableOwner = { kind: "trait" as const, name: "taggable" };

const entity = (name: string) => EntityId.make({ catalog, name });
const trait = (name: string) => TraitId.make({ catalog, name });
const field = (owner: OwnerRef, localName: string) => FieldId.make({ catalog, owner, localName });
const relativeField = (owner: OwnerRef, localName: string) =>
  RelativeFieldId.make({ owner, localName });
const operation = (owner: OwnerRef, localName: string, operationTarget: "required" | "none") =>
  OperationId.make({ catalog, owner, localName, target: operationTarget });

const scalarField = (
  owner: OwnerRef,
  localName: string,
  options: {
    readonly unique?: "upsert" | "strict";
    readonly cardinality?: "one" | "many";
    readonly index?: boolean;
  } = {},
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "string",
  cardinality: options.cardinality ?? "one",
  ...(options.unique === undefined ? {} : { unique: options.unique }),
  index: options.index ?? options.unique !== undefined,
  optional: false,
  owned: false,
});

const refField = (
  owner: OwnerRef,
  localName: string,
  refTarget: FieldRefTarget,
  cardinality: "one" | "many" = "one",
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "ref",
  refTarget,
  cardinality,
  index: false,
  optional: false,
  owned: false,
});

const catalogSchemaTables = (): Omit<CatalogDescriptor, "fingerprint"> => ({
  id: catalog,
  database,
  version,
  entities: [
    { id: entity("user"), traits: [] },
    { id: entity("issue"), traits: [trait("taggable")] },
  ],
  traits: [{ id: trait("taggable"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    refField(issueOwner, "owner", { _tag: "entity", entity: entity("user") }),
    scalarField(issueOwner, "title"),
    refField(taggableOwner, "tags", { _tag: "entity", entity: entity("user") }, "many"),
  ],
  operations: [
    {
      id: operation(issueOwner, "rename", "required"),
      ...operationMetadata(),
      input: {
        _tag: "struct",
        fields: [{ key: "title", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
      },
    },
  ],
  traitComposition: [
    {
      composer: entity("issue"),
      trait: trait("taggable"),
      transitive: [trait("taggable")],
    },
  ],
});

const fingerprint = SchemaFingerprint.make(
  await Effect.runPromise(
    hashCatalogSchemaFingerprint({
      ...catalogSchemaTables(),
      fingerprint: SchemaFingerprint.make("placeholder"),
    }),
  ),
);

const catalogDescriptor = (): CatalogDescriptor => ({
  ...catalogSchemaTables(),
  fingerprint,
});

const richCatalogTables = (): Omit<CatalogDescriptor, "fingerprint"> => ({
  ...catalogSchemaTables(),
  traits: [
    { id: trait("named"), traits: [] },
    { id: trait("taggable"), traits: [] },
  ],
});

const richFingerprint = SchemaFingerprint.make(
  await Effect.runPromise(
    hashCatalogSchemaFingerprint({
      ...richCatalogTables(),
      fingerprint: SchemaFingerprint.make("placeholder"),
    }),
  ),
);

const richCatalogDescriptor = (): CatalogDescriptor => ({
  ...richCatalogTables(),
  fingerprint: richFingerprint,
});

const templateOf = (extras: Partial<PolicyTemplateIR> = {}): PolicyTemplateIR => ({
  _tag: "PolicyTemplateIR",
  version: POLICY_TEMPLATE_IR_VERSION,
  languageVersion: "v1",
  classes: ["member"],
  claims: [{ key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
  principal: { subjectClaim: "sub", entity: relativeField(userOwner, "authId") },
  rules: [
    {
      id: RuleId.make(digestHex(0x11)),
      focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
      expr: {
        _tag: "eq",
        left: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: relativeField(issueOwner, "owner") }],
        },
        right: { _tag: "me" },
      },
      usesResource: true,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
    },
  ],
  decisions: {
    entities: [
      {
        target: { _tag: "RelativeEntityId", name: "issue" },
        decision: { allow: [RuleId.make(digestHex(0x11))], deny: [] },
      },
    ],
    traits: [],
    fields: [],
  },
  ...extras,
});

const richTemplate = (): PolicyTemplateIR =>
  templateOf({
    classes: ["member", "admin"],
    claims: [
      { key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } },
      { key: "role", optional: true, shape: { _tag: "scalar", valueType: "string" } },
    ],
    rules: [
      ...templateOf().rules,
      {
        id: RuleId.make(digestHex(0x22)),
        focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
        expr: { _tag: "hasClass", class: "member" },
        usesResource: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
      },
      {
        id: RuleId.make(digestHex(0x33)),
        focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "user" } },
        expr: { _tag: "hasClass", class: "admin" },
        usesResource: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
      },
      {
        id: RuleId.make(digestHex(0x44)),
        focus: { _tag: "trait", trait: { _tag: "RelativeTraitId", name: "taggable" } },
        expr: { _tag: "hasClass", class: "member" },
        usesResource: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
      },
      {
        id: RuleId.make(digestHex(0x55)),
        focus: { _tag: "trait", trait: { _tag: "RelativeTraitId", name: "named" } },
        expr: { _tag: "hasClass", class: "admin" },
        usesResource: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
      },
      {
        id: RuleId.make(digestHex(0x66)),
        focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
        expr: { _tag: "hasClass", class: "admin" },
        usesResource: false,
        usesMe: false,
        usesSubject: false,
        traversalDepth: 0,
      },
      {
        id: RuleId.make(digestHex(0x77)),
        focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
        expr: { _tag: "eq", left: { _tag: "subject" }, right: { _tag: "lit", value: "banned" } },
        usesResource: false,
        usesMe: false,
        usesSubject: true,
        traversalDepth: 0,
      },
    ],
    decisions: {
      entities: [
        {
          target: { _tag: "RelativeEntityId", name: "issue" },
          decision: {
            allow: [RuleId.make(digestHex(0x11)), RuleId.make(digestHex(0x22))],
            deny: [RuleId.make(digestHex(0x66)), RuleId.make(digestHex(0x77))],
          },
        },
        {
          target: { _tag: "RelativeEntityId", name: "user" },
          decision: { allow: [RuleId.make(digestHex(0x33))], deny: [] },
        },
      ],
      traits: [
        {
          target: { _tag: "RelativeTraitId", name: "taggable" },
          decision: { allow: [RuleId.make(digestHex(0x44))], deny: [] },
        },
        {
          target: { _tag: "RelativeTraitId", name: "named" },
          decision: { allow: [RuleId.make(digestHex(0x55))], deny: [] },
        },
      ],
      fields: [
        {
          target: relativeField(issueOwner, "owner"),
          decision: { allow: [RuleId.make(digestHex(0x11))], deny: [] },
        },
        {
          target: relativeField(issueOwner, "title"),
          decision: { allow: [RuleId.make(digestHex(0x22))], deny: [] },
        },
      ],
    },
  });

const bindingInput = (
  descriptor: CatalogDescriptor = catalogDescriptor(),
  template: PolicyTemplateIR = templateOf(),
): CatalogBindingInput => ({
  target: {
    database: descriptor.database,
    catalog: descriptor.id,
    catalogVersion: descriptor.version,
    schemaFingerprint: descriptor.fingerprint,
  },
  descriptor,
  template,
});

const install = (
  descriptor: CatalogDescriptor = catalogDescriptor(),
  template: PolicyTemplateIR = templateOf(),
) => Effect.runPromise(installAuthorization(bindingInput(descriptor, template)));

const seal = (descriptor: CatalogDescriptor, policy: InstalledAuthorizationIRV1) =>
  Effect.runPromise(sealInstalledCatalogUnit(descriptor, policy));

const sealFail = (descriptor: CatalogDescriptor, policy: InstalledAuthorizationIRV1) =>
  Effect.runPromise(Effect.flip(sealInstalledCatalogUnit(descriptor, policy)));

const requireSealed = (_unit: InstalledCatalogUnitV1): void => undefined;

const rehashPolicyAndUnit = async (document: InstalledCatalogUnit): Promise<InstalledCatalogUnit> => {
  const policyHash = await Effect.runPromise(hashInstalledAuthorization(document.policy));
  const withPolicy = { ...document, policy: { ...document.policy, policyHash } } as InstalledCatalogUnit;
  const unitHash = await Effect.runPromise(hashInstalledCatalogUnit(withPolicy));
  return { ...withPolicy, unitHash };
};

const verifyFail = (document: InstalledCatalogUnit) =>
  Effect.runPromise(Effect.flip(verifyInstalledCatalogUnit(document)));

const patchCatalog = (
  unit: InstalledCatalogUnit,
  patch: Partial<CatalogDescriptor>,
): InstalledCatalogUnit =>
  ({
    ...unit,
    catalog: { ...unit.catalog, ...patch },
  }) as InstalledCatalogUnit;

const unusedTitle = (
  unit: InstalledCatalogUnit,
  patch: Partial<Pick<CatalogDescriptor["fields"][number], "optional" | "index" | "owned" | "valueType">>,
): InstalledCatalogUnit =>
  patchCatalog(unit, {
    fields: unit.catalog.fields.map((entry) =>
      entry.id.localName === "title" && entry.valueType !== "ref" ? { ...entry, ...patch } : entry,
    ) as CatalogDescriptor["fields"],
  });

const expectClosed = (
  failure: unknown,
  pattern: RegExp,
): void => {
  expect(
    failure instanceof InvalidIR ||
      failure instanceof CatalogMismatch ||
      failure instanceof CatalogUnitCorrupt,
  ).toBe(true);
  expect((failure as { readonly message: string }).message).toMatch(pattern);
};

describe("sealInstalledCatalogUnit", () => {
  test("seal produces InstalledCatalogUnitV1 with nested catalog and lean policy", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    requireSealed(unit);
    expect(unit._tag).toBe("InstalledCatalogUnit");
    expect(unit.version).toBe(INSTALLED_CATALOG_UNIT_VERSION);
    expect(unit.catalog.id).toBe(catalog);
    expect(unit.catalog.database).toBe(database);
    expect(unit.catalog.version).toBe(version);
    expect(unit.catalog.fingerprint).toBe(fingerprint);
    expect(unit.unitHash).toMatch(/^[0-9a-f]{64}$/);
    expect(unit.catalog.entities.map((entry) => entry.id.name)).toEqual(["issue", "user"]);
    expect(unit.catalog.traits.map((entry) => entry.id.name)).toEqual(["taggable"]);
    expect(unit.catalog.fields.map((entry) => entry.id.localName)).toEqual([
      "authId",
      "owner",
      "tags",
      "title",
    ]);
    expect(unit.policy).toEqual(policy);
    expect(unit.policy._tag).toBe("InstalledAuthorizationIR");
    expect("database" in unit.policy).toBe(false);
    expect("identities" in unit.policy).toBe(false);
    expect("operations" in unit.policy).toBe(false);
    expect("traitComposition" in unit.policy).toBe(false);
    expect("identities" in unit).toBe(false);
    expect(Object.isFrozen(unit)).toBe(true);
    expect(Object.isFrozen(unit.catalog)).toBe(true);
  });

  test("unitHash is domain-separated SHA-256 of canonical JSON minus unitHash", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const again = await seal(descriptor, policy);
    expect(again.unitHash).toBe(unit.unitHash);
    expect(canonicalizeInstalledCatalogUnit(again)).toBe(canonicalizeInstalledCatalogUnit(unit));
    const recomputed = await Effect.runPromise(hashInstalledCatalogUnit(unit));
    expect(recomputed).toBe(unit.unitHash);
    const encoded = encodeInstalledCatalogUnit(unit);
    const body = { ...encoded } as Record<string, unknown>;
    delete body.unitHash;
    const expected = await Effect.runPromise(
      hashDomainSeparatedCanonicalJson(AUTHORIZATION_CATALOG_UNIT_HASH_DOMAIN_V1, body as JsonValue),
    );
    expect(String(unit.unitHash)).toBe(expected);
    const unprefixed = await Effect.runPromise(
      hashDomainSeparatedCanonicalJson("", body as JsonValue),
    );
    expect(String(unit.unitHash)).not.toBe(unprefixed);
    const policyDomain = await Effect.runPromise(
      hashDomainSeparatedCanonicalJson(AUTHORIZATION_POLICY_HASH_DOMAIN_V1, body as JsonValue),
    );
    expect(String(unit.unitHash)).not.toBe(policyDomain);
    expect(AUTHORIZATION_CATALOG_UNIT_HASH_DOMAIN_V1.endsWith("\0")).toBe(true);
    const decoded = decodeInstalledCatalogUnitResult(encoded);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    // @ts-expect-error — structural decode is not verified catalog unit v1
    requireSealed(decoded.success);
    const verified = await Effect.runPromise(verifyInstalledCatalogUnit(decoded.success));
    requireSealed(verified);
    expect(verified.unitHash).toBe(unit.unitHash);
  });

  test("structural decode is not InstalledCatalogUnitV1", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const decoded = decodeInstalledCatalogUnitResult(encodeInstalledCatalogUnit(unit));
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    // @ts-expect-error — structural decode is not verified catalog unit v1
    requireSealed(decoded.success);
    const structural: InstalledCatalogUnit = decoded.success;
    expect(structural._tag).toBe("InstalledCatalogUnit");
  });

  test("pre-contraction flattened unit fails structural decode", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const encoded = JSON.parse(JSON.stringify(encodeInstalledCatalogUnit(unit))) as ReturnType<
      typeof encodeInstalledCatalogUnit
    >;
    const flattened = {
      _tag: encoded._tag,
      version: encoded.version,
      languageVersion: "v1",
      database: encoded.catalog.database,
      catalog: encoded.catalog.id,
      catalogVersion: encoded.catalog.version,
      schemaFingerprint: encoded.catalog.fingerprint,
      unitHash: encoded.unitHash,
      entities: encoded.catalog.entities,
      traits: encoded.catalog.traits,
      fields: encoded.catalog.fields,
      traitComposition: encoded.catalog.traitComposition,
      identities: {
        entities: encoded.catalog.entities.map((entry) => entry.id),
        traits: encoded.catalog.traits.map((entry) => entry.id),
        fields: encoded.catalog.fields.map((entry) => entry.id),
        operations: encoded.catalog.operations.map((entry) => entry.id),
      },
      operations: encoded.catalog.operations,
      policy: encoded.policy,
    };
    const decoded = decodeInstalledCatalogUnitResult(JSON.parse(JSON.stringify(flattened)));
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure).toBeInstanceOf(InvalidIR);
      expect(decoded.failure.message).toMatch(/catalog|Expected|Struct|string|entities|identities|languageVersion|database/i);
    }
  });

  test("cannot construct a publishable partial unit", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    // @ts-expect-error — policy is required; schema-only is not publishable
    void sealInstalledCatalogUnit(descriptor);
    // @ts-expect-error — descriptor is required; policy-only is not publishable
    void sealInstalledCatalogUnit(undefined, policy);
    const auth = await import("../../../src/internal/authorization/index.ts");
    expect("sealPolicyOnly" in auth).toBe(false);
    expect("sealSchemaOnly" in auth).toBe(false);
    const assembled = assembleInstalledCatalogUnit(descriptor, policy);
    expect(Result.isSuccess(assembled)).toBe(true);
    if (!Result.isSuccess(assembled)) return;
    expect("_tag" in assembled.success).toBe(false);
    expect("unitHash" in assembled.success).toBe(false);
    // @ts-expect-error — unhashed tables are not a sealed catalog unit
    requireSealed(assembled.success);
  });
});

describe("canonicalization", () => {
  test("equivalent units with permuted descriptor tables share canonical bytes and unitHash", async () => {
    const named = trait("named");
    const expandedTables = {
      ...catalogSchemaTables(),
      traits: [
        { id: trait("taggable"), traits: [] },
        { id: named, traits: [] },
      ],
      entities: [
        { id: entity("user"), traits: [] },
        { id: entity("issue"), traits: [trait("taggable"), named] },
      ],
      traitComposition: [
        {
          composer: entity("issue"),
          trait: trait("taggable"),
          transitive: [trait("taggable")],
        },
        {
          composer: entity("issue"),
          trait: named,
          transitive: [named],
        },
      ],
    };
    const expandedFingerprint = SchemaFingerprint.make(
      await Effect.runPromise(
        hashCatalogSchemaFingerprint({
          ...expandedTables,
          fingerprint: SchemaFingerprint.make("placeholder"),
        }),
      ),
    );
    const base: CatalogDescriptor = { ...expandedTables, fingerprint: expandedFingerprint };
    const permuted: CatalogDescriptor = {
      ...base,
      entities: [...base.entities].reverse().map((entry) => ({
        ...entry,
        traits: [...entry.traits].reverse(),
      })),
      traits: [...base.traits].reverse().map((entry) => ({
        ...entry,
        traits: [...entry.traits].reverse(),
      })),
      fields: [...base.fields].reverse(),
    };
    const [left, right] = await Promise.all([
      seal(base, await install(base)),
      seal(permuted, await install(permuted)),
    ]);
    expect(left.catalog.entities.map((entry) => entry.id.name)).toEqual(["issue", "user"]);
    expect(right.catalog.entities.map((entry) => entry.id.name)).toEqual(["issue", "user"]);
    expect(left.catalog.entities.find((entry) => entry.id.name === "issue")?.traits.map((id) => id.name)).toEqual([
      "named",
      "taggable",
    ]);
    expect(left.catalog.fields.map((entry) => entry.id.localName)).toEqual(["authId", "owner", "tags", "title"]);
    expect(left.unitHash).toBe(right.unitHash);
    expect(canonicalizeInstalledCatalogUnit(left)).toBe(canonicalizeInstalledCatalogUnit(right));
    expect(catalogUnitCanonicalBytes(left)).toEqual(catalogUnitCanonicalBytes(right));
  });

  test("nested operation input permutations normalize to identical catalog bytes", async () => {
    const nested = (
      fields: CatalogDescriptor["operations"][number]["input"],
    ): CatalogDescriptor["operations"][number] => ({
      id: operation(issueOwner, "create", "none"),
      ...operationMetadata(),
      input: fields,
    });
    const rename = catalogSchemaTables().operations[0]!;
    const firstShape = {
      _tag: "struct" as const,
      fields: [
        {
          key: "meta",
          optional: false,
          shape: {
            _tag: "struct" as const,
            fields: [
              { key: "title", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
              { key: "name", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
            ],
          },
        },
        {
          key: "labels",
          optional: false,
          shape: {
            _tag: "array" as const,
            items: {
              _tag: "struct" as const,
              fields: [
                { key: "color", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
                { key: "name", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
              ],
            },
          },
        },
      ],
    };
    const permutedShape = {
      _tag: "struct" as const,
      fields: [
        {
          key: "labels",
          optional: false,
          shape: {
            _tag: "array" as const,
            items: {
              _tag: "struct" as const,
              fields: [
                { key: "name", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
                { key: "color", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
              ],
            },
          },
        },
        {
          key: "meta",
          optional: false,
          shape: {
            _tag: "struct" as const,
            fields: [
              { key: "name", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
              { key: "title", optional: false, shape: { _tag: "scalar" as const, valueType: "string" as const } },
            ],
          },
        },
      ],
    };
    const leftTables = { ...catalogSchemaTables(), operations: [rename, nested(firstShape)] };
    const rightTables = { ...catalogSchemaTables(), operations: [rename, nested(permutedShape)] };
    const leftFingerprint = SchemaFingerprint.make(
      await Effect.runPromise(
        hashCatalogSchemaFingerprint({
          ...leftTables,
          fingerprint: SchemaFingerprint.make("placeholder"),
        }),
      ),
    );
    const rightFingerprint = SchemaFingerprint.make(
      await Effect.runPromise(
        hashCatalogSchemaFingerprint({
          ...rightTables,
          fingerprint: SchemaFingerprint.make("placeholder"),
        }),
      ),
    );
    expect(leftFingerprint).toBe(rightFingerprint);
    const left = await seal(
      { ...leftTables, fingerprint: leftFingerprint },
      await install({ ...leftTables, fingerprint: leftFingerprint }),
    );
    const right = await seal(
      { ...rightTables, fingerprint: rightFingerprint },
      await install({ ...rightTables, fingerprint: rightFingerprint }),
    );
    expect(left.unitHash).toBe(right.unitHash);
    expect(left.catalog.fingerprint).toBe(right.catalog.fingerprint);
    const create = left.catalog.operations.find((entry) => entry.id.localName === "create");
    expect(create?.input).toEqual({
      _tag: "struct",
      fields: [
        {
          key: "labels",
          optional: false,
          shape: {
            _tag: "array",
            items: {
              _tag: "struct",
              fields: [
                { key: "color", optional: false, shape: { _tag: "scalar", valueType: "string" } },
                { key: "name", optional: false, shape: { _tag: "scalar", valueType: "string" } },
              ],
            },
          },
        },
        {
          key: "meta",
          optional: false,
          shape: {
            _tag: "struct",
            fields: [
              { key: "name", optional: false, shape: { _tag: "scalar", valueType: "string" } },
              { key: "title", optional: false, shape: { _tag: "scalar", valueType: "string" } },
            ],
          },
        },
      ],
    });
  });

  test("equivalent canonical seals share unitHash", async () => {
    const descriptor = richCatalogDescriptor();
    const [left, right] = await Promise.all([
      seal(descriptor, await install(descriptor, richTemplate())),
      seal(descriptor, await install(descriptor, richTemplate())),
    ]);
    expect(left.policy.classes).toEqual(["admin", "member"]);
    expect(left.policy.claims.map((claim) => claim.key)).toEqual(["org", "role"]);
    expect(left.policy.rules).toHaveLength(7);
    expect(left.unitHash).toBe(right.unitHash);
    expect(canonicalizeInstalledCatalogUnit(left)).toBe(canonicalizeInstalledCatalogUnit(right));
    const verified = await Effect.runPromise(verifyInstalledCatalogUnit(left));
    requireSealed(verified);
    expect(verified.unitHash).toBe(left.unitHash);
  });
});

describe("semantic drift", () => {
  test("policy refs that do not exist in the catalog fail closed", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const drifted = { ...descriptor, id: CatalogId.make("other") };
    const failure = await sealFail(drifted, policy);
    expectClosed(failure, /catalog|stale identity|cross-catalog/);
  });

  test("stale accessPlans fail verify after rehash and fail assemble", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const emptied = {
      ...unit,
      policy: {
        ...unit.policy,
        accessPlans: unit.policy.accessPlans.map((plan) => ({ ...plan, lookups: [] })),
      },
    } as InstalledCatalogUnit;
    const emptiedFail = await verifyFail(await rehashPolicyAndUnit(emptied));
    expectClosed(emptiedFail, /accessPlans|access plan/);
    const assembled = assembleInstalledCatalogUnit(descriptor, emptied.policy);
    expect(Result.isFailure(assembled)).toBe(true);
    if (Result.isFailure(assembled)) expectClosed(assembled.failure, /accessPlans|access plan/);
  });

  test("dropping a required trait or retargeting a ref fails closed", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const droppedTrait: CatalogDescriptor = {
      ...descriptor,
      entities: descriptor.entities.map((entry) =>
        entry.id.name === "issue" ? { ...entry, traits: [] } : entry,
      ),
    };
    const droppedAssemble = assembleInstalledCatalogUnit(droppedTrait, policy);
    expect(Result.isFailure(droppedAssemble)).toBe(true);
    if (Result.isFailure(droppedAssemble)) {
      expectClosed(droppedAssemble.failure, /does not compose trait|missing trait composition/);
    }
    const retargeted: CatalogDescriptor = {
      ...descriptor,
      fields: descriptor.fields.map((entry) =>
        entry.valueType === "ref" && entry.id.localName === "owner"
          ? { ...entry, refTarget: { _tag: "entity" as const, entity: entity("missing") } }
          : entry,
      ),
    };
    const retargetAssemble = assembleInstalledCatalogUnit(retargeted, policy);
    expect(Result.isFailure(retargetAssemble)).toBe(true);
    if (Result.isFailure(retargetAssemble)) {
      expectClosed(retargetAssemble.failure, /missing field ref target/);
    }
  });

  test("changing unused field flags and recomputing only unitHash fails verify", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    for (const patch of [{ optional: true }, { index: true }, { owned: true }, { valueType: "long" }] as const) {
      const tampered = unusedTitle(unit, patch);
      const unitHash = await Effect.runPromise(hashInstalledCatalogUnit(tampered));
      const failure = await verifyFail({ ...tampered, unitHash });
      expect(failure).toBeInstanceOf(CatalogMismatch);
      expect(failure.message).toMatch(/schema fingerprint does not match catalog tables/);
      if (failure instanceof CatalogMismatch) {
        expect(failure.actualFingerprint).toBe(unit.catalog.fingerprint);
        expect(failure.expectedFingerprint).not.toBe(failure.actualFingerprint);
      }
    }
  });

  test("seal rejects descriptor tables that do not match the claimed fingerprint", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const mutated: CatalogDescriptor = {
      ...descriptor,
      fields: descriptor.fields.map((entry) =>
        entry.id.localName === "title" && entry.valueType !== "ref"
          ? { ...entry, optional: true }
          : entry,
      ),
    };
    const digest = await Effect.runPromise(hashCatalogSchemaFingerprint(mutated));
    expect(digest).not.toBe(descriptor.fingerprint);
    const failure = await sealFail(mutated, policy);
    expect(failure).toBeInstanceOf(CatalogMismatch);
    expect(failure.message).toMatch(/schema fingerprint does not match catalog tables/);
    if (failure instanceof CatalogMismatch) {
      expect(failure.expectedFingerprint).toBe(digest);
      expect(failure.actualFingerprint).toBe(descriptor.fingerprint);
    }
  });

  test("changing a decision and recomputing only unitHash fails verify", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const flipped = {
      ...unit,
      policy: {
        ...unit.policy,
        decisions: {
          ...unit.policy.decisions,
          entities: unit.policy.decisions.entities.map((entry) => ({
            ...entry,
            decision: { allow: [], deny: entry.decision.allow },
          })),
        },
      },
    } as InstalledCatalogUnit;
    const unitHash = await Effect.runPromise(hashInstalledCatalogUnit(flipped));
    const failure = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...flipped, unitHash })),
    );
    expect(failure).toBeInstanceOf(CatalogUnitCorrupt);
    expect(failure.message).toMatch(/policy hash|hash mismatch/);
  });

  test("contradictory allow/deny still fails after both hashes are recomputed", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const contradictory = {
      ...unit,
      policy: {
        ...unit.policy,
        decisions: {
          ...unit.policy.decisions,
          entities: unit.policy.decisions.entities.map((entry) => ({
            ...entry,
            decision: { allow: entry.decision.allow, deny: entry.decision.allow },
          })),
        },
      },
    } as InstalledCatalogUnit;
    const failure = await verifyFail(await rehashPolicyAndUnit(contradictory));
    expectClosed(failure, /contradictory|decision|allow and deny/);
  });

  test("flipping a rule usage flag and recomputing unitHash fails verify", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const flippedMe = {
      ...unit,
      policy: {
        ...unit.policy,
        rules: unit.policy.rules.map((rule) => ({ ...rule, usesMe: !rule.usesMe })),
      },
    } as InstalledCatalogUnit;
    const failure = await verifyFail({
      ...flippedMe,
      unitHash: await Effect.runPromise(hashInstalledCatalogUnit(flippedMe)),
    });
    expectClosed(failure, /usesMe|usesResource|rules|accessPlans/);
  });
});

describe("corruption", () => {
  test.each([
    {
      name: "hash mismatch on tampered classes",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        ({
          ...unit,
          policy: { ...unit.policy, classes: ["admin", ...unit.policy.classes] },
        }) as InstalledCatalogUnit,
      rehash: false,
      pattern: /hash mismatch/,
      tag: "CatalogUnitCorrupt",
    },
    {
      name: "wrong unitHash",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        ({ ...unit, unitHash: digestHex(0x00) }) as InstalledCatalogUnit,
      rehash: false,
      pattern: /hash mismatch/,
      tag: "CatalogUnitCorrupt",
    },
    {
      name: "unsupported unit version",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        ({ ...unit, version: 2 }) as unknown as InstalledCatalogUnit,
      rehash: false,
      pattern: /catalog unit version/,
      tag: "InvalidIR",
    },
    {
      name: "unsupported policy version",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        ({
          ...unit,
          policy: { ...unit.policy, version: 2 },
        }) as unknown as InstalledCatalogUnit,
      rehash: false,
      pattern: /installed policy version/,
      tag: "InvalidIR",
    },
    {
      name: "unsupported language version",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        ({
          ...unit,
          policy: { ...unit.policy, languageVersion: "v0" },
        }) as unknown as InstalledCatalogUnit,
      rehash: false,
      pattern: /unsupported authorization language version/,
      tag: "InvalidIR",
    },
    {
      name: "reordered catalog entities",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        patchCatalog(unit, { entities: [...unit.catalog.entities].reverse() }),
      rehash: true,
      pattern: /entities/,
      tag: "CatalogMismatch",
    },
    {
      name: "reordered catalog fields",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        patchCatalog(unit, { fields: [...unit.catalog.fields].reverse() }),
      rehash: true,
      pattern: /fields/,
      tag: "CatalogMismatch",
    },
    {
      name: "reordered policy classes",
      fixture: "rich" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        ({
          ...unit,
          policy: { ...unit.policy, classes: [...unit.policy.classes].reverse() },
        }) as InstalledCatalogUnit,
      rehash: true,
      pattern: /classes/,
      tag: "CatalogMismatch",
    },
    {
      name: "reordered policy accessPlans",
      fixture: "rich" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        ({
          ...unit,
          policy: { ...unit.policy, accessPlans: [...unit.policy.accessPlans].reverse() },
        }) as InstalledCatalogUnit,
      rehash: true,
      pattern: /accessPlans/,
      tag: "CatalogMismatch",
    },
    {
      name: "blank catalog id",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        patchCatalog(unit, { id: CatalogId.make("") }),
      rehash: true,
      pattern: /blank catalog id/,
      tag: "CatalogMismatch",
    },
    {
      name: "blank entity name",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        patchCatalog(unit, {
          entities: [...unit.catalog.entities, { id: EntityId.make({ catalog, name: "" }), traits: [] }],
        }),
      rehash: true,
      pattern: /blank entity name/,
      tag: "InvalidIR",
    },
    {
      name: "blank field local name",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        patchCatalog(unit, {
          fields: [
            ...unit.catalog.fields,
            {
              id: FieldId.make({ catalog, owner: issueOwner, localName: "" }),
              valueType: "string",
              cardinality: "one",
              index: false,
              optional: false,
              owned: false,
            },
          ],
        }),
      rehash: true,
      pattern: /blank field local name/,
      tag: "InvalidIR",
    },
    {
      name: "blank trait name",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        patchCatalog(unit, {
          traits: [{ id: TraitId.make({ catalog, name: "" }), traits: [] }, ...unit.catalog.traits],
        }),
      rehash: true,
      pattern: /blank trait name/,
      tag: "InvalidIR",
    },
    {
      name: "blank operation local name",
      fixture: "simple" as const,
      mutate: (unit: InstalledCatalogUnit) =>
        patchCatalog(unit, {
          operations: [
            {
              id: operation(issueOwner, "", "required"),
              ...operationMetadata(),
              input: { _tag: "scalar", valueType: "string" },
            },
            ...unit.catalog.operations,
          ],
        }),
      rehash: true,
      pattern: /blank operation local name/,
      tag: "InvalidIR",
    },
  ])("$name fails closed", async ({ fixture, mutate, rehash, pattern, tag }) => {
    const descriptor = fixture === "rich" ? richCatalogDescriptor() : catalogDescriptor();
    const template = fixture === "rich" ? richTemplate() : templateOf();
    const policy = await install(descriptor, template);
    const unit = await seal(descriptor, policy);
    const mutated = mutate(unit);
    const document = rehash ? await rehashPolicyAndUnit(mutated) : mutated;
    const failure = await verifyFail(document);
    expect(failure._tag).toBe(tag);
    expect(failure.message).toMatch(pattern);
  });

  test("missing policy / missing accessPlans / corrupt JSON fail closed", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const missingPolicy = assembleInstalledCatalogUnit(
      descriptor,
      undefined as unknown as InstalledAuthorizationIR,
    );
    expect(Result.isFailure(missingPolicy)).toBe(true);
    if (Result.isFailure(missingPolicy)) {
      expect(missingPolicy.failure.message).toMatch(/missing installed policy/);
    }
    const missingAccessPlans = assembleInstalledCatalogUnit(descriptor, {
      ...policy,
      accessPlans: undefined,
    } as unknown as InstalledAuthorizationIR);
    expect(Result.isFailure(missingAccessPlans)).toBe(true);
    if (Result.isFailure(missingAccessPlans)) {
      expect(missingAccessPlans.failure.message).toMatch(/accessPlans/);
    }
    expect(Result.isFailure(decodeInstalledCatalogUnitResult("{not-json"))).toBe(true);
    expect(Result.isFailure(decodeInstalledCatalogUnitResult("not-an-object"))).toBe(true);
  });

  test("structural decode rejects colliding catalog-unit entity descriptors", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const encoded = JSON.parse(JSON.stringify(encodeInstalledCatalogUnit(unit))) as ReturnType<
      typeof encodeInstalledCatalogUnit
    >;
    const issue = encoded.catalog.entities.find((entry) => entry.id.name === "issue");
    expect(issue).toBeDefined();
    const colliding = {
      ...encoded,
      catalog: {
        ...encoded.catalog,
        entities: [...encoded.catalog.entities, JSON.parse(JSON.stringify({ ...issue!, traits: [] }))],
      },
    };
    const decoded = decodeInstalledCatalogUnitResult(colliding);
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure.message).toMatch(/entity identity collision/);
    }
  });

  test("normalizeAndValidateCatalogUnit rejects unsupported versions", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const coherent = normalizeAndValidateCatalogUnit(unit.catalog, unit.policy, unit.version);
    expect(Result.isSuccess(coherent)).toBe(true);
    const unitVersion = normalizeAndValidateCatalogUnit(unit.catalog, unit.policy, 2);
    expect(Result.isFailure(unitVersion)).toBe(true);
    if (Result.isFailure(unitVersion)) {
      expect(unitVersion.failure.message).toMatch(/catalog unit version/);
    }
  });
});

describe("mutation isolation", () => {
  test("caller mutation after seal cannot change the sealed unit", async () => {
    const entities = [...catalogDescriptor().entities];
    const descriptor = { ...catalogDescriptor(), entities };
    const installed = await install(descriptor);
    const classes = [...installed.classes];
    const policy = { ...installed, classes } as InstalledAuthorizationIRV1;
    const unit = await seal(descriptor, policy);
    const originalHash = unit.unitHash;

    classes.push("admin");
    entities.push({ id: entity("extra"), traits: [] });
    expect(unit.policy.classes).toEqual(["member"]);
    expect(unit.catalog.entities.map((entry) => entry.id.name)).toEqual(["issue", "user"]);
    expect(unit.unitHash).toBe(originalHash);
    expect(Object.isFrozen(unit)).toBe(true);
    expect(Object.isFrozen(unit.catalog.entities)).toBe(true);
    expect(Object.isFrozen(unit.policy)).toBe(true);
    expect(() => {
      (unit.policy.classes as string[]).push("support");
    }).toThrow();
    expect(() => {
      (unit.catalog.entities as Array<unknown>).push({});
    }).toThrow();
    expect(() => {
      (unit as { unitHash: string }).unitHash = digestHex(0x00);
    }).toThrow();
    expect("pipe" in unit).toBe(false);
    expect(Object.getPrototypeOf(unit)).toBe(Object.prototype);
  });

  test("assemble snapshots descriptor and policy before the async hash", async () => {
    const entities = [...catalogDescriptor().entities];
    const fields = [...catalogDescriptor().fields];
    const descriptor = { ...catalogDescriptor(), entities, fields };
    const installed = await install(descriptor);
    const rules = [...installed.rules];
    const policy = { ...installed, rules } as InstalledAuthorizationIRV1;
    const assembled = assembleInstalledCatalogUnit(descriptor, policy);
    expect(Result.isSuccess(assembled)).toBe(true);
    if (!Result.isSuccess(assembled)) return;
    expect(assembled.success.catalog.entities).not.toBe(descriptor.entities);
    expect(assembled.success.catalog.fields).not.toBe(descriptor.fields);
    expect(assembled.success.policy.rules).not.toBe(policy.rules);
    expect(Object.isFrozen(assembled.success)).toBe(true);

    const snapshotEntities = assembled.success.catalog.entities.map((entry) => entry.id.name);
    entities.push({ id: entity("extra"), traits: [] });
    entities.reverse();
    fields.reverse();
    rules.push(rules[0]!);
    expect(assembled.success.catalog.entities.map((entry) => entry.id.name)).toEqual(snapshotEntities);
    expect(assembled.success.policy.rules.length).toBe(1);

    const afterMutation = assembleInstalledCatalogUnit(descriptor, policy);
    expect(Result.isFailure(afterMutation)).toBe(true);
  });
});

describe("prepareAuthorizationCatalog still rejects blank target fields", () => {
  test("blank target fingerprint and blank entity name fail", () => {
    const descriptor = catalogDescriptor();
    const target = {
      database: descriptor.database,
      catalog: descriptor.id,
      catalogVersion: descriptor.version,
      schemaFingerprint: descriptor.fingerprint,
    };
    const blankFingerprint = prepareAuthorizationCatalog(
      { ...target, schemaFingerprint: SchemaFingerprint.make("") },
      descriptor,
    );
    expect(Result.isFailure(blankFingerprint)).toBe(true);
    if (Result.isFailure(blankFingerprint)) {
      expect(blankFingerprint.failure.message).toMatch(/blank schema fingerprint/);
    }
    const blankEntity = prepareAuthorizationCatalog(target, {
      ...descriptor,
      entities: [{ id: EntityId.make({ catalog, name: "" }), traits: [] }, ...descriptor.entities],
    });
    expect(Result.isFailure(blankEntity)).toBe(true);
    if (Result.isFailure(blankEntity)) {
      expect(blankEntity.failure.message).toMatch(/blank entity name/);
    }
  });
});
