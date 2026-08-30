import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Unauthorized } from "../../../src/db/Errors.ts";
import {
  CatalogId,
  CatalogUnitHash,
  CatalogVersionMismatch,
  DatabaseId,
  EntityId,
  SchemaFingerprint,
  assembleDeployedCatalogs,
  hashCatalogSchemaFingerprint,
  opaqueCatalogDenial,
  requireCatalogKey,
  requireUnitHash,
  resolveDeployedCatalog,
  type CatalogAssemblyUnit,
  type CatalogDescriptor,
} from "../../../src/internal/authorization/index.ts";
import {
  catalog,
  catalogDescriptor,
  catalogSchemaTables,
  childCatalogDescriptor,
  childTemplate,
  database,
  issueOwner,
  otherCatalog,
  otherCatalogDescriptor,
  otherDatabase,
  scalarField,
  templateOf,
  version,
} from "./catalog-support.ts";
import { digestHex } from "./fixtures.ts";

const assemble = (input: Parameters<typeof assembleDeployedCatalogs>[0]) =>
  Effect.runPromise(assembleDeployedCatalogs(input));

const assembleFail = (input: Parameters<typeof assembleDeployedCatalogs>[0]) =>
  Effect.runPromise(Effect.flip(assembleDeployedCatalogs(input)));

const appUnit = (extras: Partial<CatalogAssemblyUnit> = {}): CatalogAssemblyUnit => ({
  catalog,
  database,
  version,
  descriptor: catalogDescriptor(),
  policy: templateOf(),
  ...extras,
});

const libUnit = (extras: Partial<CatalogAssemblyUnit> = {}): CatalogAssemblyUnit => ({
  catalog: CatalogId.make("lib"),
  database,
  version,
  descriptor: childCatalogDescriptor(),
  policy: childTemplate(),
  ...extras,
});

const crmUnit = (extras: Partial<CatalogAssemblyUnit> = {}): CatalogAssemblyUnit => ({
  catalog: otherCatalog,
  database: otherDatabase,
  version,
  descriptor: otherCatalogDescriptor(),
  policy: childTemplate(),
  ...extras,
});

const enumerablePayload = (value: object): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    payload[key] = (value as Record<string, unknown>)[key];
  }
  return payload;
};

