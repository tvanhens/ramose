/** Authenticated Graph paths over ordinary filtered database values. */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as EffectSchema from "effect/Schema";
import { Catalog, type CatalogDefinition } from "../../../src/Catalog.ts";
import {
  Entity,
  EntityId as OperationEntityId,
  Graph,
  OwnedOperations,
  Schema,
  schemaTx,
  string,
} from "../../../src/db/internal.ts";
import { Unauthorized } from "../../../src/db/Errors.ts";
import {
  CatalogId,
  DatabaseId,
  DigestHex,
  DynamicCatalogDefinitionMissing,
  GraphPathSegmentInaccessible,
  any,
  assembleCatalogDefinitions,
  catalogProvisioningAttributes,
  compileReadAuthorization,
  deployCatalogDefinitions,
  deployDatabaseCatalogBindings,
  deriveResolvedDatabaseRoute,
  executeCatalogOperation,
  executeAuthorizedGraphPath,
  hasClass,
  invoke,
  read,
  resolveAuthorizedGraphPath,
  resolveBoundCatalogDefinition,
  type AuthenticatedCaller,
  type ResolvedDatabaseRoute,
} from "../../../src/internal/authorization/index.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import type { Db } from "../../../src/internal/core/db.ts";
import { restoreEngineTypeAssertions } from "../../../src/internal/core/tx-provenance.ts";

const rootDatabase = DatabaseId.make("graph-path-root");
const artifactHash = DigestHex.make("b".repeat(64));

let childCatalog!: CatalogDefinition;
let leafCatalog!: CatalogDefinition;

const RootGraph = Entity("pathWorkspace", {}, {
  traits: [Graph(() => childCatalog)],
});
const OtherRootGraph = Entity("pathTeam", {}, {
  traits: [Graph(() => childCatalog)],
});
const ChildGraph = Entity("pathProject", {}, {
  traits: [Graph(() => leafCatalog)],
});
const LeafNote = Entity("pathNote", { text: string() }, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ text: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        return { id: op.create({ text: input.text }) };
      },
    }),
  }),
});

const RootSchema = Schema({ pathWorkspace: RootGraph, pathTeam: OtherRootGraph });
const ChildSchema = Schema({ pathProject: ChildGraph });
const LeafSchema = Schema({ pathNote: LeafNote });

const caller = (classes: readonly string[]): AuthenticatedCaller => ({
  claims: { sub: "same-deployment-subject" },
  classes,
  exp: Math.floor(Date.now() / 1_000) + 300,
});

const typedTx = <T extends unknown[]>(tx: T): T => {
  restoreEngineTypeAssertions(tx);
  return tx;
};

const routeDefinition = (route: ResolvedDatabaseRoute) =>
  route.deployed.composition;

