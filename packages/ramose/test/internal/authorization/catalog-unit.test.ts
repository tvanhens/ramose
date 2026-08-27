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
  prepareAuthorizationCatalog,
  requireUnitCoherence,
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
    expect(unit.entities.map((entry) => entry.id.name)).toEqual(["issue", "user"]);
    expect(unit.traits.map((entry) => entry.id.name)).toEqual(["taggable"]);
    expect(unit.fields.map((entry) => entry.id.localName)).toEqual(["authId", "owner", "tags", "title"]);
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
    const missingAccessPlans = assembleInstalledCatalogUnit(descriptor, {
      ...policy,
      accessPlans: undefined,
    } as unknown as InstalledAuthorizationIR);
    expect(Result.isFailure(missingAccessPlans)).toBe(true);
    if (Result.isFailure(missingAccessPlans)) {
      expect(missingAccessPlans.failure).toBeInstanceOf(InvalidIR);
      expect(missingAccessPlans.failure.message).toMatch(/accessPlans/);
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

  test("dropping a required trait or retargeting a ref fails closed while identity ids stay", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const droppedTrait: CatalogDescriptor = {
      ...descriptor,
      entities: descriptor.entities.map((entry) =>
        entry.id.name === "issue" ? { ...entry, traits: [] } : entry,
      ),
    };
    expect(droppedTrait.entities.map((entry) => entry.id)).toEqual(descriptor.entities.map((entry) => entry.id));
    const droppedAssemble = assembleInstalledCatalogUnit(droppedTrait, policy);
    expect(Result.isFailure(droppedAssemble)).toBe(true);
    if (Result.isFailure(droppedAssemble)) {
      expect(droppedAssemble.failure._tag === "InvalidIR" || droppedAssemble.failure._tag === "CatalogMismatch").toBe(
        true,
      );
      expect(droppedAssemble.failure.message).toMatch(/does not compose trait|missing trait composition/);
    }
    const droppedDocument = {
      ...unit,
      entities: droppedTrait.entities,
    } as InstalledCatalogUnit;
    const droppedHash = await Effect.runPromise(hashInstalledCatalogUnit(droppedDocument));
    const droppedVerify = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...droppedDocument, unitHash: droppedHash })),
    );
    expect(droppedVerify._tag === "InvalidIR" || droppedVerify._tag === "CatalogMismatch").toBe(true);
    expect(droppedVerify.message).toMatch(/does not compose trait|missing trait composition/);

    const retargeted: CatalogDescriptor = {
      ...descriptor,
      fields: descriptor.fields.map((entry) =>
        entry.valueType === "ref" && entry.id.localName === "owner"
          ? { ...entry, refTarget: { _tag: "entity" as const, entity: entity("missing") } }
          : entry,
      ),
    };
    expect(retargeted.fields.map((entry) => entry.id)).toEqual(descriptor.fields.map((entry) => entry.id));
    const retargetAssemble = assembleInstalledCatalogUnit(retargeted, policy);
    expect(Result.isFailure(retargetAssemble)).toBe(true);
    if (Result.isFailure(retargetAssemble)) {
      expect(retargetAssemble.failure._tag === "InvalidIR" || retargetAssemble.failure._tag === "CatalogMismatch").toBe(
        true,
      );
      expect(retargetAssemble.failure.message).toMatch(/missing field ref target/);
    }
  });

  test("stale accessPlans fail verify after rehash and fail assemble", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    expect(unit.policy.accessPlans.length).toBeGreaterThan(0);
    const ownerPlan = unit.policy.accessPlans[0]!;
    expect(ownerPlan.rule).toBe(unit.policy.rules[0]!.id);
    expect(ownerPlan.lookups).toEqual(
      expect.arrayContaining([
        { _tag: "entity", entity: entity("issue") },
        { _tag: "field", field: field(issueOwner, "owner") },
        { _tag: "principal", field: field(userOwner, "authId") },
      ]),
    );
    expect(ownerPlan.lookups.length).toBeGreaterThan(0);

    const emptiedLookups = {
      ...unit,
      policy: {
        ...unit.policy,
        accessPlans: unit.policy.accessPlans.map((plan) => ({ ...plan, lookups: [] })),
      },
    } as InstalledCatalogUnit;
    expect(emptiedLookups.identities).toEqual(unit.identities);
    expect(emptiedLookups.entities).toEqual(unit.entities);
    expect(emptiedLookups.fields).toEqual(unit.fields);
    const emptiedHash = await Effect.runPromise(hashInstalledCatalogUnit(emptiedLookups));
    const emptiedFail = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...emptiedLookups, unitHash: emptiedHash })),
    );
    expect(emptiedFail._tag === "CatalogMismatch" || emptiedFail._tag === "InvalidIR").toBe(true);
    expect(emptiedFail.message).toMatch(/accessPlans|access plan/);

    const extraLookup = {
      ...unit,
      policy: {
        ...unit.policy,
        accessPlans: unit.policy.accessPlans.map((plan) => ({
          ...plan,
          lookups: [...plan.lookups, { _tag: "field" as const, field: field(issueOwner, "title") }],
        })),
      },
    } as InstalledCatalogUnit;
    const extraHash = await Effect.runPromise(hashInstalledCatalogUnit(extraLookup));
    const extraFail = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...extraLookup, unitHash: extraHash })),
    );
    expect(extraFail._tag === "CatalogMismatch" || extraFail._tag === "InvalidIR").toBe(true);
    expect(extraFail.message).toMatch(/accessPlans|access plan/);

    const droppedPlan = {
      ...unit,
      policy: {
        ...unit.policy,
        accessPlans: [],
      },
    } as InstalledCatalogUnit;
    const droppedHash = await Effect.runPromise(hashInstalledCatalogUnit(droppedPlan));
    const droppedFail = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...droppedPlan, unitHash: droppedHash })),
    );
    expect(droppedFail._tag === "CatalogMismatch" || droppedFail._tag === "InvalidIR").toBe(true);
    expect(droppedFail.message).toMatch(/accessPlans|access plan/);

    const emptiedAssemble = assembleInstalledCatalogUnit(descriptor, emptiedLookups.policy);
    expect(Result.isFailure(emptiedAssemble)).toBe(true);
    if (Result.isFailure(emptiedAssemble)) {
      expect(
        emptiedAssemble.failure._tag === "CatalogMismatch" || emptiedAssemble.failure._tag === "InvalidIR",
      ).toBe(true);
      expect(emptiedAssemble.failure.message).toMatch(/accessPlans|access plan/);
    }
    const extraAssemble = assembleInstalledCatalogUnit(descriptor, extraLookup.policy);
    expect(Result.isFailure(extraAssemble)).toBe(true);
    if (Result.isFailure(extraAssemble)) {
      expect(extraAssemble.failure.message).toMatch(/accessPlans|access plan/);
    }
    const droppedAssemble = assembleInstalledCatalogUnit(descriptor, droppedPlan.policy);
    expect(Result.isFailure(droppedAssemble)).toBe(true);
    if (Result.isFailure(droppedAssemble)) {
      expect(droppedAssemble.failure.message).toMatch(/accessPlans|access plan/);
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
    expect(unitHash).not.toBe(unit.unitHash);
    expect(flipped.policy.policyHash).toBe(unit.policy.policyHash);
    const failure = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...flipped, unitHash })),
    );
    expect(failure).toBeInstanceOf(CatalogUnitCorrupt);
    expect(failure.message).toMatch(/policy hash|hash mismatch/);
    const verified = await Effect.runPromise(verifyInstalledCatalogUnit(unit));
    requireSealed(verified);
    expect(verified.unitHash).toBe(unit.unitHash);
  });

  test("changing a decision and recomputing policy and unit hashes still fails when inconsistent", async () => {
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
    expect(contradictory.policy.rules).toEqual(unit.policy.rules);
    expect(contradictory.policy.accessPlans).toEqual(unit.policy.accessPlans);
    const policyHash = await Effect.runPromise(hashInstalledAuthorization(contradictory.policy));
    const hashedPolicy = { ...contradictory, policy: { ...contradictory.policy, policyHash } };
    const unitHash = await Effect.runPromise(hashInstalledCatalogUnit(hashedPolicy));
    const failure = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...hashedPolicy, unitHash })),
    );
    expect(failure._tag === "InvalidIR" || failure._tag === "CatalogMismatch").toBe(true);
    expect(failure.message).toMatch(/contradictory|decision|allow and deny/);
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
    const flippedMeHash = await Effect.runPromise(hashInstalledCatalogUnit(flippedMe));
    const flippedMeFail = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...flippedMe, unitHash: flippedMeHash })),
    );
    expect(flippedMeFail._tag === "InvalidIR" || flippedMeFail._tag === "CatalogMismatch").toBe(true);
    expect(flippedMeFail.message).toMatch(/usesMe|usesResource|rules|accessPlans/);

    const flippedSubject = {
      ...unit,
      policy: {
        ...unit.policy,
        rules: unit.policy.rules.map((rule) => ({ ...rule, usesSubject: !rule.usesSubject })),
      },
    } as InstalledCatalogUnit;
    const flippedSubjectHash = await Effect.runPromise(hashInstalledCatalogUnit(flippedSubject));
    const flippedSubjectFail = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...flippedSubject, unitHash: flippedSubjectHash })),
    );
    expect(flippedSubjectFail._tag === "InvalidIR" || flippedSubjectFail._tag === "CatalogMismatch").toBe(
      true,
    );
    expect(flippedSubjectFail.message).toMatch(/usesSubject|usesMe|usesResource|rules/);
  });

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
    expect(unit.entities.map((entry) => entry.id.name)).toEqual(["issue", "user"]);
    expect(unit.unitHash).toBe(originalHash);

    expect(Object.isFrozen(unit)).toBe(true);
    expect(Object.isFrozen(unit.entities)).toBe(true);
    expect(Object.isFrozen(unit.policy)).toBe(true);
    expect(Object.isFrozen(unit.policy.classes)).toBe(true);
    expect(() => {
      (unit.policy.classes as string[]).push("support");
    }).toThrow();
    expect(() => {
      (unit.entities as Array<unknown>).push({});
    }).toThrow();
    expect(() => {
      (unit as { unitHash: string }).unitHash = digestHex(0x00);
    }).toThrow();
    expect("pipe" in unit).toBe(false);
    expect(Object.getPrototypeOf(unit)).toBe(Object.prototype);
  });

  test("assemble and seal snapshot descriptor and policy before the async hash", async () => {
    const entities = [...catalogDescriptor().entities];
    const descriptor = { ...catalogDescriptor(), entities };
    const installed = await install(descriptor);
    const classes = [...installed.classes];
    const policy = { ...installed, classes } as InstalledAuthorizationIRV1;
    const assembled = assembleInstalledCatalogUnit(descriptor, policy);
    expect(Result.isSuccess(assembled)).toBe(true);
    if (!Result.isSuccess(assembled)) return;

    classes.push("admin");
    entities.push({ id: entity("extra"), traits: [] });
    expect(assembled.success.policy.classes).toEqual(["member"]);
    expect(assembled.success.entities.map((entry) => entry.id.name)).toEqual(["issue", "user"]);
    expect(Object.isFrozen(assembled.success)).toBe(true);
    expect(Object.isFrozen(assembled.success.policy)).toBe(true);
    expect(Object.isFrozen(assembled.success.entities)).toBe(true);

    const unit = await seal(catalogDescriptor(), await install());
    expect(unit.policy.classes).toEqual(["member"]);
    expect(unit.entities.map((entry) => entry.id.name)).toEqual(["issue", "user"]);
    const again = await seal(catalogDescriptor(), await install());
    expect(unit.unitHash).toBe(again.unitHash);
    expect(canonicalizeInstalledCatalogUnit(unit)).toBe(canonicalizeInstalledCatalogUnit(again));
  });

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
    const base: CatalogDescriptor = {
      ...expandedTables,
      fingerprint: expandedFingerprint,
    };
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
    expect(left.entities.map((entry) => entry.id.name)).toEqual(["issue", "user"]);
    expect(right.entities.map((entry) => entry.id.name)).toEqual(["issue", "user"]);
    expect(left.entities.find((entry) => entry.id.name === "issue")?.traits.map((id) => id.name)).toEqual([
      "named",
      "taggable",
    ]);
    expect(right.entities.find((entry) => entry.id.name === "issue")?.traits.map((id) => id.name)).toEqual([
      "named",
      "taggable",
    ]);
    expect(left.traits.map((entry) => entry.id.name)).toEqual(["named", "taggable"]);
    expect(right.traits.map((entry) => entry.id.name)).toEqual(["named", "taggable"]);
    expect(left.fields.map((entry) => entry.id.localName)).toEqual(["authId", "owner", "tags", "title"]);
    expect(right.fields.map((entry) => entry.id.localName)).toEqual(["authId", "owner", "tags", "title"]);
    expect(left.unitHash).toBe(right.unitHash);
    expect(canonicalizeInstalledCatalogUnit(left)).toBe(canonicalizeInstalledCatalogUnit(right));
    expect(catalogUnitCanonicalBytes(left)).toEqual(catalogUnitCanonicalBytes(right));
  });

  test("verify rejects a reordered entities table after unitHash recompute", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    expect(unit.entities.map((entry) => entry.id.name)).toEqual(["issue", "user"]);
    const reordered = {
      ...unit,
      entities: [...unit.entities].reverse(),
    } as InstalledCatalogUnit;
    expect(reordered.entities.map((entry) => entry.id.name)).toEqual(["user", "issue"]);
    const unitHash = await Effect.runPromise(hashInstalledCatalogUnit(reordered));
    const failure = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...reordered, unitHash })),
    );
    expect(failure).toBeInstanceOf(CatalogMismatch);
    expect(failure.message).toMatch(/entities/);
  });

  test("policy.identities that drift from unit.identities fail CatalogMismatch after rehash", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const driftedPolicy = {
      ...unit.policy,
      identities: {
        ...unit.policy.identities,
        entities: unit.policy.identities.entities.filter((id) => id.name !== "user"),
      },
    };
    expect(driftedPolicy.identities.entities.map((id) => id.name)).not.toEqual(
      unit.identities.entities.map((id) => id.name),
    );
    const policyHash = await Effect.runPromise(hashInstalledAuthorization(driftedPolicy));
    const drifted = {
      ...unit,
      policy: { ...driftedPolicy, policyHash },
    } as InstalledCatalogUnit;
    const unitHash = await Effect.runPromise(hashInstalledCatalogUnit(drifted));
    const failure = await Effect.runPromise(
      Effect.flip(verifyInstalledCatalogUnit({ ...drifted, unitHash })),
    );
    expect(failure).toBeInstanceOf(CatalogMismatch);
    expect(failure.message).toMatch(/identities/);
  });

  test("assembled tables do not alias caller arrays and snapshot at entry", async () => {
    const entities = [...catalogDescriptor().entities];
    const fields = [...catalogDescriptor().fields];
    const descriptor = { ...catalogDescriptor(), entities, fields };
    const installed = await install(descriptor);
    const rules = [...installed.rules];
    const policy = { ...installed, rules } as InstalledAuthorizationIRV1;
    const assembled = assembleInstalledCatalogUnit(descriptor, policy);
    expect(Result.isSuccess(assembled)).toBe(true);
    if (!Result.isSuccess(assembled)) return;
    expect(assembled.success.entities).not.toBe(descriptor.entities);
    expect(assembled.success.fields).not.toBe(descriptor.fields);
    expect(assembled.success.policy.rules).not.toBe(policy.rules);
    expect(Object.isFrozen(assembled.success)).toBe(true);

    const snapshotEntities = assembled.success.entities.map((entry) => entry.id.name);
    const snapshotFieldCount = assembled.success.fields.length;
    const snapshotRuleCount = assembled.success.policy.rules.length;
    entities.push({ id: entity("extra"), traits: [] });
    entities.reverse();
    fields.reverse();
    rules.push(rules[0]!);
    expect(assembled.success.entities.map((entry) => entry.id.name)).toEqual(snapshotEntities);
    expect(assembled.success.fields.length).toBe(snapshotFieldCount);
    expect(assembled.success.policy.rules.length).toBe(snapshotRuleCount);

    const afterMutation = assembleInstalledCatalogUnit(descriptor, policy);
    expect(Result.isFailure(afterMutation)).toBe(true);
  });

  test("requireUnitCoherence rejects unsupported unit and policy shape versions", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const coherent = requireUnitCoherence(unit);
    expect(Result.isSuccess(coherent)).toBe(true);
    const unitVersion = requireUnitCoherence({ ...unit, version: 2 } as unknown as InstalledCatalogUnit);
    expect(Result.isFailure(unitVersion)).toBe(true);
    if (Result.isFailure(unitVersion)) {
      expect(unitVersion.failure).toBeInstanceOf(InvalidIR);
      expect(unitVersion.failure.message).toMatch(/catalog unit version/);
    }
    const policyVersion = requireUnitCoherence({
      ...unit,
      policy: { ...unit.policy, version: 2 },
    } as unknown as InstalledCatalogUnit);
    expect(Result.isFailure(policyVersion)).toBe(true);
    if (Result.isFailure(policyVersion)) {
      expect(policyVersion.failure).toBeInstanceOf(InvalidIR);
      expect(policyVersion.failure.message).toMatch(/installed policy version/);
    }
  });

  test("structural decode rejects colliding catalog-unit entity descriptors", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const encoded = JSON.parse(JSON.stringify(encodeInstalledCatalogUnit(unit))) as ReturnType<
      typeof encodeInstalledCatalogUnit
    >;
    const issue = encoded.entities.find((entry) => entry.id.name === "issue");
    expect(issue).toBeDefined();
    const colliding = {
      ...encoded,
      entities: [
        ...encoded.entities,
        JSON.parse(JSON.stringify({ ...issue!, traits: [] })),
      ],
    };
    const decoded = decodeInstalledCatalogUnitResult(colliding);
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure).toBeInstanceOf(InvalidIR);
      expect(decoded.failure.message).toMatch(/entity identity collision/);
    }
  });
});