describe("assembleDeployedCatalogs", () => {
  test("trusted database lookup returns the sealed unit; databases() lists it", async () => {
    const catalogs = await assemble({ root: catalog, units: [appUnit()] });
    const deployed = Result.getOrThrow(catalogs.requireDatabase(database));
    expect(deployed.database).toBe(database);
    expect(deployed.catalogKey).toBe(catalog);
    expect(deployed.unitHash).toMatch(/^[0-9a-f]{64}$/);
    expect(deployed.unit._tag).toBe("InstalledCatalogUnit");
    expect(deployed.unit.unitHash).toBe(deployed.unitHash);
    expect(deployed.unit.catalog.database).toBe(database);
    expect(deployed.composition.isEntityIdent(":issue")).toBe(true);
    expect(deployed.composition.isTraitIdent(":taggable")).toBe(true);
    expect(deployed.composition.transitiveTraits(":issue")).toEqual([":taggable"]);
    expect(deployed.composition.transitiveTraits(":user")).toEqual([]);
    expect(catalogs.databases()).toEqual([database]);
  });

  test("requireCatalogKey and requireUnitHash agree with the database-selected unit", async () => {
    const catalogs = await assemble({ root: catalog, units: [appUnit()] });
    const deployed = Result.getOrThrow(catalogs.requireDatabase(database));
    expect(Result.isSuccess(requireCatalogKey(deployed.catalogKey, catalog))).toBe(true);
    expect(Result.isSuccess(requireUnitHash(deployed.unitHash, deployed.unitHash, catalog))).toBe(
      true,
    );

    const wrongKey = requireCatalogKey(CatalogId.make("other"), deployed.catalogKey);
    expect(Result.isFailure(wrongKey)).toBe(true);
    if (Result.isFailure(wrongKey)) {
      expect(wrongKey.failure._tag).toBe("CatalogMismatch");
      expect(wrongKey.failure.expected).toBe(deployed.catalogKey);
      expect(wrongKey.failure.actual).toBe(CatalogId.make("other"));
    }

    const wrongHash = CatalogUnitHash.make(digestHex(0xab));
    const mismatch = requireUnitHash(wrongHash, deployed.unitHash, catalog);
    expect(Result.isFailure(mismatch)).toBe(true);
    if (Result.isFailure(mismatch)) {
      expect(mismatch.failure).toBeInstanceOf(CatalogVersionMismatch);
      expect(mismatch.failure._tag).toBe("CatalogVersionMismatch");
      expect(mismatch.failure.catalog).toBe(catalog);
      expect(mismatch.failure.expected).toBe(deployed.unitHash);
      expect(mismatch.failure.actual).toBe(wrongHash);
    }
  });

  test("resolveDeployedCatalog starts from the trusted database", async () => {
    const catalogs = await assemble({ root: catalog, units: [appUnit()] });
    const deployed = Result.getOrThrow(catalogs.requireDatabase(database));
    const resolved = resolveDeployedCatalog(catalogs, {
      database,
      catalogKey: catalog,
      unitHash: deployed.unitHash,
    });
    expect(Result.getOrThrow(resolved).unitHash).toBe(deployed.unitHash);
    expect(Result.getOrThrow(resolved).unit).toBe(deployed.unit);
    expect(Result.getOrThrow(resolved).database).toBe(database);

    const wrongDatabase = resolveDeployedCatalog(catalogs, {
      database: otherDatabase,
      catalogKey: catalog,
      unitHash: deployed.unitHash,
    });
    expect(Result.isFailure(wrongDatabase)).toBe(true);
    if (Result.isFailure(wrongDatabase)) {
      expect(wrongDatabase.failure._tag).toBe("CatalogMismatch");
    }

    const wrongKey = resolveDeployedCatalog(catalogs, {
      database,
      catalogKey: CatalogId.make("other"),
      unitHash: deployed.unitHash,
    });
    expect(Result.isFailure(wrongKey)).toBe(true);
    if (Result.isFailure(wrongKey)) {
      expect(wrongKey.failure._tag).toBe("CatalogMismatch");
    }

    const wrongHash = resolveDeployedCatalog(catalogs, {
      database,
      catalogKey: catalog,
      unitHash: CatalogUnitHash.make(digestHex(0xab)),
    });
    expect(Result.isFailure(wrongHash)).toBe(true);
    if (Result.isFailure(wrongHash)) {
      expect(wrongHash.failure._tag).toBe("CatalogVersionMismatch");
    }
  });

  test("missing database is CatalogMismatch", async () => {
    const catalogs = await assemble({ root: catalog, units: [appUnit()] });
    const missing = catalogs.requireDatabase(DatabaseId.make("other"));
    expect(Result.isFailure(missing)).toBe(true);
    if (Result.isFailure(missing)) {
      expect(missing.failure._tag).toBe("CatalogMismatch");
      expect(missing.failure.message).toBe("catalog mismatch");
      expect(missing.failure.expectedDatabase).toBe(DatabaseId.make("other"));
    }
  });

  test("distinct catalog units claiming the same DatabaseId fail startup", async () => {
    const failure = await assembleFail({
      root: catalog,
      units: [appUnit({ children: [CatalogId.make("lib")] }), libUnit()],
    });
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain("todos");
    expect(failure.message).toContain("app");
    expect(failure.message).toContain("lib");
    expect(failure.message.toLowerCase()).toMatch(/distinct|claim/);
    expect(failure.message).toMatch(/path/);
  });

  test("duplicate CatalogId with different definitions fails with reachability diagnostics", async () => {
    const otherTables = {
      ...catalogSchemaTables(),
      fields: [...catalogSchemaTables().fields, scalarField(issueOwner, "body")],
    };
    const otherFingerprint = SchemaFingerprint.make(
      await Effect.runPromise(
        hashCatalogSchemaFingerprint({
          ...otherTables,
          fingerprint: SchemaFingerprint.make("placeholder"),
        }),
      ),
    );
    const otherDescriptor: CatalogDescriptor = { ...otherTables, fingerprint: otherFingerprint };
    const failure = await assembleFail({
      root: catalog,
      units: [appUnit(), appUnit({ descriptor: otherDescriptor })],
    });
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain("app");
    expect(failure.message.toLowerCase()).toMatch(/conflict|duplicate/);
    expect(failure.message).toMatch(/path/);
  });

  test("two databases with different catalog units assemble; local names may repeat", async () => {
    const catalogs = await assemble({
      root: catalog,
      units: [appUnit({ children: [otherCatalog] }), crmUnit()],
    });
    const todos = Result.getOrThrow(catalogs.requireDatabase(database));
    const crm = Result.getOrThrow(catalogs.requireDatabase(otherDatabase));
    expect(todos.catalogKey).toBe(catalog);
    expect(crm.catalogKey).toBe(otherCatalog);
    expect(todos.unitHash).not.toBe(crm.unitHash);
    expect(todos.unit.catalog.entities.some((entity) => entity.id.name === "user")).toBe(true);
    expect(crm.unit.catalog.entities.some((entity) => entity.id.name === "user")).toBe(true);
    expect(todos.unit.catalog.fields.some((field) => field.id.localName === "authId")).toBe(true);
    expect(crm.unit.catalog.fields.some((field) => field.id.localName === "authId")).toBe(true);
    expect([...catalogs.databases()]).toEqual([otherDatabase, database].slice().sort());
  });

  test("repeated reachability of one identical unit does not create a second registration", async () => {
    const catalogs = await assemble({
      root: catalog,
      units: [appUnit(), appUnit()],
    });
    const deployed = Result.getOrThrow(catalogs.requireDatabase(database));
    expect(deployed.catalogKey).toBe(catalog);
    expect(catalogs.databases()).toEqual([database]);
  });

  test("missing child catalog referenced from root.children fails", async () => {
    const failure = await assembleFail({
      root: catalog,
      units: [appUnit({ children: [CatalogId.make("lib")] })],
    });
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain("lib");
    expect(failure.message).toContain("app");
  });

  test("cross-catalog identity on a descriptor fails at install/seal", async () => {
    const descriptor = catalogDescriptor();
    const crossed: CatalogDescriptor = {
      ...descriptor,
      entities: [
        { id: EntityId.make({ catalog: CatalogId.make("other"), name: "user" }), traits: [] },
        descriptor.entities[1]!,
      ],
    };
    const failure = await assembleFail({
      root: catalog,
      units: [appUnit({ descriptor: crossed })],
    });
    expect(failure._tag === "InvalidIR" || failure._tag === "CatalogMismatch").toBe(true);
  });

  test("malformed unit with a bad fingerprint cannot enter the registry", async () => {
    const descriptor = {
      ...catalogDescriptor(),
      fingerprint: SchemaFingerprint.make(digestHex(0x00)),
    };
    const failure = await assembleFail({
      root: catalog,
      units: [appUnit({ descriptor })],
    });
    expect(
      failure._tag === "CatalogMismatch" ||
        failure._tag === "InvalidIR" ||
        failure._tag === "CatalogUnitCorrupt",
    ).toBe(true);
  });

  test("unused unreachable unit is InvalidIR", async () => {
    const failure = await assembleFail({
      root: catalog,
      units: [appUnit(), libUnit()],
    });
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain("lib");
  });

  test("opaqueCatalogDenial yields Unauthorized with no catalog or hash payload", async () => {
    const catalogs = await assemble({ root: catalog, units: [appUnit()] });
    const deployed = Result.getOrThrow(catalogs.requireDatabase(database));
    const missing = catalogs.requireDatabase(DatabaseId.make("other"));
    expect(Result.isFailure(missing)).toBe(true);
    if (Result.isFailure(missing)) {
      const denied = opaqueCatalogDenial(missing.failure);
      expect(denied).toBeInstanceOf(Unauthorized);
      expect(denied._tag).toBe("Unauthorized");
      const json = JSON.stringify(denied);
      expect(json).not.toContain("other");
      expect(json).not.toContain("app");
      expect(json.toLowerCase()).not.toContain("catalog");
      expect(json.toLowerCase()).not.toContain("hash");
      const keys = Object.keys(enumerablePayload(denied));
      expect(keys.some((key) => /catalog|hash|expected|actual/i.test(key))).toBe(false);
    }

    const keyMismatch = requireCatalogKey(CatalogId.make("other"), deployed.catalogKey);
    expect(Result.isFailure(keyMismatch)).toBe(true);
    if (Result.isFailure(keyMismatch)) {
      const denied = opaqueCatalogDenial(keyMismatch.failure);
      expect(denied).toBeInstanceOf(Unauthorized);
      expect(denied._tag).toBe("Unauthorized");
      const json = JSON.stringify(denied);
      expect(json).not.toContain("other");
      expect(json).not.toContain("app");
      expect(json.toLowerCase()).not.toContain("catalog");
    }

    const mismatch = requireUnitHash(
      CatalogUnitHash.make(digestHex(0xab)),
      deployed.unitHash,
      catalog,
    );
    expect(Result.isFailure(mismatch)).toBe(true);
    if (Result.isFailure(mismatch)) {
      const denied = opaqueCatalogDenial(mismatch.failure);
      expect(denied).toBeInstanceOf(Unauthorized);
      expect(denied._tag).toBe("Unauthorized");
      const json = JSON.stringify(denied);
      expect(json).not.toContain(deployed.unitHash);
      expect(json).not.toContain(digestHex(0xab));
      expect(json).not.toContain("app");
      expect(json.toLowerCase()).not.toContain("hash");
      const keys = Object.keys(enumerablePayload(denied));
      expect(keys.some((key) => /catalog|hash|expected|actual/i.test(key))).toBe(false);
    }
  });
});
