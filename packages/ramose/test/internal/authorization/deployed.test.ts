/** Concrete database bindings consume only atomic installed definitions. */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Unauthorized } from "../../../src/db/Errors.ts";
import {
  CatalogId,
  CatalogUnitHash,
  CatalogVersionMismatch,
  DatabaseId,
  assembleDeployedCatalogs,
  deployedOperationKey,
  opaqueCatalogDenial,
  requireCatalogKey,
  requireUnitHash,
  resolveDeployedCatalog,
} from "../../../src/internal/authorization/index.ts";
import {
  catalog,
  catalogDescriptor,
  database,
  installedDefinitionFor,
  otherDatabase,
  runtimeOperationsFor,
  templateOf,
} from "./catalog-support.ts";
import { digestHex } from "./fixtures.ts";

const definition = async () => {
  const descriptor = catalogDescriptor();
  return installedDefinitionFor(descriptor, templateOf());
};

const assemble = async (
  units: Parameters<typeof assembleDeployedCatalogs>[0]["units"],
) => Effect.runPromise(assembleDeployedCatalogs({ units }));

describe("assembleDeployedCatalogs", () => {
  test("binds a database directly to one atomic installed definition", async () => {
    const installed = await definition();
    const catalogs = await assemble([{ database, definition: installed }]);
    const deployed = Result.getOrThrow(catalogs.requireDatabase(database));

    expect(deployed.database).toBe(database);
    expect(deployed.catalogKey).toBe(installed.catalogKey);
    expect(deployed.unitHash).toBe(installed.unitHash);
    expect(deployed.unit).toBe(installed.unit);
    expect(deployed.composition).toBe(installed.composition);
    expect(catalogs.databases()).toEqual([database]);

    const operation = installed.operations[0]!;
    const executable = deployed.operations.get(deployedOperationKey(operation.id));
    expect(executable?.descriptor).toBe(operation.descriptor);
    expect(executable?.bodySource).toBe(operation.bodySource);
    expect(typeof executable?.body).toBe("function");
  });

  test("the same immutable definition may bind many concrete databases", async () => {
    const installed = await definition();
    const catalogs = await assemble([
      { database, definition: installed },
      { database: otherDatabase, definition: installed },
    ]);
    expect(catalogs.databases()).toEqual([otherDatabase, database].sort());
    expect(Result.getOrThrow(catalogs.requireDatabase(otherDatabase)).unitHash)
      .toBe(installed.unitHash);
  });

  test("duplicate identical database bindings are idempotent", async () => {
    const installed = await definition();
    const catalogs = await assemble([
      { database, definition: installed },
      { database, definition: installed },
    ]);
    expect(catalogs.databases()).toEqual([database]);
  });

  test("different installed definitions cannot claim one database", async () => {
    const first = await definition();
    const second = Object.freeze({
      ...first,
      unitHash: CatalogUnitHash.make(digestHex(0xee)),
    });
    const failure = await Effect.runPromise(Effect.flip(
      assembleDeployedCatalogs({
        units: [
          { database, definition: first },
          { database, definition: second },
        ],
      }),
    ));
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain("distinct catalog definitions");
  });

  test("closure captures and ambient globals fail at deployment compilation", async () => {
    const descriptor = catalogDescriptor();
    const runtime = runtimeOperationsFor(descriptor);
    const captured = {
      ...runtime,
      definitions: runtime.definitions.map((entry) => ({
        ...entry,
        bodySource: "() => ambientSecret",
      })),
    };
    const installed = await installedDefinitionFor(
      descriptor,
      templateOf(),
      captured,
    );
    const failure = await Effect.runPromise(Effect.flip(
      assembleDeployedCatalogs({ units: [{ database, definition: installed }] }),
    ));
    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain("undeclared identifier 'ambientSecret'");
  });

  test("bundled sequence expressions compile deterministically", async () => {
    const descriptor = catalogDescriptor();
    const runtime = runtimeOperationsFor(descriptor);
    const sequenced = {
      ...runtime,
      definitions: runtime.definitions.map((entry) => ({
        ...entry,
        bodySource: "() => (1, {})",
      })),
    };
    const installed = await installedDefinitionFor(
      descriptor,
      templateOf(),
      sequenced,
    );
    const catalogs = await assemble([
      { database, definition: installed },
    ]);
    const deployed = Result.getOrThrow(catalogs.requireDatabase(database));
    const operation = [...deployed.operations.values()][0]!;
    expect(await operation.body({}, {})).toEqual({});
  });

  test("operation-body addition preserves ordinary JavaScript coercion", async () => {
    const descriptor = catalogDescriptor();
    const runtime = runtimeOperationsFor(descriptor);
    const concatenated = {
      ...runtime,
      definitions: runtime.definitions.map((entry) => ({
        ...entry,
        bodySource: "(_op, input) => `issue-` + input.title",
      })),
    };
    const installed = await installedDefinitionFor(
      descriptor,
      templateOf(),
      concatenated,
    );
    const catalogs = await assemble([{ database, definition: installed }]);
    const operation = [...Result.getOrThrow(catalogs.requireDatabase(database)).operations.values()][0]!;

    expect(await operation.body({}, { title: 42 })).toBe("issue-42");
  });

  test("unsupported primitive member access fails during deployment", async () => {
    const descriptor = catalogDescriptor();
    const runtime = runtimeOperationsFor(descriptor);
    const unsupported = {
      ...runtime,
      definitions: runtime.definitions.map((entry) => ({
        ...entry,
        bodySource: "(_op, input) => input.title.length",
      })),
    };
    const installed = await installedDefinitionFor(
      descriptor,
      templateOf(),
      unsupported,
    );
    const failure = await Effect.runPromise(Effect.flip(
      assembleDeployedCatalogs({ units: [{ database, definition: installed }] }),
    ));

    expect(failure._tag).toBe("InvalidIR");
    expect(failure.message).toContain("does not support member 'length' on scalar input values");
  });

  test("nested block locals are validated in their lexical scope", async () => {
    const descriptor = catalogDescriptor();
    const runtime = runtimeOperationsFor(descriptor);
    const nested = {
      ...runtime,
      definitions: runtime.definitions.map((entry) => ({
        ...entry,
        bodySource: "() => { { const row = { id: 'nested' }; return row; } }",
      })),
    };
    const installed = await installedDefinitionFor(
      descriptor,
      templateOf(),
      nested,
    );
    const catalogs = await assemble([{ database, definition: installed }]);
    const operation = [...Result.getOrThrow(catalogs.requireDatabase(database)).operations.values()][0]!;

    expect(await operation.body({}, {})).toEqual({ id: "nested" });

    const leaked = {
      ...runtime,
      definitions: runtime.definitions.map((entry) => ({
        ...entry,
        bodySource: "() => { { const row = {}; } return row; }",
      })),
    };
    const leakedDefinition = await installedDefinitionFor(
      descriptor,
      templateOf(),
      leaked,
    );
    const failure = await Effect.runPromise(Effect.flip(
      assembleDeployedCatalogs({ units: [{ database, definition: leakedDefinition }] }),
    ));
    expect(failure.message).toContain("undeclared identifier 'row'");
  });
});

