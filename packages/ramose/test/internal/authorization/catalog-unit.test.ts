/**
 * Installed catalog-unit assembly, seal, hash, and fail-closed checks.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  AUTHORIZATION_CATALOG_UNIT_HASH_DOMAIN_V1,
  AUTHORIZATION_LANGUAGE_VERSION,
  AUTHORIZATION_POLICY_HASH_DOMAIN_V1,
  CatalogId,
  CatalogMismatch,
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
  decodeInstalledCatalogUnitResult,
  encodeInstalledCatalogUnit,
  hashDomainSeparatedCanonicalJson,
  hashInstalledCatalogUnit,
  installAuthorization,
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

const catalog = CatalogId.make("app");
const database = DatabaseId.make("todos");
const version = CatalogVersion.make("1");
const fingerprint = SchemaFingerprint.make("schema");

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

const catalogDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
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

const templateOf = (extras: Partial<PolicyTemplateIR> = {}): PolicyTemplateIR => ({
  _tag: "PolicyTemplateIR",
  version: POLICY_TEMPLATE_IR_VERSION,
  languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
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

const install = (descriptor: CatalogDescriptor = catalogDescriptor()) =>
  Effect.runPromise(installAuthorization(bindingInput(descriptor)));

const seal = (descriptor: CatalogDescriptor, policy: InstalledAuthorizationIRV1) =>
  Effect.runPromise(sealInstalledCatalogUnit(descriptor, policy));

const sealFail = (descriptor: CatalogDescriptor, policy: InstalledAuthorizationIRV1) =>
  Effect.runPromise(Effect.flip(sealInstalledCatalogUnit(descriptor, policy)));

const requireSealed = (_unit: InstalledCatalogUnitV1): void => undefined;

describe("sealInstalledCatalogUnit", () => {
  test("seal produces InstalledCatalogUnitV1 with matching identity, tables, and policy", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    requireSealed(unit);
    expect(unit._tag).toBe("InstalledCatalogUnit");
    expect(unit.version).toBe(INSTALLED_CATALOG_UNIT_VERSION);
    expect(unit.languageVersion).toBe(AUTHORIZATION_LANGUAGE_VERSION);
    expect(unit.database).toBe(database);
    expect(unit.catalog).toBe(catalog);
    expect(unit.catalogVersion).toBe(version);
    expect(unit.schemaFingerprint).toBe(fingerprint);
    expect(unit.unitHash).toMatch(/^[0-9a-f]{64}$/);
    expect(unit.identities).toEqual(policy.identities);
    expect(unit.operations).toEqual(policy.operations);
    expect(unit.traitComposition).toEqual(policy.traitComposition);
    expect(unit.entities).toEqual(descriptor.entities);
    expect(unit.traits).toEqual(descriptor.traits);
    expect(unit.fields).toEqual(descriptor.fields);
    expect(unit.policy).toEqual(policy);
    expect(unit.policy._tag).toBe("InstalledAuthorizationIR");
    expect(Object.isFrozen(unit)).toBe(true);
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

  test("descriptor/policy identity drift fails CatalogMismatch", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const drifted = { ...descriptor, id: CatalogId.make("other") };
    const failure = await sealFail(drifted, policy);
    expect(failure).toBeInstanceOf(CatalogMismatch);
    expect(failure.message).toMatch(/catalog does not match/);
  });

  test("policy tables that do not match the descriptor fail closed", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const mutated = {
      ...policy,
      identities: {
        ...policy.identities,
        entities: policy.identities.entities.filter((id) => id.name !== "user"),
      },
    } as InstalledAuthorizationIRV1;
    const failure = await sealFail(descriptor, mutated);
    expect(failure._tag === "CatalogMismatch" || failure._tag === "InvalidIR").toBe(true);
    expect(failure.message).toMatch(/identities|identity/);
  });

  test("unsupported languageVersion fails InvalidIR", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unsupported = {
      ...policy,
      languageVersion: "v0",
    } as unknown as InstalledAuthorizationIRV1;
    const failure = await sealFail(descriptor, unsupported);
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/unsupported authorization language version/);
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

  test("missing policy / missing identity table / corrupt JSON fail closed", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const missingPolicy = assembleInstalledCatalogUnit(descriptor, undefined as unknown as InstalledAuthorizationIR);
    expect(Result.isFailure(missingPolicy)).toBe(true);
    if (Result.isFailure(missingPolicy)) {
      expect(missingPolicy.failure).toBeInstanceOf(InvalidIR);
      expect(missingPolicy.failure.message).toMatch(/missing installed policy/);
    }
    const missingIdentities = assembleInstalledCatalogUnit(descriptor, {
      ...policy,
      identities: undefined,
    } as unknown as InstalledAuthorizationIR);
    expect(Result.isFailure(missingIdentities)).toBe(true);
    if (Result.isFailure(missingIdentities)) {
      expect(missingIdentities.failure.message).toMatch(/identity table/);
    }
    const corrupt = decodeInstalledCatalogUnitResult("{not-json");
    expect(Result.isFailure(corrupt)).toBe(true);
    const notObject = decodeInstalledCatalogUnitResult("not-an-object");
    expect(Result.isFailure(notObject)).toBe(true);
  });

  test("version and fingerprint mismatches populate version/fingerprint fields", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const versionFail = await sealFail({ ...descriptor, version: CatalogVersion.make("9") }, policy);
    expect(versionFail).toBeInstanceOf(CatalogMismatch);
    if (!(versionFail instanceof CatalogMismatch)) return;
    expect(versionFail.expectedVersion).toBe(CatalogVersion.make("9"));
    expect(versionFail.actualVersion).toBe(policy.catalogVersion);
    expect(versionFail.expected).toBeUndefined();
    expect(versionFail.actual).toBeUndefined();
    const fingerprintFail = await sealFail(
      { ...descriptor, fingerprint: SchemaFingerprint.make("other") },
      policy,
    );
    expect(fingerprintFail).toBeInstanceOf(CatalogMismatch);
    if (!(fingerprintFail instanceof CatalogMismatch)) return;
    expect(fingerprintFail.expectedFingerprint).toBe(SchemaFingerprint.make("other"));
    expect(fingerprintFail.actualFingerprint).toBe(policy.schemaFingerprint);
    expect(fingerprintFail.expected).toBeUndefined();
    expect(fingerprintFail.actual).toBeUndefined();
  });

  test("dropping an identity and rehashing still fails verify", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const dropped = {
      ...unit,
      identities: {
        ...unit.identities,
        entities: unit.identities.entities.filter((id) => id.name !== "user"),
      },
    } as InstalledCatalogUnit;
    const droppedHash = await Effect.runPromise(hashInstalledCatalogUnit(dropped));
    const droppedHashed = { ...dropped, unitHash: droppedHash };
    const droppedFail = await Effect.runPromise(Effect.flip(verifyInstalledCatalogUnit(droppedHashed)));
    expect(droppedFail._tag === "CatalogMismatch" || droppedFail._tag === "InvalidIR").toBe(true);
    expect(droppedFail.message).toMatch(/identities|identity/);
    const drifted = {
      ...unit,
      policy: { ...unit.policy, catalog: CatalogId.make("other") },
    } as InstalledCatalogUnit;
    const driftedHash = await Effect.runPromise(hashInstalledCatalogUnit(drifted));
    const driftedFail = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...drifted, unitHash: driftedHash })),
    );
    expect(driftedFail).toBeInstanceOf(CatalogMismatch);
    expect(driftedFail.message).toMatch(/catalog does not match/);
  });

  test("hash mismatch on a tampered document fails closed", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const tampered = {
      ...unit,
      policy: { ...unit.policy, classes: [...unit.policy.classes, "admin"] },
    } as InstalledCatalogUnit;
    const failure = await Effect.runPromise(Effect.flip(verifyInstalledCatalogUnit(tampered)));
    expect(failure._tag).toBe("CatalogUnitCorrupt");
    expect(failure.message).toMatch(/hash mismatch/);
    const wrongHash = {
      ...unit,
      unitHash: digestHex(0x00),
    } as unknown as InstalledCatalogUnit;
    const hashFail = await Effect.runPromise(Effect.flip(verifyInstalledCatalogUnit(wrongHash)));
    expect(hashFail._tag).toBe("CatalogUnitCorrupt");
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
    expect("publishCatalogPolicy" in auth).toBe(false);
    const assembled = assembleInstalledCatalogUnit(descriptor, policy);
    expect(Result.isSuccess(assembled)).toBe(true);
    if (!Result.isSuccess(assembled)) return;
    expect("_tag" in assembled.success).toBe(false);
    expect("unitHash" in assembled.success).toBe(false);
    // @ts-expect-error — unhashed tables are not a sealed catalog unit
    requireSealed(assembled.success);
  });
});
