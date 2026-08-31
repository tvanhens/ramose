import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as EffectSchema from "effect/Schema";
import {
  Entity,
  EntityId as OperationEntityId,
  Graph,
  Query,
  Ref,
  Schema,
  lowerQueryObject,
  schemaTx,
  string,
} from "../../../src/db/internal.ts";
import { OperationRejected } from "../../../src/db/Errors.ts";
import {
  CatalogId,
  DatabaseId,
  DigestHex,
  assembleCatalogDefinitions,
  compileReadFilter,
  deployCatalogDefinitions,
  executeCatalogOperation,
  type AuthenticatedCaller,
  type OperationInvocation,
} from "../../../src/internal/authorization/index.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index } from "../../../src/internal/core/datom.ts";
import { query as coreQuery } from "../../../src/internal/core/index.ts";

const database = DatabaseId.make("graph-runtime");
const artifactHash = DigestHex.make("6".repeat(64));

const Membership = Entity("graphMembership", {
  graph: Ref(Graph),
  role: string(),
});

let childSchema!: Schema.Any;

const Workspace = Entity("graphWorkspace", {}, {
  traits: [Graph(() => childSchema)],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      writes: [Membership],
      input: EffectSchema.Struct({
        name: EffectSchema.String,
        doc: EffectSchema.optionalKey(EffectSchema.String),
        invalidMembership: EffectSchema.Boolean,
      }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        const graph = op.create({
          name: input.name,
          ...(input.doc === undefined ? {} : { doc: input.doc }),
        });
        op.put(Membership, {
          graph: input.invalidMembership ? -1 as never : graph,
          role: "owner",
        });
        return { id: graph };
      },
    }),
    recatalog: Operation({
      input: EffectSchema.Struct({
        action: EffectSchema.Literals(["set", "remove"]),
      }),
      output: EffectSchema.Struct({}),
      run(op, input) {
        if (input.action === "set") {
          (op.self as any).set(Graph.catalog, "other-child");
        } else {
          (op.self as any).remove(Graph.catalog);
        }
        return {};
      },
    }),
  }),
});

const Project = Entity("graphProject", {}, {
  traits: [Graph(() => childSchema)],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      writes: [Membership],
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        const graph = op.create({ name: input.name });
        op.put(Membership, { graph, role: "owner" });
        return { id: graph };
      },
    }),
  }),
});

const App = Schema("graph-root", {
  graphWorkspace: Workspace,
  graphProject: Project,
  graphMembership: Membership,
});
const ChildSchema = Schema("graph-child", {});
ChildSchema.applyPolicy(() => {});
childSchema = ChildSchema;
App.applyPolicy(
  { roles: ["member", "rowOnly", "refReader"] },
  ({ policy, session }) => {
    policy.graphWorkspace.read.where(session.hasRole("member"));
    policy.graphWorkspace.read.where(session.hasRole("rowOnly"));
    policy.graphWorkspace.read.where(session.hasRole("refReader"));
    policy.graphProject.read.where(session.hasRole("member"));
    policy.graphMembership.read.where(session.hasRole("member"));
    policy.graphMembership.read.where(session.hasRole("refReader"));
    policy.graph.read.where(session.hasRole("member"));
    policy.graph.fields.catalog.read.denyWhere(session.hasRole("member"));
    policy.graphWorkspace.operations.create.where(session.hasRole("member"));
    policy.graphWorkspace.operations.recatalog.where(session.hasRole("member"));
    policy.graphProject.operations.create.where(session.hasRole("member"));
  },
);

const caller = (className: "member" | "rowOnly" | "refReader"): AuthenticatedCaller => ({
  claims: { sub: `${className}-subject` },
  classes: [className],
  exp: Math.floor(Date.now() / 1_000) + 300,
});