describe("deployed lookup", () => {
  test("requires exact catalog key and unit hash after database selection", async () => {
    const installed = await definition();
    const catalogs = await assemble([{ database, definition: installed }]);
    const resolved = resolveDeployedCatalog(catalogs, {
      database,
      catalogKey: installed.catalogKey,
      unitHash: installed.unitHash,
    });
    expect(Result.isSuccess(resolved)).toBe(true);

    const wrongKey = resolveDeployedCatalog(catalogs, {
      database,
      catalogKey: CatalogId.make("wrong"),
      unitHash: installed.unitHash,
    });
    expect(Result.isFailure(wrongKey) && wrongKey.failure._tag).toBe("CatalogMismatch");

    const wrongHash = resolveDeployedCatalog(catalogs, {
      database,
      catalogKey: installed.catalogKey,
      unitHash: CatalogUnitHash.make(digestHex(0xee)),
    });
    expect(Result.isFailure(wrongHash) && wrongHash.failure._tag)
      .toBe("CatalogVersionMismatch");
  });

  test("pure agreement helpers and opaque denial retain their contracts", () => {
    expect(Result.isSuccess(requireCatalogKey(catalog, catalog))).toBe(true);
    expect(Result.isFailure(requireCatalogKey(CatalogId.make("a"), CatalogId.make("b"))))
      .toBe(true);
    const hash = CatalogUnitHash.make(digestHex(1));
    expect(Result.isSuccess(requireUnitHash(hash, hash, catalog))).toBe(true);
    const mismatch = requireUnitHash(
      CatalogUnitHash.make(digestHex(2)),
      hash,
      catalog,
    );
    expect(Result.isFailure(mismatch) && mismatch.failure instanceof CatalogVersionMismatch)
      .toBe(true);
    if (Result.isFailure(mismatch)) {
      expect(opaqueCatalogDenial(mismatch.failure)).toBeInstanceOf(Unauthorized);
    }
  });

  test("unknown databases fail closed", async () => {
    const catalogs = await assemble([]);
    const missing = catalogs.requireDatabase(DatabaseId.make("missing"));
    expect(Result.isFailure(missing) && missing.failure._tag).toBe("CatalogMismatch");
  });
});