async function buildWorld() {
  leafCatalog = Catalog("path-leaf", {
    schema: LeafSchema,
    policy: await Effect.runPromise(compileReadAuthorization({
      schema: LeafSchema,
      classes: ["member", "root-reader"],
      rules: [
        read(LeafNote).when(hasClass("member")),
        invoke(LeafNote[OwnedOperations].create).when(hasClass("member")),
      ],
    })),
  });
  childCatalog = Catalog("path-child", {
    schema: ChildSchema,
    policy: await Effect.runPromise(compileReadAuthorization({
      schema: ChildSchema,
      classes: ["member", "root-reader"],
      rules: [
        read(ChildGraph).when(hasClass("member")),
        read(Graph).when(hasClass("member")),
        read(Graph.catalog).deny(hasClass("member")),
      ],
    })),
  });
  const rootCatalog = Catalog("path-root", {
    schema: RootSchema,
    policy: await Effect.runPromise(compileReadAuthorization({
      schema: RootSchema,
      classes: ["member", "root-reader", "row-only"],
      rules: [
        read(RootGraph).when(any(
          hasClass("member"),
          hasClass("root-reader"),
          hasClass("row-only"),
        )),
        read(OtherRootGraph).when(hasClass("member")),
        read(Graph).when(any(hasClass("member"), hasClass("root-reader"))),
        read(Graph.catalog).deny(any(hasClass("member"), hasClass("root-reader"))),
      ],
    })),
  });
  const definitions = await Effect.runPromise(assembleCatalogDefinitions({
    root: rootCatalog,
    artifactHash,
  }));
  const roots = Result.getOrThrow(deployCatalogDefinitions(definitions, [{
    database: rootDatabase,
    catalogKey: CatalogId.make(rootCatalog.key),
  }]));
  const bindings = Result.getOrThrow(
    deployDatabaseCatalogBindings(definitions, roots),
  );
  const root = Result.getOrThrow(bindings.root(rootDatabase));
  const rootConnection = await Connection.create({
    composition: routeDefinition(root),
  });
  await rootConnection.transact(schemaTx(RootSchema));
  const rootReport = await rootConnection.transact(typedTx([
    {
      ":db/id": "acme",
      ":ramose/type": ":pathWorkspace",
      ":graph/name": "acme",
      ":graph/catalog": "path-child",
    },
    {
      ":db/id": "other",
      ":ramose/type": ":pathTeam",
      ":graph/name": "other",
      ":graph/catalog": "path-child",
    },
    {
      ":db/id": "broken",
      ":ramose/type": ":pathWorkspace",
      ":graph/name": "broken",
      ":graph/catalog": "missing-definition",
    },
  ]));
  const acme = rootReport.tempids.acme!;
  const other = rootReport.tempids.other!;
  const child = await Effect.runPromise(bindings.child(root, {
    graphEntity: acme,
    catalogKey: CatalogId.make("path-child"),
  }));
  const otherChild = await Effect.runPromise(bindings.child(root, {
    graphEntity: other,
    catalogKey: CatalogId.make("path-child"),
  }));
  const otherChildConnection = await Connection.create({
    composition: routeDefinition(otherChild),
  });
  await otherChildConnection.transact(schemaTx(ChildSchema));
  const childConnection = await Connection.create({
    composition: routeDefinition(child),
  });
  await childConnection.transact(schemaTx(ChildSchema));
  const childReport = await childConnection.transact(typedTx([{
    ":db/id": "design",
    ":ramose/type": ":pathProject",
    ":graph/name": "design",
    ":graph/catalog": "path-leaf",
  }]));
  const design = childReport.tempids.design!;
  const leaf = await Effect.runPromise(bindings.child(child, {
    graphEntity: design,
    catalogKey: CatalogId.make("path-leaf"),
  }));
  const leafConnection = await Connection.create({
    composition: routeDefinition(leaf),
  });
  await leafConnection.transact(schemaTx(LeafSchema));
  const leafReport = await leafConnection.transact(typedTx([{
    ":db/id": "note",
    ":ramose/type": ":pathNote",
    ":pathNote/text": "nested visible",
  }]));
  const connections = new Map<DatabaseId, Connection>([
    [root.database, rootConnection],
    [child.database, childConnection],
    [otherChild.database, otherChildConnection],
    [leaf.database, leafConnection],
  ]);
  return {
    bindings,
    roots,
    root,
    child,
    otherChild,
    leaf,
    acme,
    design,
    note: leafReport.tempids.note!,
    rootConnection,
    childConnection,
    leafConnection,
    connections,
  };
}

type World = Awaited<ReturnType<typeof buildWorld>>;

const resolver = (
  world: World,
  classes: readonly string[],
  path: readonly string[],
  events: string[] = [],
) => resolveAuthorizedGraphPath({
  bindings: world.bindings,
  root: world.root,
  path,
  currentDb: (database) => Effect.sync(() => {
    events.push(`acquire:${database}`);
    const connection = world.connections.get(database);
    if (connection === undefined) throw new Error("database unavailable");
    return connection.db();
  }),
  provision: (route) => Effect.sync(() => {
    events.push(`provision:${route.database}`);
  }),
}, caller(classes));

