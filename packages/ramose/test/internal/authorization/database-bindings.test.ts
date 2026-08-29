/** Dynamic Graph database bindings over real catalog units and Connections. */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Catalog, type CatalogDefinition } from "../../../src/Catalog.ts";
import {
  Entity,
  Graph,
  Schema,
  schemaTx,
  string,
} from "../../../src/db/internal.ts";
import { Unauthorized } from "../../../src/db/Errors.ts";
import {
  CatalogId,
  DatabaseCatalogBindingConflict,
  DatabaseId,
  DigestHex,
  DynamicCatalogDefinitionMissing,
  InvalidDynamicGraphIdentity,
  InvalidResolvedDatabaseRoute,
  acquireResolvedDatabase,
  assembleCatalogDefinitions,
  compileReadAuthorization,
  deployCatalogDefinitions,
  deployDatabaseCatalogBindings,
  executeAuthorizedResolvedRequest,
  hasClass,
  opaqueDatabaseBindingDenial,
  read,
  resolveBoundCatalogDefinition,
  type AuthenticatedCaller,
  type DatabaseCatalogBindings,
  type ResolvedDatabaseRoute,
} from "../../../src/internal/authorization/index.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index } from "../../../src/internal/core/datom.ts";
import { Db } from "../../../src/internal/core/db.ts";
import { restoreEngineTypeAssertions } from "../../../src/internal/core/tx-provenance.ts";

const rootDatabase = DatabaseId.make("graph-binding-root");

const RootNote = Entity("bindingRootNote", { text: string() });
const ChildNote = Entity("bindingChildNote", { text: string() });
const OtherNote = Entity("bindingOtherNote", { text: string() });

let childCatalog!: CatalogDefinition;
let otherCatalog!: CatalogDefinition;

const Workspace = Entity("bindingWorkspace", {}, {
  traits: [Graph(() => childCatalog)],
});
const Project = Entity("bindingProject", {}, {
  traits: [Graph(() => otherCatalog)],
});

const RootSchema = Schema({
  bindingWorkspace: Workspace,
  bindingProject: Project,
  bindingRootNote: RootNote,
});
const ChildSchema = Schema({ bindingChildNote: ChildNote });
const OtherSchema = Schema({ bindingOtherNote: OtherNote });

childCatalog = Catalog("binding-child", {
  schema: ChildSchema,
  policy: compileReadAuthorization({
    schema: ChildSchema,
    classes: ["child-reader"],
    rules: [read(ChildNote).when(hasClass("child-reader"))],
  }),
});
otherCatalog = Catalog("binding-other", {
  schema: OtherSchema,
  policy: compileReadAuthorization({
    schema: OtherSchema,
    classes: ["other-reader"],
    rules: [read(OtherNote).when(hasClass("other-reader"))],
  }),
});
const rootCatalog = Catalog("binding-root", {
  schema: RootSchema,
  policy: compileReadAuthorization({
    schema: RootSchema,
    classes: ["root-reader"],
    rules: [read(RootNote).when(hasClass("root-reader"))],
  }),
});

const typedTx = <T extends unknown[]>(tx: T): T => {
  restoreEngineTypeAssertions(tx);
  return tx;
};

const deploy = async (artifact = "9") => {
  const definitions = await Effect.runPromise(assembleCatalogDefinitions({
    root: rootCatalog,
    artifactHash: DigestHex.make(artifact.repeat(64)),
  }));
  const roots = Result.getOrThrow(deployCatalogDefinitions(definitions, [{
    database: rootDatabase,
    catalogKey: CatalogId.make(rootCatalog.key),
  }]));
  const bindings = Result.getOrThrow(
    deployDatabaseCatalogBindings(definitions, roots),
  );
  return { definitions, roots, bindings };
};

const rootRoute = (
  bindings: DatabaseCatalogBindings,
): ResolvedDatabaseRoute => Result.getOrThrow(bindings.root(rootDatabase));

const childRoute = (
  bindings: DatabaseCatalogBindings,
  parent: ResolvedDatabaseRoute,
  graphEntity: number,
  catalogKey = CatalogId.make(childCatalog.key),
) => Effect.runPromise(bindings.child(parent, { graphEntity, catalogKey }));

const failChildRoute = (
  bindings: DatabaseCatalogBindings,
  parent: ResolvedDatabaseRoute,
  graphEntity: number,
  catalogKey: CatalogId,
) => Effect.runPromise(Effect.flip(
  bindings.child(parent, { graphEntity, catalogKey }),
));