const unusedTitle = (
  unit: InstalledCatalogUnit,
  patch: Partial<Pick<(typeof unit.fields)[number], "optional" | "index" | "owned" | "valueType">>,
): InstalledCatalogUnit =>
  ({
    ...unit,
    fields: unit.fields.map((entry) =>
      entry.id.localName === "title" && entry.valueType !== "ref" ? { ...entry, ...patch } : entry,
    ),
  }) as InstalledCatalogUnit;

const rehashPolicyAndUnit = async (document: InstalledCatalogUnit): Promise<InstalledCatalogUnit> => {
  const policyHash = await Effect.runPromise(hashInstalledAuthorization(document.policy));
  const withPolicy = { ...document, policy: { ...document.policy, policyHash } } as InstalledCatalogUnit;
  const unitHash = await Effect.runPromise(hashInstalledCatalogUnit(withPolicy));
  return { ...withPolicy, unitHash };
};

const verifyFail = (document: InstalledCatalogUnit) =>
  Effect.runPromise(Effect.flip(verifyInstalledCatalogUnit(document)));

describe("schema fingerprint binds descriptor contents", () => {
  test("changing unused field flags and recomputing only unitHash fails verify", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const title = unit.fields.find((entry) => entry.id.localName === "title");
    expect(title).toBeDefined();
    expect(title?.valueType).toBe("string");
    expect(title?.optional).toBe(false);
    expect(title?.index).toBe(false);

    for (const patch of [{ optional: true }, { index: true }, { owned: true }, { valueType: "long" }] as const) {
      const tampered = unusedTitle(unit, patch);
      expect(tampered.schemaFingerprint).toBe(unit.schemaFingerprint);
      expect(tampered.policy.schemaFingerprint).toBe(unit.policy.schemaFingerprint);
      expect(tampered.policy.policyHash).toBe(unit.policy.policyHash);
      const unitHash = await Effect.runPromise(hashInstalledCatalogUnit(tampered));
      expect(unitHash).not.toBe(unit.unitHash);
      const failure = await verifyFail({ ...tampered, unitHash });
      expect(failure).toBeInstanceOf(CatalogMismatch);
      expect(failure.message).toMatch(/schema fingerprint does not match catalog tables/);
      if (failure instanceof CatalogMismatch) {
        expect(failure.expectedFingerprint).toBeDefined();
        expect(failure.actualFingerprint).toBe(unit.schemaFingerprint);
        expect(failure.expectedFingerprint).not.toBe(failure.actualFingerprint);
      }
    }
  });

  test("updating only the unit fingerprint to the new digest still fails identity mismatch", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const tampered = unusedTitle(unit, { optional: true });
    const digest = await Effect.runPromise(
      hashCatalogSchemaFingerprint({
        entities: tampered.entities,
        traits: tampered.traits,
        fields: tampered.fields,
        operations: tampered.operations,
        traitComposition: tampered.traitComposition,
        fingerprint: SchemaFingerprint.make("placeholder"),
      }),
    );
    expect(digest).not.toBe(unit.schemaFingerprint);
    const updated = { ...tampered, schemaFingerprint: digest } as InstalledCatalogUnit;
    expect(updated.policy.schemaFingerprint).toBe(unit.policy.schemaFingerprint);
    expect(updated.policy.policyHash).toBe(unit.policy.policyHash);
    const unitHash = await Effect.runPromise(hashInstalledCatalogUnit(updated));
    const failure = await verifyFail({ ...updated, unitHash });
    expect(failure).toBeInstanceOf(CatalogMismatch);
    expect(failure.message).toMatch(/schema fingerprint does not match installed policy/);
  });
});

