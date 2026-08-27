/**
 * Versioned CAS for immutable installed catalog units.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  AUTHORIZATION_LANGUAGE_VERSION,
  CatalogCasConflict,
  CatalogId,
  CatalogMismatch,
  CatalogVersion,
  InvalidIR,
  DatabaseId,
  EntityId,
  FieldId,
  OperationId,
  POLICY_TEMPLATE_IR_VERSION,
  RelativeFieldId,
  RuleId,
  SchemaFingerprint,
  TraitId,
  decodeInstalledCatalogUnitResult,
  hashInstalledCatalogUnit,
  installAuthorization,
  sealInstalledCatalogUnit,
  compareAndSwapCatalogUnit,
  type CatalogBindingInput,
  type CatalogDescriptor,
  type FieldRefTarget,
  type InstalledAuthorizationIRV1,
  type InstalledCatalogUnit,
  type InstalledCatalogUnitV1,
  type OwnerRef,
  type PolicyTemplateIR,
} from "../../../src/internal/authorization/index.ts";
import { digestHex } from "../authorization/fixtures.ts";
import { Harness } from "./harness.ts";

const catalog = CatalogId.make("app");
const database = DatabaseId.make("todos");
const version1 = CatalogVersion.make("1");
const version2 = CatalogVersion.make("2");
const fingerprint1 = SchemaFingerprint.make("schema");
const fingerprint2 = SchemaFingerprint.make("schema-2");

const issueOwner = { kind: "entity" as const, name: "issue" };
const userOwner = { kind: "entity" as const, name: "user" };

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
  options: { readonly unique?: "upsert" | "strict"; readonly index?: boolean } = {},
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "string",
  cardinality: "one",
  ...(options.unique === undefined ? {} : { unique: options.unique }),
  index: options.index ?? options.unique !== undefined,
  optional: false,
  owned: false,
});

const refField = (
  owner: OwnerRef,
  localName: string,
  refTarget: FieldRefTarget,
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "ref",
  refTarget,
  cardinality: "one",
  index: false,
  optional: false,
  owned: false,
});

const descriptorOf = (
  catalogVersion: CatalogVersion,
  fingerprint: SchemaFingerprint,
  extraEntities: ReadonlyArray<CatalogDescriptor["entities"][number]> = [],
): CatalogDescriptor => ({
  id: catalog,
  database,
  version: catalogVersion,
  fingerprint,
  entities: [
    { id: entity("user"), traits: [] },
    { id: entity("issue"), traits: [trait("taggable")] },
    ...extraEntities,
  ],
  traits: [{ id: trait("taggable"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    refField(issueOwner, "owner", { _tag: "entity", entity: entity("user") }),
    scalarField(issueOwner, "title"),
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

const templateOf = (): PolicyTemplateIR => ({
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
});

const bindingInput = (descriptor: CatalogDescriptor): CatalogBindingInput => ({
  target: {
    database: descriptor.database,
    catalog: descriptor.id,
    catalogVersion: descriptor.version,
    schemaFingerprint: descriptor.fingerprint,
  },
  descriptor,
  template: templateOf(),
});

const sealUnit = async (descriptor: CatalogDescriptor): Promise<InstalledCatalogUnitV1> => {
  const policy: InstalledAuthorizationIRV1 = await Effect.runPromise(
    installAuthorization(bindingInput(descriptor)),
  );
  return Effect.runPromise(sealInstalledCatalogUnit(descriptor, policy));
};

const fresh = async () => {
  const h = new Harness({ dbName: "todos" });
  await h.transactor.init();
  return h;
};

const cas = (
  h: Harness,
  unit: InstalledCatalogUnitV1,
  expectedVersion: CatalogVersion | null,
) =>
  h.transactor.compareAndSwapCatalogUnit({
    database,
    catalog,
    expectedVersion,
    unit,
  });

const casAt = (
  h: Harness,
  unit: InstalledCatalogUnitV1,
  expectedVersion: CatalogVersion | null,
  installT: number,
) => {
  const result = h.transactionSync(() =>
    compareAndSwapCatalogUnit(h.sql, {
      database,
      catalog,
      expectedVersion,
      unit,
      installT,
    }),
  );
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const load = (h: Harness, basisT: number) =>
  h.transactor.loadCatalogUnitAtBasis({ database, catalog, basisT });

const loadFail = async (h: Harness, basisT: number) => {
  try {
    await load(h, basisT);
    throw new Error("expected load to fail");
  } catch (error) {
    return error as { readonly _tag?: string; readonly message?: string };
  }
};

const casFail = async (
  h: Harness,
  unit: InstalledCatalogUnitV1,
  expectedVersion: CatalogVersion | null,
) => {
  try {
    await cas(h, unit, expectedVersion);
    throw new Error("expected CAS to fail");
  } catch (error) {
    return error as { readonly _tag?: string; readonly message?: string };
  }
};

const casAtFail = (
  h: Harness,
  unit: InstalledCatalogUnitV1,
  expectedVersion: CatalogVersion | null,
  installT: number,
) => {
  try {
    casAt(h, unit, expectedVersion, installT);
    throw new Error("expected CAS to fail");
  } catch (error) {
    if (error instanceof Error && error.message === "expected CAS to fail") throw error;
    return error as { readonly _tag?: string; readonly message?: string };
  }
};

const readUnitJson = (h: Harness): Record<string, unknown> => {
  const row = h.sql.exec(`SELECT bytes FROM catalog_units WHERE catalog = ?`, catalog).toArray()[0];
  if (row === undefined) throw new Error("expected catalog unit row");
  const raw = row.bytes as ArrayBuffer | Uint8Array;
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return JSON.parse(new TextDecoder().decode(buf)) as Record<string, unknown>;
};

const writeUnitBytes = (h: Harness, json: unknown) => {
  const bytes = new TextEncoder().encode(typeof json === "string" ? json : JSON.stringify(json));
  h.sql.exec(`UPDATE catalog_units SET bytes = ? WHERE catalog = ?`, bytes, catalog);
};

const durableLogT = (h: Harness): number => {
  const raw = h.sql.exec(`SELECT MAX(t) AS t FROM log`).toArray()[0]?.t;
  const t = Number(raw);
  if (!Number.isSafeInteger(t)) throw new Error("expected durable log t");
  return t;
};

describe("catalog unit CAS", () => {
  test("first CAS succeeds and load returns the complete unit", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    const head = await cas(h, unit, null);
    expect(head.catalogVersion).toBe(version1);
    expect(head.unitHash).toBe(unit.unitHash);
    const loaded = await load(h, head.installT);
    expect(loaded.unitHash).toBe(unit.unitHash);
    expect(loaded.catalogVersion).toBe(version1);
    expect(loaded.policy._tag).toBe("InstalledAuthorizationIR");
    expect(loaded.identities.entities.map((id) => id.name).sort()).toEqual(["issue", "user"]);
    expect(loaded.entities).toHaveLength(2);
    expect(h.transactor.catalogHead(catalog)?.unitHash).toBe(unit.unitHash);
  });

  test("stale expectedVersion fails and load still returns the first complete unit", async () => {
    const h = await fresh();
    const first = await sealUnit(descriptorOf(version1, fingerprint1));
    await cas(h, first, null);
    const second = await sealUnit(
      descriptorOf(version2, fingerprint2, [{ id: entity("project"), traits: [] }]),
    );
    const staleNull = await casFail(h, second, null);
    expect(staleNull).toBeInstanceOf(CatalogCasConflict);
    const staleOld = await casFail(h, second, CatalogVersion.make("0"));
    expect(staleOld).toBeInstanceOf(CatalogCasConflict);
    const loaded = await load(h, 1);
    expect(loaded.unitHash).toBe(first.unitHash);
    expect(loaded.catalogVersion).toBe(version1);
    expect(loaded.entities.some((entry) => entry.id.name === "project")).toBe(false);
    expect(loaded.policy.schemaFingerprint).toBe(fingerprint1);
  });

  test("readers at old basis see the complete old unit; new basis sees the complete new unit", async () => {
    const h = await fresh();
    const oldUnit = await sealUnit(descriptorOf(version1, fingerprint1));
    const newUnit = await sealUnit(
      descriptorOf(version2, fingerprint2, [{ id: entity("project"), traits: [] }]),
    );
    casAt(h, oldUnit, null, 1);
    casAt(h, newUnit, version1, 2);
    const atOld = await load(h, 1);
    const atNew = await load(h, 2);
    expect(atOld.unitHash).toBe(oldUnit.unitHash);
    expect(atNew.unitHash).toBe(newUnit.unitHash);
    expect(atOld.catalogVersion).toBe(version1);
    expect(atNew.catalogVersion).toBe(version2);
    expect(atOld.schemaFingerprint).toBe(fingerprint1);
    expect(atNew.schemaFingerprint).toBe(fingerprint2);
    expect(atOld.policy.schemaFingerprint).toBe(fingerprint1);
    expect(atNew.policy.schemaFingerprint).toBe(fingerprint2);
    expect(atOld.entities.some((entry) => entry.id.name === "project")).toBe(false);
    expect(atNew.entities.some((entry) => entry.id.name === "project")).toBe(true);
    expect(atOld.identities.entities.some((id) => id.name === "project")).toBe(false);
    expect(atNew.identities.entities.some((id) => id.name === "project")).toBe(true);
    expect(atOld.policy.identities.entities.some((id) => id.name === "project")).toBe(false);
    expect(atNew.policy.identities.entities.some((id) => id.name === "project")).toBe(true);
  });

  test("two conflicting CAS attempts with the same expectedVersion: only one succeeds", async () => {
    const h = await fresh();
    const first = await sealUnit(descriptorOf(version1, fingerprint1));
    casAt(h, first, null, 1);
    const winner = await sealUnit(
      descriptorOf(version2, fingerprint2, [{ id: entity("project"), traits: [] }]),
    );
    const loser = await sealUnit(
      descriptorOf(version2, SchemaFingerprint.make("schema-3"), [{ id: entity("other"), traits: [] }]),
    );
    casAt(h, winner, version1, 2);
    const conflict = casAtFail(h, loser, version1, 3);
    expect(conflict).toBeInstanceOf(CatalogCasConflict);
    const loaded = await load(h, 3);
    expect(loaded.unitHash).toBe(winner.unitHash);
    expect(loaded.entities.some((entry) => entry.id.name === "project")).toBe(true);
    expect(loaded.entities.some((entry) => entry.id.name === "other")).toBe(false);
    expect(loaded.policy.schemaFingerprint).toBe(fingerprint2);
  });

  test("tampered identities with a matching hash fail CAS and store nothing", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    const tampered = {
      ...unit,
      identities: {
        ...unit.identities,
        entities: unit.identities.entities.filter((id) => id.name !== "user"),
      },
    } as InstalledCatalogUnit;
    const unitHash = await Effect.runPromise(hashInstalledCatalogUnit(tampered));
    const hashed = { ...tampered, unitHash } as InstalledCatalogUnitV1;
    const failure = await casFail(h, hashed, null);
    expect(failure._tag === "CatalogMismatch" || failure._tag === "InvalidIR").toBe(true);
    expect(h.transactor.catalogHead(catalog)).toBeUndefined();
    const atBasis = await loadFail(h, 1);
    expect(atBasis).toBeInstanceOf(CatalogMismatch);
    expect(
      h.sql.exec(`SELECT catalog FROM catalog_units WHERE catalog = ?`, catalog).toArray(),
    ).toHaveLength(0);
  });

  test("corrupt unit bytes on CAS retry surface CatalogUnitCorrupt, not a missing-row write", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    await cas(h, unit, null);
    h.sql.exec(`UPDATE catalog_units SET bytes = ? WHERE catalog = ?`, 1, catalog);
    const failure = await casFail(h, unit, null);
    expect(failure._tag).toBe("CatalogUnitCorrupt");
    expect(h.transactor.catalogHead(catalog)?.unitHash).toBe(unit.unitHash);
    expect(
      h.sql.exec(`SELECT catalog FROM catalog_units WHERE catalog = ?`, catalog).toArray(),
    ).toHaveLength(1);
  });

  test("raw inconsistent bytes with a matching hash fail load closed", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    await cas(h, unit, null);
    const json = readUnitJson(h);
    const identities = json.identities as { entities: Array<{ name: string }> };
    identities.entities = identities.entities.filter((id) => id.name !== "user");
    json.identities = identities;
    const decoded = decodeInstalledCatalogUnitResult(json);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    const unitHash = await Effect.runPromise(hashInstalledCatalogUnit(decoded.success));
    json.unitHash = unitHash;
    writeUnitBytes(h, json);
    h.sql.exec(`UPDATE catalog_units SET unit_hash = ? WHERE catalog = ?`, unitHash, catalog);
    const failure = await loadFail(h, 1);
    expect(
      failure._tag === "CatalogMismatch" ||
        failure._tag === "InvalidIR" ||
        failure._tag === "CatalogUnitCorrupt",
    ).toBe(true);
    expect(h.transactor.catalogHead(catalog)?.unitHash).toBe(unit.unitHash);
  });

  test("corrupt stored bytes fail closed", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    await cas(h, unit, null);
    writeUnitBytes(h, "not-json{{{");
    const failure = await loadFail(h, 1);
    expect(failure._tag).toBe("CatalogUnitCorrupt");
  });

  test("noncanonical stored bytes fail load closed even when the document hash matches", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    await cas(h, unit, null);
    const json = readUnitJson(h);
    writeUnitBytes(h, `${JSON.stringify(json, null, 2)}\n`);
    const failure = await loadFail(h, 1);
    expect(failure._tag).toBe("CatalogUnitCorrupt");
    expect(failure.message).toMatch(/not canonical/);
    expect(h.transactor.catalogHead(catalog)?.unitHash).toBe(unit.unitHash);
  });

  test("hash/version mismatch fails closed", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    await cas(h, unit, null);
    h.sql.exec(`UPDATE catalog_units SET unit_hash = ? WHERE catalog = ?`, digestHex(0x00), catalog);
    const hashFail = await loadFail(h, 1);
    expect(hashFail._tag).toBe("CatalogUnitCorrupt");
    const json = readUnitJson(h);
    json.catalogVersion = "9";
    writeUnitBytes(h, json);
    h.sql.exec(`UPDATE catalog_units SET unit_hash = ? WHERE catalog = ?`, unit.unitHash, catalog);
    const versionFail = await loadFail(h, 1);
    expect(
      versionFail._tag === "CatalogUnitCorrupt" ||
        versionFail._tag === "InvalidIR" ||
        versionFail._tag === "CatalogMismatch",
    ).toBe(true);
  });

  test("unsupported language version stored fails closed", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    await cas(h, unit, null);
    const json = readUnitJson(h);
    json.languageVersion = "v2";
    writeUnitBytes(h, json);
    const failure = await loadFail(h, 1);
    expect(
      failure._tag === "CatalogUnitCorrupt" || failure._tag === "InvalidIR",
    ).toBe(true);
  });

  test("missing required components fail closed", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    await cas(h, unit, null);
    const json = readUnitJson(h);
    delete json.policy;
    writeUnitBytes(h, json);
    const failure = await loadFail(h, 1);
    expect(failure._tag).toBe("CatalogUnitCorrupt");
  });

  test("load at a basis before the first install fails closed", async () => {
    const h = await fresh();
    const before = await loadFail(h, 1);
    expect(before).toBeInstanceOf(CatalogMismatch);
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    casAt(h, unit, null, 2);
    const stillBefore = await loadFail(h, 1);
    expect(stillBefore).toBeInstanceOf(CatalogMismatch);
    const loaded = await load(h, 2);
    expect(loaded.unitHash).toBe(unit.unitHash);
  });

  test("Harness restart after CAS still loads the durable unit", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    await cas(h, unit, null);
    const restarted = h.restart({ dbName: "todos" });
    await restarted.transactor.init();
    const loaded = await load(restarted, 1);
    expect(loaded.unitHash).toBe(unit.unitHash);
    expect(loaded.policy.catalog).toBe(catalog);
    expect(restarted.transactor.catalogHead(catalog)?.unitHash).toBe(unit.unitHash);
  });

  test("CAS back to a superseded catalog version is a conflict", async () => {
    const h = await fresh();
    const first = await sealUnit(descriptorOf(version1, fingerprint1));
    const second = await sealUnit(
      descriptorOf(version2, fingerprint2, [{ id: entity("project"), traits: [] }]),
    );
    casAt(h, first, null, 1);
    casAt(h, second, version1, 2);
    const reuse = casAtFail(h, first, version2, 3);
    expect(reuse).toBeInstanceOf(CatalogCasConflict);
    expect(h.transactor.catalogHead(catalog)?.catalogVersion).toBe(version2);
    expect(h.transactor.catalogHead(catalog)?.installT).toBe(2);
    const loaded = await load(h, 3);
    expect(loaded.unitHash).toBe(second.unitHash);
    expect(loaded.catalogVersion).toBe(version2);
    expect(loaded.entities.some((entry) => entry.id.name === "project")).toBe(true);
    expect(loaded.policy.schemaFingerprint).toBe(fingerprint2);
  });

  test("Transactor CAS derives installT from the committed basis", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    const basis = durableLogT(h);
    const head = await cas(h, unit, null);
    expect(head.installT).toBe(basis);
    expect(head.installT).toBe(durableLogT(h));
    const loaded = await load(h, basis);
    expect(loaded.unitHash).toBe(unit.unitHash);
    if (basis > 1) {
      const before = await loadFail(h, basis - 1);
      expect(before).toBeInstanceOf(CatalogMismatch);
    }
  });

  test("Transactor CAS ignores a caller-supplied installT", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    const input = {
      database,
      catalog,
      expectedVersion: null,
      unit,
      installT: 99,
    };
    const head = await h.transactor.compareAndSwapCatalogUnit(input);
    expect(head.installT).toBe(durableLogT(h));
    expect(head.installT).not.toBe(99);
    expect(h.transactor.catalogHead(catalog)?.installT).toBe(durableLogT(h));
  });

  test("Transactor CAS uses MAX(log.t) when in-memory t is ahead of the log", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    const logT = durableLogT(h);
    (h.transactor.connection as unknown as { basisT: number }).basisT = logT + 7;
    expect(h.transactor.t).toBe(logT + 7);
    const head = await cas(h, unit, null);
    expect(head.installT).toBe(logT);
    expect(head.installT).toBe(durableLogT(h));
    expect(head.installT).not.toBe(h.transactor.t);
    expect(h.transactor.catalogHead(catalog)?.installT).toBe(logT);
  });

  test("Transactor CAS fails closed when the durable log is empty", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    h.sql.exec(`DELETE FROM log`);
    expect(h.sql.exec(`SELECT MAX(t) AS t FROM log`).toArray()[0]?.t ?? null).toBeNull();
    const failure = await casFail(h, unit, null);
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/durable log has no committed basis/);
    expect(h.transactor.catalogHead(catalog)).toBeUndefined();
    expect(
      h.sql.exec(`SELECT catalog FROM catalog_units WHERE catalog = ?`, catalog).toArray(),
    ).toHaveLength(0);
  });

  test("idempotent retry of the current head does not rewrite install_t", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    const first = casAt(h, unit, null, 1);
    expect(first.installT).toBe(1);
    const retry = casAt(h, unit, null, 5);
    expect(retry.installT).toBe(1);
    expect(h.transactor.catalogHead(catalog)?.installT).toBe(1);
    const again = casAt(h, unit, version1, 5);
    expect(again.installT).toBe(1);
    const loaded = await load(h, 1);
    expect(loaded.unitHash).toBe(unit.unitHash);
  });

  test("row install_t that does not match the head fails idempotent retry", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    const head = await cas(h, unit, null);
    expect(head.installT).toBe(durableLogT(h));
    h.sql.exec(`UPDATE catalog_units SET install_t = 0 WHERE catalog = ?`, catalog);
    const failure = await casFail(h, unit, null);
    expect(failure._tag).toBe("CatalogUnitCorrupt");
    expect(failure.message).toMatch(/install_t/);
    expect(h.transactor.catalogHead(catalog)?.installT).toBe(head.installT);
    expect(h.transactor.catalogHead(catalog)?.unitHash).toBe(unit.unitHash);
    const stored = h.sql.exec(`SELECT install_t FROM catalog_units WHERE catalog = ?`, catalog).toArray()[0];
    expect(Number(stored?.install_t)).toBe(0);
  });

  test("missing unit row on same-installT retry is CatalogUnitCorrupt", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    await cas(h, unit, null);
    h.sql.exec(`DELETE FROM catalog_units WHERE catalog = ?`, catalog);
    const failure = await casFail(h, unit, null);
    expect(failure._tag).toBe("CatalogUnitCorrupt");
    expect(h.transactor.catalogHead(catalog)?.unitHash).toBe(unit.unitHash);
    expect(
      h.sql.exec(`SELECT catalog FROM catalog_units WHERE catalog = ?`, catalog).toArray(),
    ).toHaveLength(0);
  });

  test("row catalog_version that does not match stored bytes fails load closed", async () => {
    const h = await fresh();
    const unit = await sealUnit(descriptorOf(version1, fingerprint1));
    await cas(h, unit, null);
    h.sql.exec(`UPDATE catalog_units SET catalog_version = '9' WHERE catalog = ?`, catalog);
    const failure = await loadFail(h, h.transactor.t);
    expect(failure._tag).toBe("CatalogUnitCorrupt");
    expect(h.transactor.catalogHead(catalog)?.catalogVersion).toBe(version1);
  });

  test("public barrels do not export catalog CAS or install helpers", async () => {
    const root = await import("../../../src/index.ts");
    const db = await import("../../../src/db/index.ts");
    for (const name of [
      "InstalledCatalogUnit",
      "sealInstalledCatalogUnit",
      "assembleInstalledCatalogUnit",
      "compareAndSwapCatalogUnit",
      "loadCatalogUnitAtBasis",
      "verifyInstalledCatalogUnit",
      "requireUnitCoherence",
      "CatalogCasConflict",
      "CatalogUnitCorrupt",
    ]) {
      expect(name in root).toBe(false);
      expect(name in db).toBe(false);
    }
  });
});
