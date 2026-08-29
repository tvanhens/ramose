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
  Query,
  Ref,
  Schema,
  Trait,
  type AnyQueryObject,
  schemaTx,
  string,
} from "../../../src/db/internal.ts";
import {
  InvalidRequest,
  OperationRejected,
  Unauthorized,
} from "../../../src/db/Errors.ts";
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
  OperationRuntimeFault,
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
    staticRetag: Operation({
      self: false,
      input: EffectSchema.Struct({
        id: OperationEntityId,
        tag: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: OperationEntityId, tag: EffectSchema.String }),
      run(op, input) {
        op.entity(input.id).set(Tagged.tag, input.tag);
        return input;
      },
    }),
  }),
});

let linkDefinitionForOperation: unknown;
const FixedTenant = Trait("fixedTenant", { tenant: string() }, {
  bind: () => ({ values: { tenant: "acme" } }),
  operations: (Operation) => ({
    rewriteTenant: Operation({
      self: false,
      input: EffectSchema.Struct({
        id: OperationEntityId,
        tenant: EffectSchema.String,
      }),
      output: EffectSchema.Struct({}),
      run(op, input) {
        (op.entity(input.id) as any).set(FixedTenant.tenant, input.tenant);
        return {};
      },
    }),
    createFixedLink: Operation({
      self: false,
      input: EffectSchema.Struct({ target: OperationEntityId }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        return {
          id: (op as any).put(linkDefinitionForOperation, { target: input.target }),
        };
      },
    }),
  }),
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

class ClassOutput extends EffectSchema.Class<ClassOutput>("ClassOutput")({
  label: EffectSchema.String,
}) {
  get displayLabel(): string {
    return `class:${this.label}`;
  }
}

let makeHiddenNamesQuery!: () => AnyQueryObject;

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
  }),
});
linkDefinitionForOperation = Link;

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
    authoritativeReads: Operation({
      self: false,
      input: EffectSchema.Struct({ id: Ref(Hidden).schema }),
      output: EffectSchema.Struct({
        queryName: EffectSchema.String,
        pullName: EffectSchema.String,
      }),
      async run(op, input) {
        const rows = await op.query(makeHiddenNamesQuery()) as readonly { readonly name: string }[];
        const row = await op.pull(input.id, [":hidden/name"]) as Record<string, unknown>;
        return {
          queryName: rows.find((candidate) => candidate.name === "Hidden")?.name ?? "missing",
          pullName: row[":hidden/name"] as string,
        };
      },
    }),
    deleteAndEchoTitle: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({ title: EffectSchema.String }),
      async run(op) {
        const row = await op.pull(op.self.eid, [":item/title"]) as Record<string, unknown>;
        op.self.delete();
        return { title: (row[":item/title"] as string).toUpperCase() };
      },
    }),
    deleteHiddenInput: Operation({
      self: false,
      input: EffectSchema.Struct({ id: Ref(Hidden).schema }),
      output: EffectSchema.Struct({}),
      run(op, input) {
        // `writes` is authoring metadata, not a runtime capability. Trusted
        // application code can intentionally reach another deployed entity.
        (op as any).delete(Hidden, input.id);
        return {};
      },
    }),
    deleteOnly: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run(op) {
        op.self.delete();
        return {};
      },
    }),
    renameAfterEffect: Operation({
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({}),
      async run(op, input) {
        Reflect.set(op.principal.claims, "bodyRan", true);
        await op.effect("before-write", async () => undefined);
        op.self.set(Item.title, input.title);
        return {};
      },
    }),
    crash: Operation({
      self: false,
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run() {
        throw new Error("postgres://secret@internal/operation");
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
    returnClass: Operation({
      self: false,
      input: EffectSchema.Struct({}),
      output: ClassOutput,
      run() {
        return new ClassOutput({ label: "preserved" });
      },
    }),
    invalidTransport: Operation({
      input: EffectSchema.Struct({
        kind: EffectSchema.Literals(["symbol", "function", "nonfinite", "cycle"]),
      }),
      output: EffectSchema.Unknown,
      run(op, input) {
        op.self.set(Item.title, "Must roll back");
        switch (input.kind) {
          case "symbol":
            return { lost: Symbol("not-json") };
          case "function":
            return { lost: () => "not-json" };
          case "nonfinite":
            return { changed: Number.POSITIVE_INFINITY };
          case "cycle": {
            const output: { self?: unknown } = {};
            output.self = output;
            return output;
          }
        }
      },
    }),
  }),
});

const Backlink = Entity("backlink", {
  item: Ref(Item, { optional: true }),
});

makeHiddenNamesQuery = () => Query.from(Hidden).select({ name: Hidden.name });