const buildWorld = async () => {
  const definitions = await Effect.runPromise(assembleCatalogDefinitions({
    root: App,
    artifactHash,
  }));
  const deployed = Result.getOrThrow(deployCatalogDefinitions(definitions, [{
    database,
    catalogKey: CatalogId.make("graph-root"),
  }]));
  const installed = Result.getOrThrow(
    definitions.require(CatalogId.make("graph-root")),
  );
  const conn = await Connection.create({ composition: installed.composition });
  await conn.transact(schemaTx(App));
  return { conn, definitions, deployed, installed };
};

const invokeGraph = (
  world: Awaited<ReturnType<typeof buildWorld>>,
  invocation: Omit<OperationInvocation, "database" | "catalogKey" | "unitHash">,
) => executeCatalogOperation(world.conn, {
  catalogs: world.deployed,
  environment: { trusted: true },
  now: () => 1_700_000_000_000,
}, {
  ...invocation,
  database,
  catalogKey: world.installed.catalogKey,
  unitHash: world.installed.unitHash,
});

const filteredDb = (
  world: Awaited<ReturnType<typeof buildWorld>>,
  className: "member" | "rowOnly" | "refReader",
) => {
  const currentDb = world.conn.db();
  return currentDb.filter(compileReadFilter({
    unit: world.installed.unit,
    principal: {
      subject: `${className}-subject`,
      claims: { sub: `${className}-subject` },
      classes: [className],
    },
    currentDb,
  }));
};