describe("dynamic database catalog bindings", () => {
  test("derives distinct deterministic child databases while reusing one immutable definition", async () => {
    const first = await deploy();
    const parent = rootRoute(first.bindings);
    const beforeKeys = first.definitions.keys();

    const left = await childRoute(first.bindings, parent, 1_000);
    const leftAgain = await childRoute(first.bindings, parent, 1_000);
    const right = await childRoute(first.bindings, parent, 1_001);
    const nestedLeft = await childRoute(first.bindings, left, 2_000);
    const nestedRight = await childRoute(first.bindings, right, 2_000);

    expect(leftAgain).toBe(left);
    expect(left.database).toMatch(/^[0-9a-f]{64}$/);
    expect(right.database).toMatch(/^[0-9a-f]{64}$/);
    expect(right.database).not.toBe(left.database);
    expect(nestedLeft.database).not.toBe(nestedRight.database);
    expect(nestedLeft.database).not.toBe(left.database);
    expect(left.deployed.catalogKey).toBe(CatalogId.make("binding-child"));
    expect(right.deployed.catalogKey).toBe(left.deployed.catalogKey);
    expect(right.deployed.unitHash).toBe(left.deployed.unitHash);
    expect(right.deployed.unit).toBe(left.deployed.unit);

    const installed = Result.getOrThrow(
      first.definitions.require(CatalogId.make("binding-child")),
    );
    expect(left.deployed.unit).toBe(installed.unit);
    expect(left.deployed.composition).toBe(installed.composition);
    expect(first.definitions.keys()).toEqual(beforeKeys);
    expect(first.roots.databases()).toEqual([rootDatabase]);
    expect(Result.isFailure(first.roots.catalogs.requireDatabase(left.database)))
      .toBe(true);

    const restarted = await deploy();
    const recovered = await childRoute(
      restarted.bindings,
      rootRoute(restarted.bindings),
      1_000,
    );
    expect(recovered).not.toBe(left);
    expect(recovered.database).toBe(left.database);
    expect(recovered.deployed.catalogKey).toBe(left.deployed.catalogKey);
    expect(recovered.deployed.unitHash).toBe(left.deployed.unitHash);
  });

  test("fails named missing-definition, invalid-identity, and recatalog conflicts", async () => {
    const { bindings } = await deploy();
    const parent = rootRoute(bindings);

    const missing = await failChildRoute(
      bindings,
      parent,
      1_100,
      CatalogId.make("not-deployed"),
    );
    expect(missing).toBeInstanceOf(DynamicCatalogDefinitionMissing);
    expect(missing).toMatchObject({
      parentDatabase: rootDatabase,
      graphEntity: 1_100,
      catalogKey: CatalogId.make("not-deployed"),
    });
    const denied = opaqueDatabaseBindingDenial(missing);
    expect(denied).toBeInstanceOf(Unauthorized);
    expect(JSON.stringify(denied)).not.toContain("not-deployed");
    expect(JSON.stringify(denied)).not.toContain(rootDatabase);

    const invalid = await failChildRoute(
      bindings,
      parent,
      Number.NaN,
      CatalogId.make("binding-child"),
    );
    expect(invalid).toBeInstanceOf(InvalidDynamicGraphIdentity);

    const original = await childRoute(bindings, parent, 1_200);
    const conflict = await failChildRoute(
      bindings,
      parent,
      1_200,
      CatalogId.make("binding-other"),
    );
    expect(conflict).toBeInstanceOf(DatabaseCatalogBindingConflict);
    expect(conflict).toMatchObject({
      database: original.database,
      expectedCatalogKey: CatalogId.make("binding-child"),
      actualCatalogKey: CatalogId.make("binding-other"),
    });
    expect((await childRoute(bindings, parent, 1_200))).toBe(original);
  });

  test("rejects forged, stale, and foreign routes before real acquisition", async () => {
    const first = await deploy("9");
    const route = await childRoute(first.bindings, rootRoute(first.bindings), 1_300);
    const definition = Result.getOrThrow(
      resolveBoundCatalogDefinition(first.bindings, route),
    );
    const connection = await Connection.create({
      composition: definition.definition.composition,
    });
    await connection.transact(schemaTx(ChildSchema));
    const stored = await connection.db().datomsArray(Index.EAVT, {});
    expect(stored.some(({ v }) => v === route.deployed.catalogKey)).toBe(false);
    expect(stored.some(({ v }) => v === route.deployed.unitHash)).toBe(false);

    let acquired = 0;
    const db = await Effect.runPromise(acquireResolvedDatabase(
      first.bindings,
      route,
      (database) => Effect.sync(() => {
        acquired++;
        expect(database).toBe(route.database);
        return connection.db();
      }),
    ));
    expect(db).toBeInstanceOf(Db);
    expect(acquired).toBe(1);

    const forged = {
      ...route,
      deployed: {
        ...route.deployed,
        unitHash: "0".repeat(64),
      },
    } as unknown as ResolvedDatabaseRoute;
    const forgedFailure = await Effect.runPromise(Effect.flip(
      acquireResolvedDatabase(first.bindings, forged, () => {
        acquired++;
        return Effect.succeed(connection.db());
      }),
    ));
    expect(forgedFailure).toBeInstanceOf(InvalidResolvedDatabaseRoute);
    expect(acquired).toBe(1);

    const nextDeployment = await deploy("a");
    const nextRoute = await childRoute(
      nextDeployment.bindings,
      rootRoute(nextDeployment.bindings),
      1_300,
    );
    expect(nextRoute.database).toBe(route.database);
    expect(nextRoute.deployed.unitHash).not.toBe(route.deployed.unitHash);
    const staleFailure = await Effect.runPromise(Effect.flip(
      acquireResolvedDatabase(nextDeployment.bindings, route, () => {
        acquired++;
        return Effect.succeed(connection.db());
      }),
    ));
    expect(staleFailure).toBeInstanceOf(InvalidResolvedDatabaseRoute);
    expect(acquired).toBe(1);

    const foreignFailure = await Effect.runPromise(Effect.flip(
      acquireResolvedDatabase(first.bindings, nextRoute, () => {
        acquired++;
        return Effect.succeed(connection.db());
      }),
    ));
    expect(foreignFailure).toBeInstanceOf(InvalidResolvedDatabaseRoute);
    expect(acquired).toBe(1);
  });

  test("one deployment-global caller is independently filtered at root and child routes", async () => {
    const { bindings } = await deploy();
    const root = rootRoute(bindings);
    const child = await childRoute(bindings, root, 1_400);
    const rootDefinition = Result.getOrThrow(
      resolveBoundCatalogDefinition(bindings, root),
    ).definition;
    const childDefinition = Result.getOrThrow(
      resolveBoundCatalogDefinition(bindings, child),
    ).definition;

    const rootConnection = await Connection.create({
      composition: rootDefinition.composition,
    });
    await rootConnection.transact(schemaTx(RootSchema));
    const rootReport = await rootConnection.transact(typedTx([{
      ":db/id": "root-note",
      ":ramose/type": ":bindingRootNote",
      ":bindingRootNote/text": "root visible",
    }]));
    const childConnection = await Connection.create({
      composition: childDefinition.composition,
    });
    await childConnection.transact(schemaTx(ChildSchema));
    const childReport = await childConnection.transact(typedTx([{
      ":db/id": "child-note",
      ":ramose/type": ":bindingChildNote",
      ":bindingChildNote/text": "child visible",
    }]));

    const caller = (classes: readonly string[]): AuthenticatedCaller => ({
      claims: { sub: "same-subject" },
      classes,
      exp: Math.floor(Date.now() / 1_000) + 300,
    });
    const acquire = (database: DatabaseId): Effect.Effect<Db> => {
      if (database === root.database) return Effect.succeed(rootConnection.db());
      if (database === child.database) return Effect.succeed(childConnection.db());
      return Effect.die(new Error("unexpected database acquisition"));
    };
    const visibleText = (route: ResolvedDatabaseRoute, who: AuthenticatedCaller, eid: number) =>
      Effect.runPromise(executeAuthorizedResolvedRequest({
        authenticate: Effect.succeed(who),
        bindings,
        route,
        currentDb: acquire,
      }, (db) => Effect.promise(async () => {
        const entity = await db.entity(eid);
        return entity?.[route === root
          ? ":bindingRootNote/text"
          : ":bindingChildNote/text"];
      })));

    const sameCaller = caller(["root-reader", "child-reader"]);
    expect(await visibleText(root, sameCaller, rootReport.tempids["root-note"]!))
      .toBe("root visible");
    expect(await visibleText(child, sameCaller, childReport.tempids["child-note"]!))
      .toBe("child visible");

    const rootOnly = caller(["root-reader"]);
    expect(await visibleText(root, rootOnly, rootReport.tempids["root-note"]!))
      .toBe("root visible");
    expect(await visibleText(child, rootOnly, childReport.tempids["child-note"]!))
      .toBeUndefined();
  });

  test("resolved request denial keeps binding details opaque and skips acquisition", async () => {
    const first = await deploy();
    const second = await deploy();
    const route = await childRoute(first.bindings, rootRoute(first.bindings), 1_500);
    let acquired = 0;
    const failure = await Effect.runPromise(Effect.flip(
      executeAuthorizedResolvedRequest({
        authenticate: Effect.succeed({
          claims: { sub: "subject" },
          classes: ["child-reader"],
          exp: Math.floor(Date.now() / 1_000) + 300,
        }),
        bindings: second.bindings,
        route,
        currentDb: () => {
          acquired++;
          return Effect.die(new Error("must not acquire"));
        },
      }, () => Effect.void),
    ));
    expect(failure).toBeInstanceOf(Unauthorized);
    expect(acquired).toBe(0);
    const encoded = JSON.stringify(failure);
    expect(encoded).not.toContain(route.database);
    expect(encoded).not.toContain(route.deployed.catalogKey);
    expect(encoded).not.toContain(route.deployed.unitHash);
  });
});
