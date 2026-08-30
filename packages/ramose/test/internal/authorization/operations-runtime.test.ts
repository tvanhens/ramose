import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as EffectSchema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
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
  stored,
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
  $,
  all,
  any,
  assembleCatalogDefinitions,
  authorizeCatalogOperation,
  authorizeCatalogOperationReplay,
  claim,
  compileReadAuthorization,
  contains,
  deployCatalogDefinitions,
  executeCatalogOperation,
  eq,
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
    staticDelete: Operation({
      self: false,
      input: EffectSchema.Struct({ id: OperationEntityId }),
      output: EffectSchema.Struct({}),
      run(op, input) {
        op.entity(input.id).delete();
        return {};
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

const CrashingInputValue = EffectSchema.String.pipe(EffectSchema.decodeTo(
  EffectSchema.String,
  {
    decode: SchemaGetter.transform((value) => {
      if (value === "explode") {
        throw new Error("postgres://input-secret@internal/codec");
      }
      return value;
    }),
    encode: SchemaGetter.transform((value) => value),
  },
));

const CrashingFieldValue = EffectSchema.String.pipe(EffectSchema.decodeTo(
  EffectSchema.String,
  {
    decode: SchemaGetter.transform((value) => value),
    encode: SchemaGetter.transform((value) => {
      if (value === "explode") {
        throw new Error("postgres://field-secret@internal/codec");
      }
      return value;
    }),
  },
));

const InvalidRefValue = EffectSchema.Literals([-1]);
const CrashingRefValue = EffectSchema.Finite.pipe(EffectSchema.decodeTo(
  EffectSchema.Finite,
  {
    decode: SchemaGetter.transform((value) => value),
    encode: SchemaGetter.transform(() => {
      throw new Error("postgres://ref-secret@internal/codec");
    }),
  },
));

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

const Item = Entity("item", {
  title: string(),
  guarded: Field(stored(CrashingFieldValue, "string"), { optional: true }),
  invalidRef: Field(stored(InvalidRefValue, "ref"), { optional: true }),
  crashingRef: Field(stored(CrashingRefValue, "ref"), { optional: true }),
}, {
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
    inputCrash: Operation({
      self: false,
      input: EffectSchema.Struct({ value: CrashingInputValue }),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
    fieldCodec: Operation({
      input: EffectSchema.Struct({
        kind: EffectSchema.Literals(["invalid", "crash"]),
      }),
      output: EffectSchema.Struct({}),
      run(op, input) {
        op.self.set(Item.guarded, (input.kind === "invalid" ? 42 : "explode") as never);
        return {};
      },
    }),
    refFieldCodec: Operation({
      input: EffectSchema.Struct({
        kind: EffectSchema.Literals(["invalid", "crash"]),
        id: OperationEntityId,
      }),
      output: EffectSchema.Struct({}),
      run(op, input) {
        op.self.set(
          input.kind === "invalid" ? Item.invalidRef : Item.crashingRef,
          input.id as never,
        );
        return {};
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
    nativeTransport: Operation({
      self: false,
      input: EffectSchema.Struct({}),
      output: EffectSchema.Unknown,
      run() {
        const ownProto = Object.create(null) as Record<string, unknown>;
        ownProto.__proto__ = "output-owned";
        ownProto.kept = true;
        return {
          tagged: { vt: 1, v: "codec-owned" },
          ownProto,
          date: new Date(0),
          bytes: new Uint8Array([1, 2, 3]),
          bigint: 9n,
          set: new Set(["first", "second"]),
          map: new Map([["__proto__", "map-owned"], ["key", "value"]]),
        };
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

const SemanticsShared = Trait("semanticsShared", {
  key: Field.unique(string(), "upsert", { optional: true }),
  note: string({ optional: true }),
}, {
  operations: (Operation) => ({
    helper: Operation({
      self: false,
      input: EffectSchema.Struct({
        action: EffectSchema.Literals(["set", "remove", "delete"]),
        id: OperationEntityId,
      }),
      output: EffectSchema.Struct({}),
      run(op, input) {
        const handle = op.entity(input.id);
        if (input.action === "set") handle.set(SemanticsShared.note, "helper");
        if (input.action === "remove") handle.remove(SemanticsShared.note, "helper");
        if (input.action === "delete") handle.delete();
        return {};
      },
    }),
  }),
});

const SemanticsOther = Entity("semanticsOther", { name: string() }, {
  traits: [SemanticsShared],
});
const SemanticsHidden = Entity("semanticsHidden", { name: string() }, {
  traits: [SemanticsShared],
});
const SemanticsPlain = Entity("semanticsPlain", { name: string() });
const SemanticsOwner = Entity("semanticsOwner", { name: string() }, {
  traits: [SemanticsShared],
  operations: (Operation) => ({
    ownerHelper: Operation({
      self: false,
      input: EffectSchema.Struct({
        action: EffectSchema.Literals(["set", "remove", "delete"]),
        id: OperationEntityId,
      }),
      output: EffectSchema.Struct({}),
      run(op, input) {
        const handle = op.entity(input.id);
        if (input.action === "set") handle.set(SemanticsShared.note, "helper");
        if (input.action === "remove") handle.remove(SemanticsShared.note, "helper");
        if (input.action === "delete") handle.delete();
        return {};
      },
    }),
    explicitHelper: Operation({
      self: false,
      input: EffectSchema.Struct({
        action: EffectSchema.Literals([
          "handleSet",
          "directSet",
          "handleRemove",
          "directRemove",
          "handleDelete",
          "directDelete",
          "put",
          "update",
        ]),
        id: OperationEntityId,
      }),
      output: EffectSchema.Struct({}),
      run(op, input) {
        const runtime = op as any;
        if (input.action === "handleSet") {
          runtime.entity(SemanticsHidden, input.id).set(SemanticsShared.note, "helper");
        }
        if (input.action === "directSet") {
          runtime.set(SemanticsHidden, input.id, SemanticsShared.note, "helper");
        }
        if (input.action === "handleRemove") {
          runtime.entity(SemanticsHidden, input.id).remove(SemanticsShared.note, "helper");
        }
        if (input.action === "directRemove") {
          runtime.remove(SemanticsHidden, input.id, SemanticsShared.note, "helper");
        }
        if (input.action === "handleDelete") {
          runtime.entity(SemanticsHidden, input.id).delete();
        }
        if (input.action === "directDelete") runtime.delete(SemanticsHidden, input.id);
        if (input.action === "put") {
          runtime.put(SemanticsHidden, input.id, { note: "helper" });
        }
        if (input.action === "update") {
          runtime.update(SemanticsHidden, input.id, { note: "helper" });
        }
        return {};
      },
    }),
    lookupHelper: Operation({
      self: false,
      input: EffectSchema.Struct({
        action: EffectSchema.Literals([
          "handleSet",
          "directSet",
          "handleRemove",
          "directRemove",
          "handleDelete",
          "directDelete",
          "put",
          "update",
        ]),
        key: EffectSchema.String,
      }),
      output: EffectSchema.Struct({
        id: EffectSchema.optionalKey(OperationEntityId),
      }),
      run(op, input) {
        const runtime = op as any;
        const subject = [":semanticsShared/key", input.key];
        const next = `${input.key}-next`;
        const handle = runtime.entity(SemanticsHidden, subject);
        if (input.action === "handleSet") handle.set(SemanticsShared.key, next);
        if (input.action === "directSet") {
          runtime.set(SemanticsHidden, subject, SemanticsShared.key, next);
        }
        if (input.action === "handleRemove") {
          handle.remove(SemanticsShared.key, input.key);
        }
        if (input.action === "directRemove") {
          runtime.remove(SemanticsHidden, subject, SemanticsShared.key, input.key);
        }
        if (input.action === "handleDelete") handle.delete();
        if (input.action === "directDelete") runtime.delete(SemanticsHidden, subject);
        if (input.action === "put") {
          runtime.put(SemanticsHidden, subject, { key: next });
        }
        if (input.action === "update") {
          runtime.update(SemanticsHidden, subject, { key: next });
        }
        return input.action.endsWith("Delete") ? {} : { id: handle };
      },
    }),
    principalIdentity: Operation({
      self: false,
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({
        sub: EffectSchema.String,
        policySubject: EffectSchema.String,
      }),
      run(op) {
        return {
          sub: op.principal.sub ?? "",
          policySubject: op.principal.claims.email as string,
        };
      },
    }),
  }),
});

const SemanticsApp = Schema({
  semanticsOwner: SemanticsOwner,
  semanticsOther: SemanticsOther,
  semanticsHidden: SemanticsHidden,
  semanticsPlain: SemanticsPlain,
});
const semanticsDatabase = DatabaseId.make("operation-semantics");
const semanticsArtifactHash = DigestHex.make("5".repeat(64));

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
      invoke(Tagged[OwnedOperations].staticDelete).when(hasClass("member")),
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
      invoke(Item[OwnedOperations].inputCrash).when(hasClass("member")),
      invoke(Item[OwnedOperations].fieldCodec).when(hasClass("member")),
      invoke(Item[OwnedOperations].refFieldCodec).when(hasClass("member")),
      invoke(Item[OwnedOperations].returnUrl).when(hasClass("member")),
      invoke(Item[OwnedOperations].returnClass).when(hasClass("member")),
      invoke(Item[OwnedOperations].nativeTransport).when(hasClass("member")),
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

const ReplayGate = Entity("replayGate", { name: string() });
const ReplayNoise = Entity("replayNoise", { note: string() });
const ReplayTarget = Entity("replayTarget", {
  key: Field.unique(string(), "strict"),
  title: string(),
  gate: Ref(ReplayGate),
}, {
  operations: (Operation) => ({
    deleteAndEcho: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({ title: EffectSchema.String }),
      async run(op) {
        const row = await op.pull(op.self.eid, [":replayTarget/title"]) as Record<string, unknown>;
        op.self.delete();
        return { title: row[":replayTarget/title"] as string };
      },
    }),
    deleteAndConsumeGate: Operation({
      input: EffectSchema.Struct({ gate: Ref(ReplayGate).schema }),
      output: EffectSchema.Struct({ title: EffectSchema.String }),
      async run(op, input) {
        const row = await op.pull(op.self.eid, [":replayTarget/title"]) as Record<string, unknown>;
        op.self.delete();
        (op as any).delete(ReplayGate, input.gate);
        return { title: row[":replayTarget/title"] as string };
      },
    }),
    archive: Operation({
      input: EffectSchema.Struct({
        key: EffectSchema.String,
        title: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        op.self.set(ReplayTarget.key, input.key);
        op.self.set(ReplayTarget.title, input.title);
        return { id: op.self };
      },
    }),
    moveLookup: Operation({
      input: EffectSchema.Struct({
        replacement: OperationEntityId,
        archivedKey: EffectSchema.String,
        lookupKey: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        op.self.set(ReplayTarget.key, input.archivedKey);
        op.set(
          ReplayTarget,
          input.replacement,
          ReplayTarget.key,
          input.lookupKey,
        );
        return { id: op.self };
      },
    }),
  }),
});
const ReplayApp = Schema({
  replayGate: ReplayGate,
  replayNoise: ReplayNoise,
  replayTarget: ReplayTarget,
});
const replayDatabase = DatabaseId.make("operation-replay-fence");
const replayArtifactHash = DigestHex.make("6".repeat(64));

const buildReplayFenceWorld = async () => {
  const member = hasClass("member");
  const policy = await Effect.runPromise(compileReadAuthorization({
    schema: ReplayApp,
    classes: ["member"],
    rules: [
      read(ReplayGate).when(member),
      read(ReplayNoise).when(member),
      read(ReplayTarget).when(all(
        member,
        $(ReplayTarget).gate.name.eq("Good"),
        eq(ReplayTarget.title, "Before"),
      )),
      invoke(ReplayTarget[OwnedOperations].deleteAndEcho).when(member),
      invoke(ReplayTarget[OwnedOperations].deleteAndConsumeGate).when(member),
      invoke(ReplayTarget[OwnedOperations].archive).when(member),
      invoke(ReplayTarget[OwnedOperations].moveLookup).when(member),
    ],
  }));
  const definitions = await Effect.runPromise(assembleCatalogDefinitions({
    root: Catalog("replay-fence", { schema: ReplayApp, policy }),
    artifactHash: replayArtifactHash,
  }));
  const deployed = Result.getOrThrow(deployCatalogDefinitions(definitions, [{
    database: replayDatabase,
    catalogKey: CatalogId.make("replay-fence"),
  }]));
  const installed = Result.getOrThrow(
    definitions.require(CatalogId.make("replay-fence")),
  );
  const conn = await Connection.create({ composition: installed.composition });
  await conn.transact(schemaTx(ReplayApp));
  const seed = [
    {
      ":db/id": "gate",
      ":ramose/type": ":replayGate",
      ":replayGate/name": "Good",
    },
    {
      ":db/id": "replacement-gate",
      ":ramose/type": ":replayGate",
      ":replayGate/name": "Good",
    },
    {
      ":db/id": "third-gate",
      ":ramose/type": ":replayGate",
      ":replayGate/name": "Good",
    },
    {
      ":db/id": "noise",
      ":ramose/type": ":replayNoise",
      ":replayNoise/note": "initial",
    },
    {
      ":db/id": "target",
      ":ramose/type": ":replayTarget",
      ":replayTarget/key": "target-key",
      ":replayTarget/title": "Before",
      ":replayTarget/gate": "gate",
    },
    {
      ":db/id": "replacement",
      ":ramose/type": ":replayTarget",
      ":replayTarget/key": "replacement-key",
      ":replayTarget/title": "Hidden replacement",
      ":replayTarget/gate": "replacement-gate",
    },
    {
      ":db/id": "third",
      ":ramose/type": ":replayTarget",
      ":replayTarget/key": "third-key",
      ":replayTarget/title": "Before",
      ":replayTarget/gate": "third-gate",
    },
  ];
  restoreEngineTypeAssertions(seed);
  const report = await conn.transact(seed);
  return {
    conn,
    deployed,
    installed,
    gate: report.tempids.gate!,
    noise: report.tempids.noise!,
    target: report.tempids.target!,
    replacement: report.tempids.replacement!,
    third: report.tempids.third!,
  };
};

const replayRuntime = (world: Awaited<ReturnType<typeof buildReplayFenceWorld>>) => ({
  catalogs: world.deployed,
  environment: { trusted: true },
  now: () => 1_700_000_000_000,
});

const replayInvocation = (
  world: Awaited<ReturnType<typeof buildReplayFenceWorld>>,
  localName: "deleteAndEcho" | "deleteAndConsumeGate" | "archive" | "moveLookup",
  input: unknown,
) => ({
  owner: { kind: "entity" as const, name: "replayTarget" },
  localName,
  target: [":replayTarget/key", "target-key"] as [string, unknown],
  input,
  caller: caller("member"),
  database: replayDatabase,
  catalogKey: world.installed.catalogKey,
  unitHash: world.installed.unitHash,
});

const buildSemanticsWorld = async (subjectClaim = "sub") => {
  const policy = await Effect.runPromise(compileReadAuthorization({
    schema: SemanticsApp,
    classes: ["member"],
    rules: [
      read(SemanticsOwner).when(hasClass("member")),
      read(SemanticsOther).when(hasClass("member")),
      read(SemanticsPlain).when(hasClass("member")),
      invoke(SemanticsShared[OwnedOperations].helper).when(hasClass("member")),
      invoke(SemanticsOwner[OwnedOperations].ownerHelper).when(hasClass("member")),
      invoke(SemanticsOwner[OwnedOperations].explicitHelper).when(hasClass("member")),
      invoke(SemanticsOwner[OwnedOperations].lookupHelper).when(hasClass("member")),
      invoke(SemanticsOwner[OwnedOperations].principalIdentity).when(hasClass("member")),
    ],
    principal: { subjectClaim },
  }));
  const definitions = await Effect.runPromise(assembleCatalogDefinitions({
    root: Catalog("semantics-runtime", { schema: SemanticsApp, policy }),
    artifactHash: semanticsArtifactHash,
  }));
  const deployed = Result.getOrThrow(deployCatalogDefinitions(definitions, [{
    database: semanticsDatabase,
    catalogKey: CatalogId.make("semantics-runtime"),
  }]));
  const installed = Result.getOrThrow(
    definitions.require(CatalogId.make("semantics-runtime")),
  );
  const conn = await Connection.create({ composition: installed.composition });
  await conn.transact(schemaTx(SemanticsApp));
  const seed = [
    {
      ":db/id": "owner",
      ":ramose/type": ":semanticsOwner",
      ":semanticsOwner/name": "Owner",
      ":semanticsShared/key": "owner-key",
      ":semanticsShared/note": "seed",
    },
    {
      ":db/id": "other",
      ":ramose/type": ":semanticsOther",
      ":semanticsOther/name": "Other",
      ":semanticsShared/key": "other-key",
      ":semanticsShared/note": "seed",
    },
    {
      ":db/id": "hidden",
      ":ramose/type": ":semanticsHidden",
      ":semanticsHidden/name": "Hidden",
      ":semanticsShared/key": "hidden-key",
      ":semanticsShared/note": "seed",
    },
    {
      ":db/id": "plain",
      ":ramose/type": ":semanticsPlain",
      ":semanticsPlain/name": "Plain",
    },
  ];
  restoreEngineTypeAssertions(seed);
  const report = await conn.transact(seed);
  return {
    conn,
    deployed,
    installed,
    owner: report.tempids.owner!,
    other: report.tempids.other!,
    hidden: report.tempids.hidden!,
    plain: report.tempids.plain!,
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

const invokeSemanticsOperation = (
  world: Awaited<ReturnType<typeof buildSemanticsWorld>>,
  input: Omit<OperationInvocation, "database" | "catalogKey" | "unitHash">,
) => executeCatalogOperation(world.conn, {
  catalogs: world.deployed,
  environment: { trusted: true },
  now: () => 1_700_000_000_000,
}, {
  ...input,
  database: semanticsDatabase,
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

  test("validates a targetless trait owner handle before deleting its composer", async () => {
    const world = await buildWorld();
    const initialT = world.conn.t;
    await expect(invokeOperation(world, {
      owner: { kind: "trait", name: "tagged" },
      localName: "staticDelete",
      input: { id: world.other },
      caller: caller("member"),
    })).rejects.toBeInstanceOf(InvalidRequest);
    expect(world.conn.t).toBe(initialT);
    expect(await world.conn.db().exists(world.other)).toBe(true);

    await invokeOperation(world, {
      owner: { kind: "trait", name: "tagged" },
      localName: "staticDelete",
      input: { id: world.good },
      caller: caller("member"),
    });
    expect(await world.conn.db().exists(world.good)).toBe(false);
  });

  test("keeps contextual entity handles definition-directed across every mutation", async () => {
    const wrong = await buildSemanticsWorld();
    const wrongT = wrong.conn.t;
    for (const action of ["set", "remove", "delete"] as const) {
      await expect(invokeSemanticsOperation(wrong, {
        owner: { kind: "entity", name: "semanticsOwner" },
        localName: "ownerHelper",
        input: { action, id: wrong.other },
        caller: caller("member"),
      })).rejects.toBeInstanceOf(InvalidRequest);
      expect(wrong.conn.t).toBe(wrongT);
    }
    expect((await wrong.conn.db().entity(wrong.other))?.[":semanticsShared/note"]).toBe("seed");

    const valid = await buildSemanticsWorld();
    for (const action of ["set", "remove", "delete"] as const) {
      await invokeSemanticsOperation(valid, {
        owner: { kind: "entity", name: "semanticsOwner" },
        localName: "ownerHelper",
        input: { action, id: valid.owner },
        caller: caller("member"),
      });
    }
    expect(await valid.conn.db().exists(valid.owner)).toBe(false);
  });

  test("accepts every compatible trait composer and rejects a non-composer", async () => {
    const wrong = await buildSemanticsWorld();
    const wrongT = wrong.conn.t;
    for (const action of ["set", "remove", "delete"] as const) {
      await expect(invokeSemanticsOperation(wrong, {
        owner: { kind: "trait", name: "semanticsShared" },
        localName: "helper",
        input: { action, id: wrong.plain },
        caller: caller("member"),
      })).rejects.toBeDefined();
      expect(wrong.conn.t).toBe(wrongT);
    }

    const valid = await buildSemanticsWorld();
    for (const action of ["set", "remove", "delete"] as const) {
      await invokeSemanticsOperation(valid, {
        owner: { kind: "trait", name: "semanticsShared" },
        localName: "helper",
        input: { action, id: valid.hidden },
        caller: caller("member"),
      });
    }
    expect(await valid.conn.db().exists(valid.hidden)).toBe(false);
  });

  test("keeps explicit helpers typed without treating writes metadata as a capability", async () => {
    const actions = [
      "handleSet",
      "directSet",
      "handleRemove",
      "directRemove",
      "handleDelete",
      "directDelete",
      "put",
      "update",
    ] as const;
    const wrong = await buildSemanticsWorld();
    const descriptor = wrong.installed.unit.catalog.operations.find((operation) =>
      operation.id.owner.name === "semanticsOwner" && operation.id.localName === "explicitHelper"
    );
    expect(descriptor?.writes).toEqual([]);
    const wrongT = wrong.conn.t;
    for (const action of actions) {
      await expect(invokeSemanticsOperation(wrong, {
        owner: { kind: "entity", name: "semanticsOwner" },
        localName: "explicitHelper",
        input: { action, id: wrong.other },
        caller: caller("member"),
      })).rejects.toBeDefined();
      expect(wrong.conn.t).toBe(wrongT);
    }
    expect((await wrong.conn.db().entity(wrong.other))?.[":semanticsShared/note"]).toBe("seed");

    const valid = await buildSemanticsWorld();
    for (const action of actions.filter((candidate) => !candidate.endsWith("Delete"))) {
      await invokeSemanticsOperation(valid, {
        owner: { kind: "entity", name: "semanticsOwner" },
        localName: "explicitHelper",
        input: { action, id: valid.hidden },
        caller: caller("member"),
      });
    }
    expect((await valid.conn.db().entity(valid.hidden))?.[":semanticsShared/note"]).toBe("helper");

    for (const action of ["handleDelete", "directDelete"] as const) {
      const deletion = await buildSemanticsWorld();
      await invokeSemanticsOperation(deletion, {
        owner: { kind: "entity", name: "semanticsOwner" },
        localName: "explicitHelper",
        input: { action, id: deletion.hidden },
        caller: caller("member"),
      });
      expect(await deletion.conn.db().exists(deletion.hidden)).toBe(false);
    }
  });

  test("resolves definition-directed lookup subjects on the pre-write basis", async () => {
    const actions = [
      "handleSet",
      "directSet",
      "handleRemove",
      "directRemove",
      "handleDelete",
      "directDelete",
      "put",
      "update",
    ] as const;

    const wrong = await buildSemanticsWorld();
    const wrongT = wrong.conn.t;
    for (const action of actions) {
      await expect(invokeSemanticsOperation(wrong, {
        owner: { kind: "entity", name: "semanticsOwner" },
        localName: "lookupHelper",
        input: { action, key: "other-key" },
        caller: caller("member"),
      })).rejects.toBeDefined();
      expect(wrong.conn.t).toBe(wrongT);
    }
    expect((await wrong.conn.db().entity(wrong.other))?.[":semanticsShared/key"])
      .toBe("other-key");

    for (const action of actions) {
      const valid = await buildSemanticsWorld();
      const executed = await invokeSemanticsOperation(valid, {
        owner: { kind: "entity", name: "semanticsOwner" },
        localName: "lookupHelper",
        input: { action, key: "hidden-key" },
        caller: caller("member"),
      });
      if (action.endsWith("Delete")) {
        expect(executed.output).toEqual({});
        expect(await valid.conn.db().exists(valid.hidden)).toBe(false);
      } else {
        expect(executed.output).toEqual({ id: valid.hidden });
        const key = (await valid.conn.db().entity(valid.hidden))?.[":semanticsShared/key"];
        expect(key).toBe(action.endsWith("Remove") ? undefined : "hidden-key-next");
      }
    }
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
    const runtime = {
      catalogs: world.deployed,
      environment: { trusted: true },
      now: () => 1_700_000_000_000,
    };
    const invocation = {
      owner: { kind: "entity", name: "item" },
      localName: "deleteAndEchoTitle",
      target: world.item,
      input: {},
      caller: caller("member"),
      database,
      catalogKey: world.installed.catalogKey,
      unitHash: world.installed.unitHash,
    } as const;
    const executed = await executeCatalogOperation(
      world.conn,
      runtime,
      invocation,
    );
    expect(executed.output).toEqual({ title: "BEFORE" });
    expect(await world.conn.db().exists(world.item)).toBe(false);
    expect(executed.replayFence).toEqual({
      version: 1,
      target: {
        eid: world.item,
        type: "item",
        referenceEid: world.item,
        postCommit: {
          kind: "absent",
          authorizationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          authorizationReadSet: [],
        },
      },
      consumedRefs: [],
    });
    await expect(
      authorizeCatalogOperation(world.conn, runtime, invocation),
    ).rejects.toBeInstanceOf(Unauthorized);
    await expect(
      authorizeCatalogOperationReplay(
        world.conn,
        runtime,
        invocation,
        executed.replayFence,
      ),
    ).resolves.toBeUndefined();

    await world.conn.transact([{
      ":db/id": world.other,
      ":other/name": "Unrelated later change",
    }]);
    await expect(
      authorizeCatalogOperationReplay(
        world.conn,
        runtime,
        invocation,
        executed.replayFence,
      ),
    ).resolves.toBeUndefined();

  });

  test("binds an absent lookup target to external policy facts but ignores unrelated writes", async () => {
    const world = await buildReplayFenceWorld();
    const runtime = replayRuntime(world);
    const invocation = replayInvocation(world, "deleteAndEcho", {});
    const executed = await executeCatalogOperation(world.conn, runtime, invocation);
    expect(executed.output).toEqual({ title: "Before" });
    expect(await world.conn.db().exists(world.target)).toBe(false);
    const absentTarget = executed.replayFence.target;
    expect(absentTarget?.eid).toBe(world.target);
    expect(absentTarget?.type).toBe("replayTarget");
    expect(absentTarget?.referenceEid).toBeNull();
    expect(absentTarget?.postCommit.kind).toBe("absent");
    if (absentTarget?.postCommit.kind !== "absent") {
      throw new Error("expected absent replay fence");
    }
    expect(/^[0-9a-f]{64}$/.test(
      absentTarget.postCommit.authorizationDigest,
    )).toBe(true);
    expect(absentTarget.postCommit.authorizationReadSet).toContainEqual({
      kind: "type",
      eid: world.gate,
    });
    expect(absentTarget.postCommit.authorizationReadSet).toContainEqual({
      kind: "field",
      eid: world.gate,
      ident: ":replayGate/name",
    });
    await expect(authorizeCatalogOperationReplay(
      world.conn,
      runtime,
      invocation,
      executed.replayFence,
    )).resolves.toBeUndefined();

    await world.conn.transact([{
      ":db/id": world.noise,
      ":replayNoise/note": "unrelated",
    }]);
    await expect(authorizeCatalogOperationReplay(
      world.conn,
      runtime,
      invocation,
      executed.replayFence,
    )).resolves.toBeUndefined();

    const replacement = await buildReplayFenceWorld();
    expect(replacement.target).toBe(world.target);
    await replacement.conn.transact([
      { ":db/id": replacement.target, ":replayTarget/key": "resurrected-key" },
      { ":db/id": replacement.gate, ":replayGate/name": "Revoked" },
    ]);
    await expect(authorizeCatalogOperationReplay(
      replacement.conn,
      replayRuntime(replacement),
      invocation,
      executed.replayFence,
    )).rejects.toBeInstanceOf(Unauthorized);

    await world.conn.transact([{
      ":db/id": world.gate,
      ":replayGate/name": "Revoked",
    }]);
    expect(await world.conn.db().exists(world.target)).toBe(false);
    await expect(authorizeCatalogOperationReplay(
      world.conn,
      runtime,
      invocation,
      executed.replayFence,
    )).rejects.toBeInstanceOf(Unauthorized);
  });

  test("replays a self-hidden unresolved lookup only while its full policy witness is unchanged", async () => {
    const world = await buildReplayFenceWorld();
    const runtime = replayRuntime(world);
    const invocation = replayInvocation(world, "archive", {
      key: "archived-key",
      title: "Archived",
    });
    const executed = await executeCatalogOperation(world.conn, runtime, invocation);
    expect(executed.output).toEqual({ id: world.target });
    const hiddenTarget = executed.replayFence.target;
    expect(hiddenTarget?.eid).toBe(world.target);
    expect(hiddenTarget?.referenceEid).toBeNull();
    expect(hiddenTarget?.postCommit.kind).toBe("hidden");
    if (hiddenTarget?.postCommit.kind !== "hidden") {
      throw new Error("expected hidden replay fence");
    }
    expect(/^[0-9a-f]{64}$/.test(
      hiddenTarget.postCommit.authorizationDigest,
    )).toBe(true);
    await expect(authorizeCatalogOperationReplay(
      world.conn,
      runtime,
      invocation,
      executed.replayFence,
    )).resolves.toBeUndefined();

    await world.conn.transact([{
      ":db/id": world.noise,
      ":replayNoise/note": "unrelated",
    }]);
    await expect(authorizeCatalogOperationReplay(
      world.conn,
      runtime,
      invocation,
      executed.replayFence,
    )).resolves.toBeUndefined();

    const targetBeforeRevocation = await world.conn.db().entity(world.target);
    await world.conn.transact([{
      ":db/id": world.gate,
      ":replayGate/name": "Revoked",
    }]);
    expect(await world.conn.db().entity(world.target)).toEqual(targetBeforeRevocation);
    await expect(authorizeCatalogOperationReplay(
      world.conn,
      runtime,
      invocation,
      executed.replayFence,
    )).rejects.toBeInstanceOf(Unauthorized);
  });

  test("replays an exact post-commit lookup rebind without admitting its replacement", async () => {
    const world = await buildReplayFenceWorld();
    const runtime = replayRuntime(world);
    const invocation = replayInvocation(world, "moveLookup", {
      replacement: world.replacement,
      archivedKey: "archived-key",
      lookupKey: "target-key",
    });
    const executed = await executeCatalogOperation(world.conn, runtime, invocation);
    expect(executed.output).toEqual({ id: world.target });
    expect(await world.conn.db().entid([
      ":replayTarget/key",
      "target-key",
    ])).toBe(world.replacement);
    const hiddenTarget = executed.replayFence.target;
    expect(hiddenTarget?.eid).toBe(world.target);
    expect(hiddenTarget?.referenceEid).toBe(world.replacement);
    expect(hiddenTarget?.postCommit.kind).toBe("hidden");

    await expect(authorizeCatalogOperation(
      world.conn,
      runtime,
      invocation,
    )).rejects.toBeInstanceOf(Unauthorized);
    await expect(authorizeCatalogOperation(
      world.conn,
      runtime,
      { ...invocation, target: world.target },
    )).resolves.toMatchObject({
      target: { eid: world.target, type: "replayTarget" },
    });

    await expect(authorizeCatalogOperationReplay(
      world.conn,
      runtime,
      invocation,
      executed.replayFence,
    )).resolves.toBeUndefined();

    await world.conn.transact([
      {
        ":db/id": world.replacement,
        ":replayTarget/key": "replacement-after",
      },
      { ":db/id": world.third, ":replayTarget/key": "target-key" },
    ]);
    const beforeThirdDenial = world.conn.t;
    await expect(authorizeCatalogOperationReplay(
      world.conn,
      runtime,
      invocation,
      executed.replayFence,
    )).rejects.toBeInstanceOf(Unauthorized);
    expect(world.conn.t).toBe(beforeThirdDenial);
    expect(await world.conn.db().entid([
      ":replayTarget/key",
      "target-key",
    ])).toBe(world.third);

    await world.conn.transact([{
      ":db/id": world.third,
      ":replayTarget/key": "third-after",
    }]);
    const beforeNullDenial = world.conn.t;
    await expect(authorizeCatalogOperationReplay(
      world.conn,
      runtime,
      invocation,
      executed.replayFence,
    )).rejects.toBeInstanceOf(Unauthorized);
    expect(world.conn.t).toBe(beforeNullDenial);
    expect(await world.conn.db().entid([
      ":replayTarget/key",
      "target-key",
    ])).toBeUndefined();
  });

  test("keeps a consumed policy dependency in the absent-target witness", async () => {
    const world = await buildReplayFenceWorld();
    const runtime = replayRuntime(world);
    const invocation = replayInvocation(world, "deleteAndConsumeGate", {
      gate: world.gate,
    });
    const executed = await executeCatalogOperation(world.conn, runtime, invocation);
    expect(await world.conn.db().exists(world.target)).toBe(false);
    expect(await world.conn.db().exists(world.gate)).toBe(false);
    expect(executed.replayFence.consumedRefs).toEqual([{
      path: ["gate"],
      eid: world.gate,
      type: "replayGate",
    }]);
    await expect(authorizeCatalogOperationReplay(
      world.conn,
      runtime,
      invocation,
      executed.replayFence,
    )).resolves.toBeUndefined();

    const replacement = await buildReplayFenceWorld();
    expect(replacement.target).toBe(world.target);
    expect(replacement.gate).toBe(world.gate);
    await replacement.conn.transact([
      [":db/retractEntity", replacement.target],
      { ":db/id": replacement.gate, ":replayGate/name": "Revoked" },
    ]);
    await expect(authorizeCatalogOperationReplay(
      replacement.conn,
      replayRuntime(replacement),
      invocation,
      executed.replayFence,
    )).rejects.toBeInstanceOf(Unauthorized);
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

  test("materializes native transport values without reinterpreting codec-owned records", async () => {
    const world = await buildWorld();
    const executed = await invokeOperation(world, {
      owner: { kind: "entity", name: "item" },
      localName: "nativeTransport",
      input: {},
      caller: caller("member"),
    });
    const output = executed.output as Record<string, unknown>;
    expect(output.tagged).toEqual({ vt: 1, v: "codec-owned" });
    expect(output.date).toEqual({ $inst: 0 });
    expect(output.bytes).toEqual({ $bytes: "AQID" });
    expect(output.bigint).toBe(9);
    expect(output.set).toEqual(["first", "second"]);
    expect(Object.hasOwn(output.map as object, "__proto__")).toBe(true);
    expect((output.map as Record<string, unknown>).__proto__).toBe("map-owned");
    expect((output.map as Record<string, unknown>).key).toBe("value");
    expect(Object.hasOwn(output.ownProto as object, "__proto__")).toBe(true);
    expect((output.ownProto as Record<string, unknown>).__proto__).toBe("output-owned");
    expect((output.ownProto as Record<string, unknown>).kept).toBe(true);
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

  test("keeps the JWT subject distinct from a configurable policy subject", async () => {
    const world = await buildSemanticsWorld("email");
    const executed = await invokeSemanticsOperation(world, {
      owner: { kind: "entity", name: "semanticsOwner" },
      localName: "principalIdentity",
      input: {},
      caller: {
        claims: { sub: "jwt-subject", email: "policy@example.test" },
        classes: ["member"],
        exp: Math.floor(Date.now() / 1_000) + 300,
      },
    });
    expect(executed.output).toEqual({
      sub: "jwt-subject",
      policySubject: "policy@example.test",
    });
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

  test("distinguishes schema input refusals from unexpected codec defects", async () => {
    const world = await buildWorld();
    const invocation = {
      owner: { kind: "entity" as const, name: "item" },
      localName: "inputCrash",
      caller: caller("member"),
    };
    const initialT = world.conn.t;

    await expect(invokeOperation(world, {
      ...invocation,
      input: { value: 42 },
    })).rejects.toMatchObject({
      _tag: "InvalidRequest",
      message: expect.stringContaining("invalid operation input"),
    });
    await expect(invokeOperation(world, {
      ...invocation,
      input: { value: "explode" },
    })).rejects.toMatchObject({
      name: "OperationRuntimeFault",
      message: "operation execution failed",
      stage: "input",
    });
    expect(world.conn.t).toBe(initialT);
  });

  test("distinguishes field schema refusals from unexpected codec defects", async () => {
    const world = await buildWorld();
    const invocation = {
      owner: { kind: "entity" as const, name: "item" },
      localName: "fieldCodec",
      target: world.item,
      caller: caller("member"),
    };
    const initialT = world.conn.t;

    await expect(invokeOperation(world, {
      ...invocation,
      input: { kind: "invalid" },
    })).rejects.toMatchObject({
      _tag: "InvalidRequest",
      message: expect.stringContaining("invalid operation value for :item/guarded"),
    });
    await expect(invokeOperation(world, {
      ...invocation,
      input: { kind: "crash" },
    })).rejects.toMatchObject({
      name: "OperationRuntimeFault",
      message: "operation execution failed",
      stage: "field",
    });
    expect(world.conn.t).toBe(initialT);
  });

  test("validates resolved ref values with the deployed field codec", async () => {
    const world = await buildWorld();
    const invocation = {
      owner: { kind: "entity" as const, name: "item" },
      localName: "refFieldCodec",
      target: world.item,
      caller: caller("member"),
    };
    const initialT = world.conn.t;

    await expect(invokeOperation(world, {
      ...invocation,
      input: { kind: "invalid", id: world.other },
    })).rejects.toMatchObject({
      _tag: "InvalidRequest",
      message: expect.stringContaining("invalid operation value for :item/invalidRef"),
    });
    await expect(invokeOperation(world, {
      ...invocation,
      input: { kind: "crash", id: world.other },
    })).rejects.toMatchObject({
      name: "OperationRuntimeFault",
      message: "operation execution failed",
      stage: "field",
    });
    expect(world.conn.t).toBe(initialT);
    expect((await world.conn.db().entity(world.item))?.[":item/invalidRef"]).toBeUndefined();
    expect((await world.conn.db().entity(world.item))?.[":item/crashingRef"]).toBeUndefined();
  });
});