describe("authorized Graph paths", () => {
  test("provisions the definition's exact physical field schema only", async () => {
    const world = await buildWorld();
    const child = Result.getOrThrow(
      resolveBoundCatalogDefinition(world.bindings, world.child),
    );
    const leaf = Result.getOrThrow(
      resolveBoundCatalogDefinition(world.bindings, world.leaf),
    );
    const byIdent = <A extends { readonly ":db/ident": string }>(
      attributes: readonly A[],
    ) => [...attributes].sort((left, right) =>
      left[":db/ident"].localeCompare(right[":db/ident"])
    );

    expect(byIdent(catalogProvisioningAttributes(child.definition))).toEqual(
      byIdent(schemaTx(ChildSchema)),
    );
    expect(byIdent(catalogProvisioningAttributes(leaf.definition))).toEqual(
      byIdent(schemaTx(LeafSchema)),
    );
  });

  test("resolves two nested levels through a fresh filtered Db per boundary", async () => {
    const world = await buildWorld();
    const events: string[] = [];
    const target = await Effect.runPromise(
      resolver(world, ["member"], ["acme", "design"], events),
    );

    expect(target.route).toBe(world.leaf);
    expect(target.derivation).toEqual({
      rootDatabase,
      graphs: [
        { graphEntity: world.acme, catalogKey: CatalogId.make("path-child") },
        { graphEntity: world.design, catalogKey: CatalogId.make("path-leaf") },
      ],
    });
    expect(await target.context.filteredDb.entity(world.note)).toMatchObject({
      ":pathNote/text": "nested visible",
    });
    expect(events).toEqual([
      `acquire:${world.root.database}`,
      `provision:${world.child.database}`,
      `acquire:${world.child.database}`,
      `provision:${world.leaf.database}`,
      `acquire:${world.leaf.database}`,
    ]);
    expect(await Effect.runPromise(
      deriveResolvedDatabaseRoute(world.bindings, target.derivation),
    )).toBe(world.leaf);
  });

  test("uses the protected catalog only after the row and name are visible", async () => {
    const world = await buildWorld();
    const rootContext = await Effect.runPromise(resolveAuthorizedGraphPath({
      bindings: world.bindings,
      root: world.root,
      path: [],
      currentDb: (database) => Effect.succeed(world.connections.get(database)!.db()),
      provision: () => Effect.void,
    }, caller(["member"])));
    expect((await rootContext.context.filteredDb.entity(world.acme))?.[":graph/name"])
      .toBe("acme");
    expect((await rootContext.context.filteredDb.entity(world.acme))?.[":graph/catalog"])
      .toBeUndefined();
    expect((await rootContext.context.currentDb.entity(world.acme))?.[":graph/catalog"])
      .toBe("path-child");

    const events: string[] = [];
    const denied = await Effect.runPromise(Effect.flip(
      resolver(world, ["row-only"], ["acme"], events),
    ));
    expect(denied).toBeInstanceOf(GraphPathSegmentInaccessible);
    expect(events).toEqual([`acquire:${world.root.database}`]);
  });

  test("does not skip an inaccessible ancestor or provision beyond it", async () => {
    const world = await buildWorld();
    const events: string[] = [];
    const denied = await Effect.runPromise(Effect.flip(
      resolver(world, ["root-reader"], ["acme", "design"], events),
    ));
    expect(denied).toBeInstanceOf(GraphPathSegmentInaccessible);
    expect(denied).toMatchObject({ index: 1, segment: "design" });
    expect(events).toEqual([
      `acquire:${world.root.database}`,
      `provision:${world.child.database}`,
      `acquire:${world.child.database}`,
    ]);
  });

  test("collapses inaccessible path failures to one external denial", async () => {
    const world = await buildWorld();
    const run = (classes: readonly string[], path: readonly string[]) =>
      Effect.runPromise(Effect.flip(executeAuthorizedGraphPath({
        authenticate: Effect.succeed(caller(classes)),
        bindings: world.bindings,
        root: world.root,
        path,
        currentDb: (database): Effect.Effect<Db> =>
          Effect.succeed(world.connections.get(database)!.db()),
        provision: () => Effect.void,
      }, () => Effect.void)));

    const missing = await run(["member"], ["absent"]);
    const denied = await run(["row-only"], ["acme"]);
    const missingDefinition = await run(["member"], ["broken"]);
    const unavailable = await Effect.runPromise(Effect.flip(
      executeAuthorizedGraphPath({
        authenticate: Effect.succeed(caller(["member"])),
        bindings: world.bindings,
        root: world.root,
        path: ["acme"],
        currentDb: () => Effect.fail("private storage failure" as const),
        provision: () => Effect.void,
      }, () => Effect.void),
    ));
    const unprovisionable = await Effect.runPromise(Effect.flip(
      executeAuthorizedGraphPath({
        authenticate: Effect.succeed(caller(["member"])),
        bindings: world.bindings,
        root: world.root,
        path: ["acme"],
        currentDb: (database): Effect.Effect<Db> =>
          Effect.succeed(world.connections.get(database)!.db()),
        provision: () => Effect.fail("private provisioning failure" as const),
      }, () => Effect.void),
    ));
    const failures = [
      missing,
      denied,
      missingDefinition,
      unavailable,
      unprovisionable,
    ];
    for (const failure of failures) expect(failure).toBeInstanceOf(Unauthorized);
    expect(new Set(failures.map((failure) => JSON.stringify(failure)))).toEqual(
      new Set([JSON.stringify(missing)]),
    );

    const rich = await Effect.runPromise(Effect.flip(
      resolver(world, ["member"], ["broken"]),
    ));
    expect(rich).toBeInstanceOf(DynamicCatalogDefinitionMissing);
  });

  test("renaming changes the address while preserving storage identity", async () => {
    const world = await buildWorld();
    const graphName = world.rootConnection.db().requireAttr(":graph/name");
    await world.rootConnection.transact([
      [":db/retract", world.acme, graphName.id, "acme"],
      [":db/add", world.acme, graphName.id, "renamed"],
    ]);

    await expect(Effect.runPromise(resolver(world, ["member"], ["acme"])))
      .rejects.toBeInstanceOf(GraphPathSegmentInaccessible);
    const renamed = await Effect.runPromise(
      resolver(world, ["member"], ["renamed"]),
    );
    expect(renamed.route).toBe(world.child);
    expect(renamed.route.database).toBe(world.child.database);
  });

  test("two graph rows reusing a definition have distinct stable children", async () => {
    const world = await buildWorld();
    const other = await Effect.runPromise(
      resolver(world, ["member"], ["other"]),
    );
    expect(other.route).toBe(world.otherChild);
    expect(other.route.database).not.toBe(world.child.database);
    expect(other.route.deployed.catalogKey).toBe(world.child.deployed.catalogKey);
    expect(other.route.deployed.unitHash).toBe(world.child.deployed.unitHash);
  });

  test("rebuilds the sealed dynamic route for authoritative target operations", async () => {
    const world = await buildWorld();
    const target = await Effect.runPromise(
      resolver(world, ["member"], ["acme", "design"]),
    );
    const executed = await executeCatalogOperation(world.leafConnection, {
      catalogs: world.roots,
      bindings: world.bindings,
      environment: { trusted: true },
      now: () => Date.now(),
    }, {
      database: target.route.database,
      catalogKey: target.route.deployed.catalogKey,
      unitHash: target.route.deployed.unitHash,
      routeDerivation: target.derivation,
      owner: { kind: "entity", name: "pathNote" },
      localName: "create",
      input: { text: "created in nested graph" },
      caller: caller(["member"]),
    });
    const created = (executed.output as { readonly id: number }).id;
    expect(await world.leafConnection.db().entity(created)).toMatchObject({
      ":ramose/type": ":pathNote",
      ":pathNote/text": "created in nested graph",
    });

    await expect(executeCatalogOperation(world.leafConnection, {
      catalogs: world.roots,
      bindings: world.bindings,
      environment: { trusted: true },
      now: () => Date.now(),
    }, {
      database: target.route.database,
      catalogKey: target.route.deployed.catalogKey,
      unitHash: target.route.deployed.unitHash,
      routeDerivation: {
        ...target.derivation,
        graphs: target.derivation.graphs.slice(0, 1),
      },
      owner: { kind: "entity", name: "pathNote" },
      localName: "create",
      input: { text: "must not run" },
      caller: caller(["member"]),
    })).rejects.toBeInstanceOf(Unauthorized);
  });
});