const App = Schema({ good: Good, other: Other, hidden: Hidden, link: Link, item: Item, backlink: Backlink });

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
      read(Backlink).when(memberOrReader),
      invoke(Tagged[OwnedOperations].retag).when(memberOrOperator),
      invoke(Tagged[OwnedOperations].staticRetag).when(hasClass("member")),
      invoke(FixedTenant[OwnedOperations].rewriteTenant).when(hasClass("member")),
      invoke(FixedTenant[OwnedOperations].createFixedLink).when(hasClass("member")),
      invoke(Link[OwnedOperations].create).when(hasClass("member")),
      invoke(Item[OwnedOperations].rename).when(memberOrOperator),
      invoke(Item[OwnedOperations].echoRef).when(hasClass("member")),
      invoke(Item[OwnedOperations].echoRenamedRef).when(hasClass("member")),
      invoke(Item[OwnedOperations].authoritativeReads).when(hasClass("member")),
      invoke(Item[OwnedOperations].deleteAndEchoTitle).when(hasClass("member")),
      invoke(Item[OwnedOperations].deleteHiddenInput).when(hasClass("member")),
      invoke(Item[OwnedOperations].deleteOnly).when(hasClass("member")),
      invoke(Item[OwnedOperations].renameAfterEffect).when(hasClass("member")),
      invoke(Item[OwnedOperations].crash).when(hasClass("member")),
      invoke(Item[OwnedOperations].returnUrl).when(hasClass("member")),
      invoke(Item[OwnedOperations].returnClass).when(hasClass("member")),
      invoke(Item[OwnedOperations].invalidTransport).when(hasClass("member")),
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
    { ":db/id": "backlink", ":ramose/type": ":backlink", ":backlink/item": "item" },
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
    backlink: report.tempids.backlink!,
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
  test("runs a static native create with defaults, fixed values, type stamp, and resolved ref output", async () => {
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

  test("resolves targetless trait owner handles on the authoritative basis", async () => {
    const world = await buildWorld();
    const executed = await invokeOperation(world, {
      owner: { kind: "trait", name: "tagged" },
      localName: "staticRetag",
      input: { id: world.good, tag: "static" },
      caller: caller("member"),
    });
    expect(executed.output).toEqual({ id: world.good, tag: "static" });
    expect((await world.conn.db().entity(world.good))?.[":tagged/tag"]).toBe("static");

    const beforeT = world.conn.t;
    await expect(invokeOperation(world, {
      owner: { kind: "trait", name: "tagged" },
      localName: "staticRetag",
      input: { id: world.other, tag: "forged" },
      caller: caller("member"),
    })).rejects.toBeDefined();
    expect(world.conn.t).toBe(beforeT);
    expect((await world.conn.db().entity(world.other))?.[":tagged/tag"]).toBeUndefined();
  });

  test("retains fixed composer semantics for a targetless trait handle", async () => {
    const world = await buildWorld();
    const created = await invokeOperation(world, {
      owner: { kind: "entity", name: "link" },
      localName: "create",
      input: { target: world.good },
      caller: caller("member"),
    });
    const link = (created.output as { readonly id: number }).id;
    const beforeT = world.conn.t;

    await expect(invokeOperation(world, {
      owner: { kind: "trait", name: "fixedTenant" },
      localName: "rewriteTenant",
      input: { id: link, tenant: "other" },
      caller: caller("member"),
    })).rejects.toBeInstanceOf(OperationRejected);

    expect(world.conn.t).toBe(beforeT);
    expect((await world.conn.db().entity(link))?.[":fixedTenant/tenant"]).toBe("acme");
  });

  test("does not apply deferred owner-handle checks to explicit creation helpers", async () => {
    const world = await buildWorld();
    const created = await invokeOperation(world, {
      owner: { kind: "trait", name: "fixedTenant" },
      localName: "createFixedLink",
      input: { target: world.good },
      caller: caller("member"),
    });
    const link = (created.output as { readonly id: number }).id;

    expect(await world.conn.db().entity(link)).toMatchObject({
      ":ramose/type": ":link",
      ":link/target": world.good,
      ":fixedTenant/tenant": "acme",
      ":fixedLabels/labels": ["a-first", "z-last"],
    });
  });

  test("keeps definition-directed ref compatibility as storage semantics", async () => {
    const world = await buildWorld();
    const initialT = world.conn.t;
    await expect(invokeOperation(world, {
      owner: { kind: "entity", name: "link" },
      localName: "create",
      input: { target: world.other },
      caller: caller("member"),
    })).rejects.toBeInstanceOf(InvalidRequest);
    expect(world.conn.t).toBe(initialT);
  });

  test("allows hidden compatible input and output refs after caller admission", async () => {
    const world = await buildWorld();
    const initialT = world.conn.t;
    const plain = await invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "echoRef",
      input: { id: world.hidden },
      caller: caller("member"),
    });
    const renamed = await invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "echoRenamedRef",
      input: { id: world.hidden },
      caller: caller("member"),
    });
    expect(plain.output).toEqual({ id: world.hidden });
    expect(renamed.output).toEqual({ wire_id: world.hidden });
    expect(world.conn.t).toBe(initialT + 2);
  });

  test("gives trusted code authoritative query and pull access hidden from the caller", async () => {
    const world = await buildWorld();
    const initialT = world.conn.t;
    const executed = await invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "authoritativeReads",
      input: { id: world.hidden },
      caller: caller("member"),
    });
    expect(executed.output).toEqual({ queryName: "Hidden", pullName: "Hidden" });
    expect(world.conn.t).toBe(initialT + 1);
  });

  test("allows a read to drive writes and return a derived value without post-state reauthorization", async () => {
    const world = await buildWorld();
    const executed = await invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "deleteAndEchoTitle",
      target: world.item,
      input: {},
      caller: caller("member"),
    });
    expect(executed.output).toEqual({ title: "BEFORE" });
    expect(await world.conn.db().exists(world.item)).toBe(false);
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

  test("preserves schema class prototypes while resolving output shapes", async () => {
    const world = await buildWorld();
    const executed = await invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "returnClass",
      input: {},
      caller: caller("member"),
    });
    expect(executed.output).toEqual({ label: "preserved" });
  });

  test("rejects silently lossy and cyclic output transport before commit", async () => {
    for (const kind of ["symbol", "function", "nonfinite", "cycle"] as const) {
      const world = await buildWorld();
      const initialT = world.conn.t;
      await expect(invokeOperation(world, {
        owner: { kind: "entity", name: "item" },
        localName: "invalidTransport",
        target: world.item,
        input: { kind },
        caller: caller("member"),
      })).rejects.toMatchObject({
        name: "OperationRuntimeFault",
        stage: "output",
      });
      expect(world.conn.t).toBe(initialT);
      expect((await world.conn.db().entity(world.item))?.[":item/title"]).toBe("Before");
    }
  });

  test("makes catalog-proof and missing-operation denials indistinguishable", async () => {
    const world = await buildWorld();
    const captureDenial = async (result: Promise<unknown>): Promise<Unauthorized> => {
      try {
        await result;
      } catch (cause) {
        expect(cause).toBeInstanceOf(Unauthorized);
        return cause as Unauthorized;
      }
      throw new Error("expected operation denial");
    };
    const missing = await captureDenial(invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "missing",
      input: {},
      caller: caller("member"),
    }));
    const mismatched = await captureDenial(executeCatalogOperation(world.conn, {
      catalogs: world.deployed,
      environment: { trusted: true },
      now: () => 1_700_000_000_000,
    }, {
      database,
      catalogKey: CatalogId.make("wrong"),
      unitHash: world.installed.unitHash,
      owner: { kind: "entity", name: "item" },
      localName: "rename",
      target: world.item,
      input: { title: "Denied" },
      caller: caller("member"),
    }));
    expect({
      status: mismatched.status,
      message: mismatched.message,
      code: mismatched.code,
      attr: mismatched.attr,
    }).toEqual({
      status: missing.status,
      message: missing.message,
      code: missing.code,
      attr: missing.attr,
    });
  });

  test("lets trusted code write a hidden deployed entity without writes metadata", async () => {
    const world = await buildWorld();
    const initialT = world.conn.t;
    const descriptor = world.installed.unit.catalog.operations.find((operation) =>
      operation.id.owner.name === "item" && operation.id.localName === "deleteHiddenInput"
    );
    expect(descriptor?.writes).toEqual([]);
    const executed = await invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "deleteHiddenInput",
      input: { id: world.hidden },
      caller: caller("member"),
    });
    expect(executed.output).toEqual({});
    expect(await world.conn.db().exists(world.hidden)).toBe(false);
    expect(world.conn.t).toBe(initialT + 1);
  });

  test("permits engine-generated incoming-ref cleanup during deletion", async () => {
    const world = await buildWorld();
    await invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "deleteOnly",
      target: world.item,
      input: {},
      caller: caller("member"),
    });
    expect(await world.conn.db().exists(world.item)).toBe(false);
    expect((await world.conn.db().entity(world.backlink))?.[":backlink/item"]).toBeUndefined();
  });

  test("captures JWT expiry independently of body-visible mutable claims", async () => {
    const world = await buildWorld();
    const initialT = world.conn.t;
    const exp = 1_700_000_001;
    let clockReads = 0;
    const authenticated = {
      claims: { sub: "member-subject", bodyRan: false },
      classes: ["member"],
      exp,
    } satisfies AuthenticatedCaller;
    await expect(executeCatalogOperation(world.conn, {
      catalogs: world.deployed,
      environment: { trusted: true },
      now: () => clockReads++ === 0 ? exp * 1_000 - 1 : exp * 1_000,
    }, {
      database,
      catalogKey: world.installed.catalogKey,
      unitHash: world.installed.unitHash,
      owner: { kind: "entity", name: "item" },
      localName: "renameAfterEffect",
      target: world.item,
      input: { title: "Expired" },
      caller: authenticated,
    })).rejects.toBeInstanceOf(Unauthorized);
    expect(authenticated.claims.bodyRan).toBeTruthy();
    expect(clockReads).toBe(2);
    expect(world.conn.t).toBe(initialT);
    expect((await world.conn.db().entity(world.item))?.[":item/title"]).toBe("Before");
  });

  test("classifies unexpected native exceptions as private runtime faults", async () => {
    const world = await buildWorld();
    await expect(invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "crash",
      input: {},
      caller: caller("member"),
    })).rejects.toMatchObject({
      name: "OperationRuntimeFault",
      message: "operation execution failed",
    } satisfies Partial<OperationRuntimeFault>);
  });
});
