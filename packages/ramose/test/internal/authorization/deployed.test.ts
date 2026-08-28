/**
 * Deployed catalog registry: assembly, require, and exact unit-hash agreement.
 */

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
  FieldId,
  SchemaFingerprint,
  TraitId,
  assembleDeployedCatalogs,
  hashCatalogSchemaFingerprint,
  opaqueCatalogDenial,
  requireUnitHash,
  resolveDeployedCatalog,
  type CatalogAssemblyUnit,
  type CatalogDescriptor,
} from "../../../src/internal/authorization/index.ts";
import {
  catalog,
  catalogDescriptor,
  catalogSchemaTables,
  childCatalog,
  childCatalogDescriptor,
  childTemplate,
  database,
  issueOwner,
  principalOnlyTables,
  principalOnlyTemplate,
  scalarField,
  templateOf,
  version,
  withFingerprint,
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

const enumerablePayload = (value: object): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    payload[key] = (value as Record<string, unknown>)[key];
  }
  return payload;
};

describe("assembleDeployedCatalogs", () => {
  test("assembles a branded unit; require(key) returns it; keys() lists the root", async () => {
    const catalogs = await assemble({ root: catalog, units: [appUnit()] });
    const deployed = Result.getOrThrow(catalogs.require(catalog));
    expect(deployed.catalogKey).toBe(catalog);
    expect(deployed.unitHash).toMatch(/^[0-9a-f]{64}$/);
    expect(deployed.unit._tag).toBe("InstalledCatalogUnit");
    expect(deployed.unit.unitHash).toBe(deployed.unitHash);
    expect(catalogs.keys()).toEqual([catalog]);
  });

  test("requireUnitHash succeeds on match and CatalogVersionMismatch on a wrong hash", async () => {
    const catalogs = await assemble({ root: catalog, units: [appUnit()] });
    const deployed = Result.getOrThrow(catalogs.require(catalog));
    expect(Result.isSuccess(requireUnitHash(deployed.unitHash, deployed.unitHash, catalog))).toBe(
      true,
    );

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

  test("resolveDeployedCatalog composes require and requireUnitHash", async () => {
    const catalogs = await assemble({ root: catalog, units: [appUnit()] });
    const deployed = Result.getOrThrow(catalogs.require(catalog));
    const agreed = Result.getOrThrow(
      requireUnitHash(deployed.unitHash, deployed.unitHash, catalog),
    );
    expect(agreed).toBeUndefined();

    const resolved = resolveDeployedCatalog(catalogs, {
      catalogKey: catalog,
      unitHash: deployed.unitHash,
    });
    expect(Result.getOrThrow(resolved).unitHash).toBe(deployed.unitHash);
    expect(Result.getOrThrow(resolved).unit).toBe(deployed.unit);

    const wrong = resolveDeployedCatalog(catalogs, {
      catalogKey: catalog,
      unitHash: CatalogUnitHash.make(digestHex(0xab)),
    });
    expect(Result.isFailure(wrong)).toBe(true);
    if (Result.isFailure(wrong)) {
      expect(wrong.failure._tag).toBe("CatalogVersionMismatch");
    }
  });

  test("missing key is CatalogMismatch", async () => {
    const catalogs = await assemble({ root: catalog, units: [appUnit()] });
    const missing = catalogs.require(CatalogId.make("other"));
    expect(Result.isFailure(missing)).toBe(true);
    if (Result.isFailure(missing)) {
      expect(missing.failure._tag).toBe("CatalogMismatch");
      expect(missing.failure.message).toBe("catalog mismatch");
      expect(missing.failure.expected).toBe(CatalogId.make("other"));
    }
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

  test("missing child catalog referenced from root.children fails", async () => {
    const failure = await assembleFail({
      root: catalog,
      units: [appUnit({ children: [CatalogId.make("lib")] })],
    });
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain("lib");
    expect(failure.message).toContain("app");
  });

  test("diamond reachability: same child via two parents, identical definition, one unit", async () => {
    const mid = CatalogId.make("mid");
    const midDescriptor = await withFingerprint(principalOnlyTables(mid, database, "profile"));
    const catalogs = await assemble({
      root: catalog,
      units: [
        appUnit({ children: [childCatalog, mid] }),
        {
          catalog: childCatalog,
          database,
          version,
          descriptor: childCatalogDescriptor(),
          policy: childTemplate(),
        },
        {
          catalog: mid,
          database,
          version,
          children: [childCatalog],
          descriptor: midDescriptor,
          policy: principalOnlyTemplate("profile"),
        },
      ],
    });
    const deployed = Result.getOrThrow(catalogs.require(childCatalog));
    expect(deployed.catalogKey).toBe(childCatalog);
    expect([...catalogs.keys()]).toEqual([catalog, childCatalog, mid].slice().sort());
  });

  test("same-database root and child with distinct canonical user entities fail assembly", async () => {
    const colliding = await withFingerprint(principalOnlyTables(childCatalog, database, "user"));
    const failure = await assembleFail({
      root: catalog,
      units: [
        appUnit({ children: [childCatalog] }),
        {
          catalog: childCatalog,
          database,
          version,
          descriptor: colliding,
          policy: principalOnlyTemplate("user"),
        },
      ],
    });
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain(":user");
    expect(failure.message).toContain(database);
    expect(failure.message.toLowerCase()).toMatch(/physical|distinct|maps to/);
    expect(failure.message).toContain("app/user");
    expect(failure.message).toContain("lib/user");
  });

  test("entity-owned and trait-owned fields with the same physical ident fail assembly", async () => {
    const tables = {
      ...catalogSchemaTables(),
      traits: [
        ...catalogSchemaTables().traits,
        { id: TraitId.make({ catalog, name: "user" }), traits: [] },
      ],
      fields: [
        ...catalogSchemaTables().fields,
        {
          id: FieldId.make({
            catalog,
            owner: { kind: "trait", name: "user" },
            localName: "authId",
          }),
          valueType: "string" as const,
          cardinality: "one" as const,
          index: false,
          optional: false,
          owned: false,
        },
      ],
    };
    const failure = await assembleFail({
      root: catalog,
      units: [appUnit({ descriptor: await withFingerprint(tables) })],
    });
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain(":user/authId");
    expect(failure.message).toMatch(/entity:user\/authId/);
    expect(failure.message).toMatch(/trait:user\/authId/);
  });

  test("distinct canonical fields mapping to one physical ident fail assembly", async () => {
    const libTables = {
      ...principalOnlyTables(childCatalog, database, "account"),
      traits: [{ id: TraitId.make({ catalog: childCatalog, name: "issue" }), traits: [] }],
      fields: [
        ...principalOnlyTables(childCatalog, database, "account").fields,
        {
          id: FieldId.make({
            catalog: childCatalog,
            owner: { kind: "trait", name: "issue" },
            localName: "title",
          }),
          valueType: "string" as const,
          cardinality: "one" as const,
          index: false,
          optional: false,
          owned: false,
        },
      ],
    };
    const colliding = await withFingerprint(libTables);
    const failure = await assembleFail({
      root: catalog,
      units: [
        appUnit({ children: [childCatalog] }),
        {
          catalog: childCatalog,
          database,
          version,
          descriptor: colliding,
          policy: childTemplate(),
        },
      ],
    });
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain(":issue/title");
    expect(failure.message).toContain(database);
    expect(failure.message).toMatch(/entity:issue\/title/);
    expect(failure.message).toMatch(/trait:issue\/title/);
  });

  test("same-database catalogs with non-colliding physical idents assemble", async () => {
    const catalogs = await assemble({
      root: catalog,
      units: [
        appUnit({ children: [childCatalog] }),
        {
          catalog: childCatalog,
          database,
          version,
          descriptor: childCatalogDescriptor(),
          policy: childTemplate(),
        },
      ],
    });
    expect([...catalogs.keys()]).toEqual([catalog, childCatalog].slice().sort());
    expect(Result.getOrThrow(catalogs.require(childCatalog)).unit.catalog.entities[0]?.id.name).toBe(
      "account",
    );
  });

  test("same local names in different databases assemble", async () => {
    const otherDatabase = DatabaseId.make("crm");
    const otherDescriptor = await withFingerprint(
      principalOnlyTables(childCatalog, otherDatabase, "user"),
    );
    const catalogs = await assemble({
      root: catalog,
      units: [
        appUnit({ children: [childCatalog] }),
        {
          catalog: childCatalog,
          database: otherDatabase,
          version,
          descriptor: otherDescriptor,
          policy: principalOnlyTemplate("user"),
        },
      ],
    });
    expect(Result.getOrThrow(catalogs.require(catalog)).unit.catalog.database).toBe(database);
    expect(Result.getOrThrow(catalogs.require(childCatalog)).unit.catalog.database).toBe(
      otherDatabase,
    );
    expect(Result.getOrThrow(catalogs.require(childCatalog)).unit.catalog.entities[0]?.id.name).toBe(
      "user",
    );
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
      units: [
        appUnit(),
        {
          catalog: childCatalog,
          database,
          version,
          descriptor: childCatalogDescriptor(),
          policy: childTemplate(),
        },
      ],
    });
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain("lib");
  });

  test("opaqueCatalogDenial yields Unauthorized with no catalog or hash payload", async () => {
    const catalogs = await assemble({ root: catalog, units: [appUnit()] });
    const deployed = Result.getOrThrow(catalogs.require(catalog));
    const missing = catalogs.require(CatalogId.make("other"));
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
