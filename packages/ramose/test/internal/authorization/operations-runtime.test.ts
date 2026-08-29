/** Authoritative deployed operation boundary. Real Connection; no doubles. */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as EffectSchema from "effect/Schema";
import { Catalog } from "../../../src/Catalog.ts";
import type { CatalogDefinition } from "../../../src/Catalog.ts";
import {
  Entity,
  EntityId as OperationEntityId,
  Field,
  OwnedOperations,
  Ref,
  Schema,
  Trait,
  schemaTx,
  string,
} from "../../../src/db/internal.ts";
import { InvalidRequest, Unauthorized } from "../../../src/db/Errors.ts";
import {
  CatalogId,
  DatabaseId,
  DigestHex,
  any,
  assembleCatalogDefinitions,
  claim,
  compileReadAuthorization,
  contains,
  deployCatalogDefinitions,
  executeCatalogOperation,
  hasClass,
  invoke,
  read,
  type AuthenticatedCaller,
  type OperationInvocation,
} from "../../../src/internal/authorization/index.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import { restoreEngineTypeAssertions } from "../../../src/internal/core/tx-provenance.ts";

const database = DatabaseId.make("operations-runtime");
const artifactHash = DigestHex.make("4".repeat(64));

const Tagged = Trait("tagged", { tag: string() }, {
  operations: (Operation) => ({
    retag: Operation({
      input: EffectSchema.Struct({ tag: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId, tag: EffectSchema.String }),
      run(op, input) {
        op.self.set(Tagged.tag, input.tag);
        return { id: op.self, tag: input.tag };
      },
    }),
  }),
});

const FixedTenant = Trait("fixedTenant", { tenant: string() }, {
  bind: () => ({ values: { tenant: "acme" } }),
});
const FixedLabels = Trait("fixedLabels", { labels: Field.many(string()) }, {
  bind: () => ({ values: { labels: ["z-last", "a-first"] } }),
});
let tenantCatalog!: CatalogDefinition;
const TenantBinding = FixedTenant(() => tenantCatalog);
const LabelsBinding = FixedLabels(() => tenantCatalog);

const RenamedRefOutput = EffectSchema.Struct({
  id: OperationEntityId,
}).pipe(EffectSchema.encodeKeys({ id: "wire_id" }));

const Good = Entity("good", { name: string() }, { traits: [Tagged] });
const Other = Entity("other", { name: string() });
const Hidden = Entity("hidden", { name: string() });
const Link = Entity("link", {
  target: Ref(Tagged),
  label: string({ default: () => "default-label" }),
}, {
  traits: [TenantBinding, LabelsBinding],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ target: OperationEntityId }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        return { id: (op.create as any)({ target: input.target }) };
      },
    }),
    forgeFixed: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run(op) {
        (op.self as any).set(TenantBinding.tenant, "evil");
        return {};
      },
    }),
  }),
});

const Item = Entity("item", { title: string() }, {
  operations: (Operation) => ({
    rename: Operation({
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        op.self.set(Item.title, input.title);
        return { id: op.self };
      },
    }),
    forgeType: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run(op) {
        (op.self as any).set(":ramose/type", ":other");
        return {};
      },
    }),
    echoRef: Operation({
      self: false,
      input: EffectSchema.Struct({ id: OperationEntityId }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(_op, input) {
        return input;
      },
    }),
    echoRenamedRef: Operation({
      self: false,
      input: EffectSchema.Struct({ id: OperationEntityId }),
      output: RenamedRefOutput,
      run(_op, input) {
        return input;
      },
    }),
    deleteAndEchoTitle: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({ title: EffectSchema.String }),
      async run(op) {
        const row = await op.pull(op.self.eid, [":item/title"]) as Record<string, unknown>;
        op.self.delete();
        return { title: row[":item/title"] as string };
      },
    }),
    returnUrl: Operation({
      self: false,
      input: EffectSchema.Struct({}),
      output: EffectSchema.URLFromString,
      run() {
        return new URL("https://ramose.ai/operations") as never;
      },
    }),
    forgeNestedClaims: Operation({
      self: false,
      input: EffectSchema.Struct({ id: OperationEntityId }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        const teams = op.principal.claims.teams;
        if (Array.isArray(teams)) Reflect.set(teams, 0, "reader");
        return input;
      },
    }),
  }),
});

const App = Schema({ good: Good, other: Other, hidden: Hidden, link: Link, item: Item });

const memberOrReader = any(hasClass("member"), hasClass("reader"));
const memberOrOperator = any(hasClass("member"), hasClass("operator"));