describe("blank catalog identity is rejected in the shared kernel", () => {
  test("blank catalog/database/version/fingerprint on unit and policy fail verify", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const cases = [
      { field: "catalog" as const, pattern: /blank catalog id/ },
      { field: "database" as const, pattern: /blank database/ },
      { field: "catalogVersion" as const, pattern: /blank catalog version/ },
      { field: "schemaFingerprint" as const, pattern: /blank schema fingerprint/ },
    ];
    for (const { field, pattern } of cases) {
      const blanked = {
        ...unit,
        [field]: "",
        policy: { ...unit.policy, [field]: "" },
      } as InstalledCatalogUnit;
      const failure = await verifyFail(await rehashPolicyAndUnit(blanked));
      expect(failure).toBeInstanceOf(CatalogMismatch);
      expect(failure.message).toMatch(pattern);
    }
  });

  test("blank entity name and blank field localName fail verify after rehash", async () => {
    const descriptor = catalogDescriptor();
    const policy = await install(descriptor);
    const unit = await seal(descriptor, policy);
    const blankEntityId = EntityId.make({ catalog, name: "" });
    const blankEntity = {
      ...unit,
      entities: [...unit.entities, { id: blankEntityId, traits: [] }],
      identities: {
        ...unit.identities,
        entities: [...unit.identities.entities, blankEntityId],
      },
      policy: {
        ...unit.policy,
        identities: {
          ...unit.policy.identities,
          entities: [...unit.policy.identities.entities, blankEntityId],
        },
      },
    } as InstalledCatalogUnit;
    const entityFail = await verifyFail(await rehashPolicyAndUnit(blankEntity));
    expect(entityFail).toBeInstanceOf(InvalidIR);
    expect(entityFail.message).toMatch(/blank entity name/);

    const blankFieldId = FieldId.make({ catalog, owner: issueOwner, localName: "" });
    const blankField = {
      ...unit,
      fields: [
        ...unit.fields,
        {
          id: blankFieldId,
          valueType: "string" as const,
          cardinality: "one" as const,
          index: false,
          optional: false,
          owned: false,
        },
      ],
      identities: {
        ...unit.identities,
        fields: [...unit.identities.fields, blankFieldId],
      },
      policy: {
        ...unit.policy,
        identities: {
          ...unit.policy.identities,
          fields: [...unit.policy.identities.fields, blankFieldId],
        },
      },
    } as InstalledCatalogUnit;
    const fieldFail = await verifyFail(await rehashPolicyAndUnit(blankField));
    expect(fieldFail).toBeInstanceOf(InvalidIR);
    expect(fieldFail.message).toMatch(/blank field local name/);
  });

  test("prepareAuthorizationCatalog rejects blank target fingerprint and blank entity name", () => {
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
      expect(blankFingerprint.failure).toBeInstanceOf(CatalogMismatch);
      expect(blankFingerprint.failure.message).toMatch(/blank schema fingerprint/);
    }

    const blankEntity = prepareAuthorizationCatalog(target, {
      ...descriptor,
      entities: [{ id: EntityId.make({ catalog, name: "" }), traits: [] }, ...descriptor.entities],
    });
    expect(Result.isFailure(blankEntity)).toBe(true);
    if (Result.isFailure(blankEntity)) {
      expect(blankEntity.failure).toBeInstanceOf(InvalidIR);
      expect(blankEntity.failure.message).toMatch(/blank entity name/);
    }
  });
});