describe("deployed Graph runtime", () => {
  test("creates an ordinary graph row and related facts in one authoritative commit", async () => {
    const world = await buildWorld();
    const before = world.conn.t;
    const executed = await invokeGraph(world, {
      owner: { kind: "entity", name: "graphWorkspace" },
      localName: "create",
      input: {
        name: "acme",
        doc: "Acme workspace",
        invalidMembership: false,
      },
      caller: caller("member"),
    });
    const id = (executed.output as { readonly id: number }).id;
    expect(world.conn.t).toBe(before + 1);
    expect(await world.conn.db().entity(id)).toMatchObject({
      ":ramose/type": ":graphWorkspace",
      ":graph/catalog": "graph-child",
      ":graph/name": "acme",
      ":graph/doc": "Acme workspace",
    });
    expect((await world.conn.db().entity(id))?.[":ramose/trait"]).toBeUndefined();
    const type = world.conn.db().requireAttr(":ramose/type");
    expect(await world.conn.db().datomsArray(Index.EAVT, { e: id, a: type.id }))
      .toHaveLength(1);

    const graphRef = world.conn.db().requireAttr(":graphMembership/graph");
    const memberships = await world.conn.db().datomsArray(Index.AEVT, {
      a: graphRef.id,
    });
    const membership = memberships.find((datom) => datom.v === id);
    expect(membership).toBeDefined();
    expect(await world.conn.db().entity(membership!.e)).toMatchObject({
      ":ramose/type": ":graphMembership",
      ":graphMembership/graph": id,
      ":graphMembership/role": "owner",
    });

    expect(world.definitions.keys().map(String)).toEqual([
      "graph-child",
      "graph-root",
    ]);
    expect(world.installed.unit.catalog.traits.filter(({ id: trait }) =>
      trait.name === "graph"
    )).toHaveLength(1);
  });

  test("rolls back graph creation when a related Graph ref is invalid", async () => {
    const world = await buildWorld();
    const before = world.conn.t;
    await expect(invokeGraph(world, {
      owner: { kind: "entity", name: "graphWorkspace" },
      localName: "create",
      input: {
        name: "rollback",
        invalidMembership: true,
      },
      caller: caller("member"),
    })).rejects.toBeDefined();
    expect(world.conn.t).toBe(before);
    expect(await world.conn.db().entid([":graph/name", "rollback"]))
      .toBeUndefined();
  });

  test("keeps the deployed catalog key fixed after creation", async () => {
    const world = await buildWorld();
    const created = await invokeGraph(world, {
      owner: { kind: "entity", name: "graphWorkspace" },
      localName: "create",
      input: { name: "fixed", invalidMembership: false },
      caller: caller("member"),
    });
    const id = (created.output as { readonly id: number }).id;
    for (const action of ["set", "remove"] as const) {
      const before = world.conn.t;
      await expect(invokeGraph(world, {
        owner: { kind: "entity", name: "graphWorkspace" },
        localName: "recatalog",
        target: id,
        input: { action },
        caller: caller("member"),
      })).rejects.toBeInstanceOf(OperationRejected);
      expect(world.conn.t).toBe(before);
      expect((await world.conn.db().entity(id))?.[":graph/catalog"])
        .toBe("graph-child");
    }
  });

  test("enforces sibling names across composers and uses ordinary filtered trait/ref reads", async () => {
    const world = await buildWorld();
    const workspace = await invokeGraph(world, {
      owner: { kind: "entity", name: "graphWorkspace" },
      localName: "create",
      input: { name: "shared", invalidMembership: false },
      caller: caller("member"),
    });
    const workspaceId = (workspace.output as { readonly id: number }).id;
    const beforeCollision = world.conn.t;
    await expect(invokeGraph(world, {
      owner: { kind: "entity", name: "graphProject" },
      localName: "create",
      input: { name: "shared" },
      caller: caller("member"),
    })).rejects.toMatchObject({ code: "tx/unique-conflict" });
    expect(world.conn.t).toBe(beforeCollision);
    expect(await world.conn.db().entid([":graph/name", "shared"]))
      .toBe(workspaceId);

    const project = await invokeGraph(world, {
      owner: { kind: "entity", name: "graphProject" },
      localName: "create",
      input: { name: "secret" },
      caller: caller("member"),
    });
    const projectId = (project.output as { readonly id: number }).id;
    expect((await world.conn.db().entity(workspaceId))?.[":graph/catalog"])
      .toBe("graph-child");
    expect((await world.conn.db().entity(projectId))?.[":graph/catalog"])
      .toBe("graph-child");

    const memberDb = filteredDb(world, "member");
    expect(await memberDb.entity(workspaceId)).toMatchObject({
      ":ramose/type": ":graphWorkspace",
      ":graph/name": "shared",
    });
    expect((await memberDb.entity(workspaceId))?.[":graph/catalog"])
      .toBeUndefined();

    const rowOnlyDb = filteredDb(world, "rowOnly");
    expect(await rowOnlyDb.entity(workspaceId)).toMatchObject({
      ":ramose/type": ":graphWorkspace",
    });
    expect((await rowOnlyDb.entity(workspaceId))?.[":graph/name"])
      .toBeUndefined();

    const memberListing = lowerQueryObject(
      Query.from(Graph).select({ id: Graph.id, name: Graph.name }),
    );
    const memberRows = memberListing.finalize(
      await coreQuery(memberDb, memberListing.query),
    ) as readonly { readonly id: number; readonly name: string }[];
    expect(memberRows.map(({ name }) => name).sort()).toEqual([
      "secret",
      "shared",
    ]);

    const rowOnlyListing = lowerQueryObject(
      Query.from(Graph).select({ id: Graph.id }),
    );
    const rowOnlyRows = rowOnlyListing.finalize(
      await coreQuery(rowOnlyDb, rowOnlyListing.query),
    ) as readonly { readonly id: number }[];
    expect(rowOnlyRows).toEqual([{ id: workspaceId }]);

    const graphRef = world.conn.db().requireAttr(":graphMembership/graph");
    const refs = await world.conn.db().datomsArray(Index.AEVT, { a: graphRef.id });
    const workspaceMembership = refs.find((datom) => datom.v === workspaceId)!;
    const projectMembership = refs.find((datom) => datom.v === projectId)!;
    const refReaderDb = filteredDb(world, "refReader");
    expect((await refReaderDb.entity(workspaceMembership.e))?.[
      ":graphMembership/graph"
    ]).toBe(workspaceId);
    expect((await refReaderDb.entity(projectMembership.e))?.[
      ":graphMembership/graph"
    ]).toBeUndefined();
  });
});