const buildWorld = async () => {
  const Empty = Schema({});
  tenantCatalog = Catalog("tenant-values", {
    schema: Empty,
    policy: await Effect.runPromise(compileReadAuthorization({ schema: Empty, rules: [] })),
  });
  const policy = await Effect.runPromise(compileReadAuthorization({
    schema: App,
    classes: ["member", "reader", "operator"],
    rules: [
      read(Good).when(memberOrReader),
      read(Other).when(memberOrReader),
      read(Hidden).when(any(hasClass("reader"), contains(claim("teams"), "reader"))),
      read(Link).when(memberOrReader),
      read(Item).when(memberOrReader),
      invoke(Tagged[OwnedOperations].retag).when(memberOrOperator),
      invoke(Link[OwnedOperations].create).when(hasClass("member")),
      invoke(Link[OwnedOperations].forgeFixed).when(hasClass("member")),
      invoke(Item[OwnedOperations].rename).when(memberOrOperator),
      invoke(Item[OwnedOperations].forgeType).when(hasClass("member")),
      invoke(Item[OwnedOperations].echoRef).when(hasClass("member")),
      invoke(Item[OwnedOperations].echoRenamedRef).when(hasClass("member")),
      invoke(Item[OwnedOperations].deleteAndEchoTitle).when(hasClass("member")),
      invoke(Item[OwnedOperations].returnUrl).when(hasClass("member")),
      invoke(Item[OwnedOperations].forgeNestedClaims).when(hasClass("member")),
    ],
    claims: [{
      key: "teams",
      optional: true,
      shape: {
        _tag: "array",
        items: { _tag: "scalar", valueType: "string" },
      },
    }],
  }));
  const definitions = await Effect.runPromise(assembleCatalogDefinitions({
    root: Catalog("runtime", { schema: App, policy }),
    artifactHash,
  }));
  const deployed = Result.getOrThrow(deployCatalogDefinitions(definitions, [{
    database,
    catalogKey: CatalogId.make("runtime"),
  }]));
  const installed = Result.getOrThrow(definitions.require(CatalogId.make("runtime")));
  const conn = await Connection.create({ composition: installed.composition });
  await conn.transact(schemaTx(App));
  const seed = [
    { ":db/id": "good", ":ramose/type": ":good", ":good/name": "Good", ":tagged/tag": "old" },
    { ":db/id": "other", ":ramose/type": ":other", ":other/name": "Other" },
    { ":db/id": "hidden", ":ramose/type": ":hidden", ":hidden/name": "Hidden" },
    { ":db/id": "item", ":ramose/type": ":item", ":item/title": "Before" },
  ];
  restoreEngineTypeAssertions(seed);
  const report = await conn.transact(seed);
  return {
    conn,
    deployed,
    installed,
    good: report.tempids.good!,
    other: report.tempids.other!,
    hidden: report.tempids.hidden!,
    item: report.tempids.item!,
  };
};

const caller = (className: "member" | "reader" | "operator"): AuthenticatedCaller => ({
  claims: { sub: `${className}-subject` },
  classes: [className],
  exp: Math.floor(Date.now() / 1_000) + 300,
});

const invokeOperation = (
  world: Awaited<ReturnType<typeof buildWorld>>,
  input: Omit<OperationInvocation, "database" | "catalogKey" | "unitHash">,
) => executeCatalogOperation(world.conn, {
  catalogs: world.deployed,
  environment: { trusted: true },
  now: () => 1_700_000_000_000,
}, {
  ...input,
  database,
  catalogKey: world.installed.catalogKey,
  unitHash: world.installed.unitHash,
});

describe("deployed operation runtime", () => {
  test("runs a static native create with defaults, fixed values, type stamp, and filtered ref output", async () => {
    const world = await buildWorld();
    const executed = await invokeOperation(world, {
      owner: { kind: "entity", name: "link" },
      localName: "create",
      input: { target: world.good },
      caller: caller("member"),
    });

    expect(executed.output).toEqual({ id: expect.any(Number) });
    const eid = (executed.output as { id: number }).id;
    expect(await world.conn.db().entity(eid)).toMatchObject({
      ":ramose/type": ":link",
      ":link/target": world.good,
      ":link/label": "default-label",
      ":fixedTenant/tenant": "acme",
      ":fixedLabels/labels": ["a-first", "z-last"],
    });
  });

  test("requires both explicit grant and ordinary filtered target visibility", async () => {
    const world = await buildWorld();
    const base = {
      owner: { kind: "entity" as const, name: "item" },
      localName: "rename",
      target: world.item,
      input: { title: "After" },
    };
    const initialT = world.conn.t;
    await expect(invokeOperation(world, { ...base, caller: caller("reader") }))
      .rejects.toBeInstanceOf(Unauthorized);
    await expect(invokeOperation(world, { ...base, caller: caller("operator") }))
      .rejects.toBeInstanceOf(Unauthorized);
    await expect(invokeOperation(world, {
      ...base,
      target: 999_999,
      caller: caller("member"),
    })).rejects.toBeInstanceOf(Unauthorized);
    await expect(invokeOperation(world, {
      ...base,
      target: world.other,
      caller: caller("member"),
    })).rejects.toBeInstanceOf(Unauthorized);
    await expect(invokeOperation(world, {
      ...base,
      input: { title: 42 },
      caller: caller("reader"),
    })).rejects.toBeInstanceOf(Unauthorized);
    await expect(invokeOperation(world, {
      ...base,
      target: 999_999,
      input: { title: 42 },
      caller: caller("member"),
    })).rejects.toBeInstanceOf(Unauthorized);
    await expect(invokeOperation(world, {
      ...base,
      input: { title: 42 },
      caller: caller("member"),
    })).rejects.toBeInstanceOf(InvalidRequest);
    await expect(invokeOperation(world, {
      ...base,
      caller: { ...caller("member"), exp: 1 },
    })).rejects.toBeInstanceOf(Unauthorized);
    expect(world.conn.t).toBe(initialT);
    expect((await world.conn.db().entity(world.item))?.[":item/title"]).toBe("Before");
  });

  test("admits compatible trait targets and makes wrong entity types indistinguishable", async () => {
    const world = await buildWorld();
    const base = {
      owner: { kind: "trait" as const, name: "tagged" },
      localName: "retag",
      input: { tag: "new" },
      caller: caller("member"),
    };
    await expect(invokeOperation(world, { ...base, target: world.other }))
      .rejects.toBeInstanceOf(Unauthorized);
    const executed = await invokeOperation(world, { ...base, target: world.good });
    expect(executed.output).toEqual({ id: world.good, tag: "new" });
    expect((await world.conn.db().entity(world.good))?.[":tagged/tag"]).toBe("new");
  });

  test("rejects incompatible trait refs and protected type changes before commit", async () => {
    const world = await buildWorld();
    const initialT = world.conn.t;
    await expect(invokeOperation(world, {
      owner: { kind: "entity", name: "link" },
      localName: "create",
      input: { target: world.other },
      caller: caller("member"),
    })).rejects.toMatchObject({ _tag: "OperationRejected" });
    await expect(invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "forgeType",
      target: world.item,
      input: {},
      caller: caller("member"),
    })).rejects.toMatchObject({ _tag: "OperationRejected" });
    expect(world.conn.t).toBe(initialT);

    const created = await invokeOperation(world, {
      owner: { kind: "entity", name: "link" },
      localName: "create",
      input: { target: world.good },
      caller: caller("member"),
    });
    const afterCreateT = world.conn.t;
    await expect(invokeOperation(world, {
      owner: { kind: "entity", name: "link" },
      localName: "forgeFixed",
      target: (created.output as { id: number }).id,
      input: {},
      caller: caller("member"),
    })).rejects.toMatchObject({ _tag: "OperationRejected" });
    expect(world.conn.t).toBe(afterCreateT);
  });

  test("rejects output refs hidden from the resulting ordinary authorized Db", async () => {
    const world = await buildWorld();
    const initialT = world.conn.t;
    await expect(invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "echoRef",
      input: { id: world.hidden },
      caller: caller("member"),
    })).rejects.toBeInstanceOf(Unauthorized);
    expect(world.conn.t).toBe(initialT);
  });

  test("checks decoded refs before transformed output encoding", async () => {
    const world = await buildWorld();
    const initialT = world.conn.t;
    await expect(invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "echoRenamedRef",
      input: { id: world.hidden },
      caller: caller("member"),
    })).rejects.toBeInstanceOf(Unauthorized);
    expect(world.conn.t).toBe(initialT);
  });

  test("reauthorizes scalar values derived from pre-write reads", async () => {
    const world = await buildWorld();
    const initialT = world.conn.t;
    await expect(invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "deleteAndEchoTitle",
      target: world.item,
      input: {},
      caller: caller("member"),
    })).rejects.toBeInstanceOf(Unauthorized);
    expect(world.conn.t).toBe(initialT);
    expect((await world.conn.db().entity(world.item))?.[":item/title"]).toBe("Before");
  });

  test("preserves prototype-bearing values for deployed output codecs", async () => {
    const world = await buildWorld();
    const executed = await invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "returnUrl",
      input: {},
      caller: caller("member"),
    });
    expect(executed.output).toBe("https://ramose.ai/operations");
  });

  test("isolates nested authenticated claims from native operation code", async () => {
    const world = await buildWorld();
    const authenticated = {
      ...caller("member"),
      claims: { sub: "member-subject", teams: ["member"] },
    } satisfies AuthenticatedCaller;
    const initialT = world.conn.t;
    await expect(invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "forgeNestedClaims",
      input: { id: world.hidden },
      caller: authenticated,
    })).rejects.toBeInstanceOf(Unauthorized);
    expect(authenticated.claims.teams).toEqual(["member"]);
    expect(world.conn.t).toBe(initialT);
  });
});
