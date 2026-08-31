import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  Entity,
  EntityId as OperationEntityId,
  Field,
  Operation,
  OwnedOperations,
  Schema as CatalogSchema,
  Trait,
  string,
} from "../../../src/db/internal.ts";
import { Ref as RefSchema } from "../../../src/db/valueTypes.ts";
import {
  lowerOperationSchema,
  lowerOperationWireShape,
  lowerOwnedOperations,
  pairDeployedOperations,
} from "../../../src/internal/authorization/authoring/index.ts";
import {
  CatalogId,
  DigestHex,
  EntityId,
} from "../../../src/internal/authorization/identities.ts";
import { inputEntityRefHandles } from "../../../src/internal/authorization/entity-targets.ts";
import { formatNativeOperation } from "./native-operation-helper.ts";

const catalog = CatalogId.make("app");
const artifactHash = DigestHex.make("a".repeat(64));

const fixture = () => {
  const Slugged = Trait(
    "slugged",
    { slug: string() },
    {
      operations: (Operation) => ({
        refresh: Operation({
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          run() {
            return { ok: true };
          },
        }),
      }),
    },
  );
  const Taggable = Trait(
    "taggable",
    { tags: Field.many(string()) },
    {
      traits: [Slugged],
      operations: (Operation) => ({
        addTag: Operation({
          input: Schema.Struct({ tag: Schema.String }),
          output: Schema.Struct({}),
          doc: "Add one tag",
          run(op, { tag }) {
            op.self.set(Taggable.tags, tag);
            return {};
          },
        }),
        rebuild: Operation({
          self: false,
          input: Schema.Struct({ force: Schema.Boolean }),
          output: Schema.Struct({}),
          run() {
            return {};
          },
        }),
      }),
    },
  );
  const User = Entity("user", { name: string() });
  const Audit = Entity("audit", { message: string() });
  const Issue = Entity(
    "issue",
    { title: string() },
    {
      traits: [Taggable],
      operations: (Operation) => ({
        create: Operation({
          self: false,
          writes: [Audit],
          input: Schema.Struct({ title: Schema.String, slug: Schema.String }),
          output: Schema.Struct({ id: OperationEntityId }),
          doc: "Create an issue",
          run(op, input) {
            op.put(Audit, { message: input.title });
            return { id: op.create({ title: input.title, slug: input.slug }) };
          },
        }),
        assign: Operation({
          input: Schema.Struct({ assignee: RefSchema(User) }),
          output: Schema.Struct({}),
          run() {
            return {};
          },
        }),
      }),
    },
  );
  const Doc = Entity("doc", { body: string() }, { traits: [Slugged] });
  const App = CatalogSchema({ user: User, audit: Audit, issue: Issue, doc: Doc });
  return { Slugged, Taggable, User, Audit, Issue, Doc, App };
};

describe("owned operation authoring", () => {
  test("binds owner and local key without copying trait operations", () => {
    const { Taggable, Issue } = fixture();
    expect(Issue[OwnedOperations].create.owner).toBe(Issue);
    expect(Issue[OwnedOperations].create.localName).toBe("create");
    expect(Issue[OwnedOperations].create.self).toBe(false);
    expect(Issue[OwnedOperations].assign.self).toBe(true);
    expect(Taggable[OwnedOperations].addTag.owner).toBe(Taggable);
    expect((Issue[OwnedOperations] as { addTag?: unknown }).addTag).toBeUndefined();
    expect(Object.keys(Issue[OwnedOperations])).toEqual(["create", "assign"]);
  });

  test("preserves symbol-keyed operations on bindable trait callables", () => {
    const Bound = Trait(
      "bound",
      { catalog: string() },
      {
        bind: (definition) => ({ values: { catalog: definition.key } }),
        operations: (Operation) => ({
          inspect: Operation({
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );
    expect(Bound[OwnedOperations].inspect.owner.ns).toBe("bound");
    expect(Bound[OwnedOperations].inspect.localName).toBe("inspect");
    expect(
      Bound({ key: "child", schema: CatalogSchema({}) })[OwnedOperations]
        .inspect,
    ).toBe(Bound[OwnedOperations].inspect);
  });

  test("rejects invalid operation map keys and values", () => {
    const spec = Operation({
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      run() {
        return {};
      },
    });
    expect(() =>
      Entity("bad-key", {}, { operations: { "not/valid": spec } } as never)
    ).toThrow(/invalid operation name/);
    expect(() =>
      Entity("bad-value", {}, { operations: { run: {} } } as never)
    ).toThrow(/must be Ramose\.Operation/);
    expect(() =>
      Entity(
        "bad-symbol",
        {},
        { operations: { [Symbol("run")]: spec } } as never,
      )
    ).toThrow(/operation map keys must be strings/);
    expect(() =>
      Entity(
        "bad-author",
        {},
        { operations: () => ({ run: spec }) } as never,
      )
    ).toThrow(/must use the Operation author supplied/);
  });
});

describe("owned operation lowering", () => {
  test("produces deterministic catalog-local identities and inert descriptors", async () => {
    const { App, Issue } = fixture();
    const first = await Effect.runPromise(
      lowerOwnedOperations(catalog, App, artifactHash),
    );
    const second = await Effect.runPromise(
      lowerOwnedOperations(catalog, App, artifactHash),
    );
    const otherArtifact = await Effect.runPromise(
      lowerOwnedOperations(catalog, App, DigestHex.make("b".repeat(64))),
    );

    expect(second.descriptors).toEqual(first.descriptors);
    expect(otherArtifact.descriptors.map((entry) => entry.bodyHash)).not.toEqual(
      first.descriptors.map((entry) => entry.bodyHash),
    );
    expect(
      otherArtifact.descriptors.map((entry) => entry.inputSchemaHash),
    ).not.toEqual(first.descriptors.map((entry) => entry.inputSchemaHash));
    expect(first.descriptors.map((entry) =>
      `${entry.id.owner.kind}:${entry.id.owner.name}.${entry.id.localName}:${entry.id.target}`
    )).toEqual([
      "entity:issue.assign:required",
      "entity:issue.create:none",
      "trait:slugged.refresh:required",
      "trait:taggable.addTag:required",
      "trait:taggable.rebuild:none",
    ]);

    const create = first.descriptors.find((entry) => entry.id.localName === "create")!;
    expect(create.id.catalog).toBe(catalog);
    expect("database" in create.id).toBe(false);
    expect(create.doc).toBe("Create an issue");
    expect(create.composers).toEqual([]);
    expect(create.inputSchemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(create.outputSchemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(create.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(create.writes.map((entry) => entry.name)).toEqual(["audit"]);
    expect(JSON.stringify(first.descriptors)).not.toContain("function");

    const definition = first.definitions.find((entry) => entry.localName === "create")!;
    expect(definition.owner).toEqual({ kind: "entity", name: "issue" });
    expect(definition.input).not.toBe(Issue[OwnedOperations].create.input);
    expect(definition.input.decode({ title: "T", slug: "t" })).toEqual({
      title: "T",
      slug: "t",
    });
    expect(definition.output.encode({ id: 1 })).toEqual({ id: 1 });
    expect(definition.run as unknown).toBe(
      Issue[OwnedOperations].create.run as unknown,
    );
    expect(definition.implementationHash).toBe(create.bodyHash);
    expect(definition.writes.map((entry) => entry.name)).toEqual(["audit"]);
    expect(Object.isFrozen(first.descriptors)).toBe(true);
    expect(Object.isFrozen(first.definitions)).toBe(true);
  });

  test("retains compiled operation codecs instead of mutable schemas", async () => {
    const Input = Schema.Struct({ value: Schema.String });
    const Output = Schema.Struct({ ok: Schema.Boolean });
    const Worker = Entity("worker", {}, {
      operations: (Operation) => ({
        run: Operation({
          self: false,
          input: Input,
          output: Output,
          run: () => ({ ok: true }),
        }),
      }),
    });
    const lowered = await Effect.runPromise(
      lowerOwnedOperations(
        catalog,
        CatalogSchema({ worker: Worker }),
        artifactHash,
      ),
    );
    const definition = lowered.definitions[0]!;

    expect(Reflect.set(
      Input,
      "ast",
      Schema.Struct({ value: Schema.Finite }).ast,
    )).toBe(true);
    expect(Reflect.set(
      Output,
      "ast",
      Schema.Struct({ ok: Schema.String }).ast,
    )).toBe(true);
    expect(definition.input.decode({ value: "stable" }))
      .toEqual({ value: "stable" });
    expect(() => definition.input.decode({ value: 1 }))
      .toThrow();
    expect(definition.output.encode({ ok: true }))
      .toEqual({ ok: true });
    expect(() => definition.output.encode({ ok: "changed" }))
      .toThrow();
  });

  test("executes deployed refinements and transformations without reviving metadata", async () => {
    const trustedPrefix = "trusted:";
    const suffix = "!";
    const Captured = Schema.String.check(Schema.makeFilter((value) =>
      value.startsWith(trustedPrefix) ? true : "blocked"
    )).pipe(Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((value) => `${value}${suffix}`),
      encode: SchemaGetter.transform((value) => value.slice(0, -suffix.length)),
    }));
    const EncodedOutput = Schema.String.pipe(Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((value) => value.replace(/^wire:/, "")),
      encode: SchemaGetter.transform((value) => `wire:${value}`),
    }));
    const Worker = Entity("callbackWorker", {}, {
      operations: (Operation) => ({
        run: Operation({
          self: false,
          input: Schema.Struct({ value: Captured }),
          output: Schema.Struct({ value: EncodedOutput }),
          run: (_op, input) => ({ value: input.value }),
        }),
      }),
    });
    const lowered = await Effect.runPromise(
      lowerOwnedOperations(
        catalog,
        CatalogSchema({ callbackWorker: Worker }),
        artifactHash,
      ),
    );
    const definition = lowered.definitions[0]!;

    expect(definition.input.decode({ value: "trusted:value" })).toEqual({
      value: "trusted:value!",
    });
    expect(() => definition.input.decode({ value: "blocked" })).toThrow();
    expect(definition.output.encode({ value: "ready" })).toEqual({
      value: "wire:ready",
    });
    expect(JSON.stringify(lowered.descriptors)).not.toContain(trustedPrefix);
  });

  test("pairs and executes the original body with native JavaScript semantics", async () => {
    let suffix = "closure";
    const Worker = Entity("nativeWorker", {}, {
      operations: (Operation) => ({
        run: Operation({
          self: false,
          input: Schema.Struct({ values: Schema.Array(Schema.String) }),
          output: Schema.Struct({ formatted: Schema.String }),
          async run(_op, input) {
            await Promise.resolve();
            return {
              formatted: formatNativeOperation([...input.values, suffix]),
            };
          },
        }),
      }),
    });
    const originalRun = Worker[OwnedOperations].run.run;
    const lowered = await Effect.runPromise(
      lowerOwnedOperations(
        catalog,
        CatalogSchema({ nativeWorker: Worker }),
        artifactHash,
      ),
    );
    const binding = Result.getOrThrow(
      pairDeployedOperations(lowered.descriptors, lowered.definitions),
    )[0]!;

    expect(binding.descriptor).toBe(lowered.descriptors[0]!);
    expect(binding.run as unknown).toBe(originalRun as unknown);
    expect(Object.isFrozen(binding.run)).toBe(false);
    expect(await binding.run({}, { values: [" one ", "one"] })).toEqual({
      formatted: "NATIVE:ONE:CLOSURE",
    });
    suffix = "changed";
    expect(await binding.run({}, { values: ["two"] })).toEqual({
      formatted: "NATIVE:TWO:CHANGED",
    });
    expect("run" in binding.descriptor).toBe(false);
  });

  test("fails clearly when a public wire contract has no structural projection", async () => {
    const Opaque = Schema.declare<string>(
      (value): value is string => typeof value === "string",
      { identifier: "opaque-input" },
    );
    const Worker = Entity("opaqueWorker", {}, {
      operations: (Operation) => ({
        run: Operation({
          self: false,
          input: Opaque,
          output: Schema.Struct({}),
          run: () => ({}),
        }),
      }),
    });
    const failure = await Effect.runPromise(Effect.flip(
      lowerOwnedOperations(
        catalog,
        CatalogSchema({ opaqueWorker: Worker }),
        artifactHash,
      ),
    ));

    expect(failure.message).toContain(
      "opaque declaration 'opaque-input' has no toCodecJson/toCodec public wire projection",
    );
  });

  test("fails closed when sealed descriptors and private bindings do not pair exactly", async () => {
    const { App } = fixture();
    const lowered = await Effect.runPromise(
      lowerOwnedOperations(catalog, App, artifactHash),
    );
    const definition = lowered.definitions[0]!;
    const descriptor = lowered.descriptors.find((entry) =>
      entry.id.owner.kind === definition.owner.kind &&
      entry.id.owner.name === definition.owner.name &&
      entry.id.localName === definition.localName
    )!;

    const paired = Result.getOrThrow(
      pairDeployedOperations([descriptor], [definition]),
    );
    expect(paired[0]!.descriptor).toBe(descriptor);
    expect(paired[0]!.run).toBe(definition.run);

    const missing = pairDeployedOperations([descriptor], []);
    expect(Result.isFailure(missing)).toBe(true);
    if (Result.isFailure(missing)) {
      expect(missing.failure.message).toMatch(
        /missing deployed operation binding/,
      );
    }

    const duplicate = pairDeployedOperations(
      [descriptor],
      [definition, definition],
    );
    expect(Result.isFailure(duplicate)).toBe(true);
    if (Result.isFailure(duplicate)) {
      expect(duplicate.failure.message).toMatch(
        /duplicate deployed operation binding/,
      );
    }

    const missingExecutable = pairDeployedOperations([descriptor], [{
      ...definition,
      run: undefined as never,
    }]);
    expect(Result.isFailure(missingExecutable)).toBe(true);
    if (Result.isFailure(missingExecutable)) {
      expect(missingExecutable.failure.message).toMatch(
        /missing deployed operation executable/,
      );
    }

    const mismatch = pairDeployedOperations([descriptor], [{
      ...definition,
      implementationHash: DigestHex.make("f".repeat(64)),
    }]);
    expect(Result.isFailure(mismatch)).toBe(true);
    if (Result.isFailure(mismatch)) {
      expect(mismatch.failure.message).toMatch(
        /mismatched deployed operation binding/,
      );
    }
  });

  test("keeps trait ownership once and derives direct plus transitive composers", async () => {
    const { App } = fixture();
    const lowered = await Effect.runPromise(
      lowerOwnedOperations(catalog, App, artifactHash),
    );
    const refresh = lowered.descriptors.find((entry) => entry.id.localName === "refresh")!;
    const addTag = lowered.descriptors.find((entry) => entry.id.localName === "addTag")!;
    const rebuild = lowered.descriptors.find((entry) => entry.id.localName === "rebuild")!;

    expect(refresh.id.owner).toEqual({ kind: "trait", name: "slugged" });
    expect(refresh.composers.map((entry) => entry.name)).toEqual(["doc", "issue"]);
    expect(addTag.id.owner).toEqual({ kind: "trait", name: "taggable" });
    expect(addTag.composers.map((entry) => entry.name)).toEqual(["issue"]);
    expect(rebuild.id.target).toBe("none");
    expect(rebuild.composers).toEqual([]);
  });

  test("lowers nested schemas, optional keys, arrays, and typed refs", () => {
    const { User } = fixture();
    const shape = lowerOperationSchema(
      catalog,
      Schema.Struct({
        assignee: RefSchema(User),
        labels: Schema.Array(Schema.String),
        note: Schema.optionalKey(Schema.String),
        optionalAssignee: Schema.optionalKey(RefSchema(User)),
        optionalSelf: Schema.optionalKey(RefSchema.self),
        self: RefSchema.self,
      }),
    );
    expect(shape).toEqual({
      _tag: "struct",
      fields: [
        {
          key: "assignee",
          optional: false,
          shape: {
            _tag: "ref",
            refTarget: {
              _tag: "entity",
              entity: EntityId.make({ catalog, name: "user" }),
            },
          },
        },
        {
          key: "labels",
          optional: false,
          shape: { _tag: "array", items: { _tag: "scalar", valueType: "string" } },
        },
        {
          key: "note",
          optional: true,
          shape: { _tag: "scalar", valueType: "string" },
        },
        {
          key: "optionalAssignee",
          optional: true,
          shape: {
            _tag: "ref",
            refTarget: {
              _tag: "entity",
              entity: EntityId.make({ catalog, name: "user" }),
            },
          },
        },
        {
          key: "optionalSelf",
          optional: true,
          shape: { _tag: "ref", refTarget: { _tag: "self" } },
        },
        {
          key: "self",
          optional: false,
          shape: { _tag: "ref", refTarget: { _tag: "self" } },
        },
      ],
    });
  });

  test("lowers the wire shape at the keys a renaming codec puts on the wire", () => {
    const { User } = fixture();
    const declared = Schema.Struct({
      assignee: RefSchema(User),
      labels: Schema.Array(RefSchema(User)),
      note: Schema.String,
    });
    expect(lowerOperationWireShape(catalog, declared)).toEqual({
      _tag: "struct",
      fields: [
        { key: "assignee", shape: { _tag: "ref" } },
        { key: "labels", shape: { _tag: "array", items: { _tag: "ref" } } },
        { key: "note", shape: { _tag: "scalar" } },
      ],
    });

    const renamed = declared.pipe(
      Schema.encodeKeys({ assignee: "assignee_id", note: "wire_note" }),
    );
    expect(lowerOperationWireShape(catalog, renamed)).toEqual({
      _tag: "struct",
      fields: [
        { key: "assignee_id", shape: { _tag: "ref" } },
        { key: "labels", shape: { _tag: "array", items: { _tag: "ref" } } },
        { key: "wire_note", shape: { _tag: "scalar" } },
      ],
    });
    expect(
      (lowerOperationSchema(catalog, renamed) as unknown as {
        fields: { key: string }[];
      }).fields.map((field) => field.key),
    ).toEqual(["assignee", "labels", "note"]);
  });

  test("keeps every declared reference position a transformation leaves in place", () => {
    const { User } = fixture();
    const nested = Schema.Struct({ item: RefSchema(User) });
    const renamed = Schema.Struct({
      tags: Schema.Array(RefSchema(User)),
      outer: nested,
      note: Schema.String,
    }).pipe(Schema.encodeKeys({ note: "wire_note" }));
    const wire = lowerOperationWireShape(catalog, renamed);
    expect(wire).toEqual({
      _tag: "struct",
      fields: [
        { key: "outer", shape: { _tag: "struct", fields: [{ key: "item", shape: { _tag: "ref" } }] } },
        { key: "tags", shape: { _tag: "array", items: { _tag: "ref" } } },
        { key: "wire_note", shape: { _tag: "scalar" } },
      ],
    });
    expect(
      inputEntityRefHandles(wire, {
        outer: { item: "handle-a" },
        tags: ["handle-b", "handle-c"],
        wire_note: "not a reference",
      }),
    ).toEqual([["outer", "item"], ["tags", 0], ["tags", 1]]);
  });

  test("falls back to the declared shape when a transformation loses a reference", () => {
    const { User } = fixture();
    const restated = Schema.Struct({ assignee: RefSchema(User) }).pipe(
      Schema.decodeTo(
        Schema.Struct({ assignee: Schema.String }),
        {
          decode: SchemaGetter.transform((value: { assignee: number }) => ({
            assignee: String(value.assignee),
          })),
          encode: SchemaGetter.transform((value: { assignee: string }) => ({
            assignee: Number(value.assignee),
          })),
        },
      ),
    );
    const declared = lowerOperationSchema(catalog, restated);
    expect(declared).toEqual({
      _tag: "struct",
      fields: [
        { key: "assignee", optional: false, shape: { _tag: "scalar", valueType: "string" } },
      ],
    });
    expect(lowerOperationWireShape(catalog, restated)).toEqual(declared);
  });

  test("rejects refs hidden in unsupported union, tuple, and refinement schemas", () => {
    const Missing = Entity("missing", {});
    const schemas = [
      Schema.Union([RefSchema.self, Schema.String]),
      Schema.Tuple([RefSchema(Missing), Schema.String]),
      RefSchema.self.pipe(Schema.check(Schema.isGreaterThan(0))),
      Schema.Record(RefSchema.self as never, Schema.String),
      Schema.Record(RefSchema(Missing) as never, Schema.String),
    ];
    for (const schema of schemas) {
      expect(() => lowerOperationSchema(catalog, schema)).toThrow(
        /refs (nested inside|wrapped by) an unsupported .* operation schema cannot be lowered/,
      );
    }
    expect(() =>
      lowerOperationSchema(catalog, Schema.suspend(() => RefSchema.self))
    ).toThrow("suspended operation schemas cannot be lowered");
    expect(() =>
      lowerOperationSchema(
        catalog,
        Schema.Struct({ [Symbol("self")]: RefSchema.self }),
      )
    ).toThrow("operation structs with symbol keys cannot be lowered");
  });

  test("fails operation lowering before fingerprinting a nested opaque ref", async () => {
    const Invalid = Entity(
      "invalidNestedRef",
      {},
      {
        operations: (Operation) => ({
          inspect: Operation({
            input: Schema.Union([RefSchema.self, Schema.String]),
            output: Schema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        lowerOwnedOperations(
          catalog,
          CatalogSchema({ invalidNestedRef: Invalid }),
          artifactHash,
        ),
      ),
    );
    expect(failure.message).toBe(
      "operation schema lowering failed: refs nested inside an unsupported Union operation schema cannot be lowered",
    );
  });

  test("fails operation lowering before fingerprinting a suspended ref", async () => {
    const Invalid = Entity(
      "invalidSuspendedRef",
      {},
      {
        operations: (Operation) => ({
          inspect: Operation({
            self: false,
            input: Schema.suspend(() => RefSchema.self),
            output: Schema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        lowerOwnedOperations(
          catalog,
          CatalogSchema({ invalidSuspendedRef: Invalid }),
          artifactHash,
        ),
      ),
    );
    expect(failure.message).toBe(
      "operation schema lowering failed: suspended operation schemas cannot be lowered",
    );
  });

  test("is idempotent across repeated schema components and rejects conflicts", async () => {
    const { App } = fixture();
    const repeated = await Effect.runPromise(
      lowerOwnedOperations(catalog, [App, App], artifactHash),
    );
    expect(repeated.descriptors).toHaveLength(5);

    const OtherIssue = Entity(
      "issue",
      {},
      {
        operations: (Operation) => ({
          create: Operation({
            self: false,
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );
    const conflicting = CatalogSchema({ issue: OtherIssue });
    const failure = await Effect.runPromise(
      Effect.flip(lowerOwnedOperations(catalog, [App, conflicting], artifactHash)),
    );
    expect(failure.message).toBe("duplicate entity definition 'issue'");
  });

  test("rejects a write dependency that conflicts with the catalog definition", async () => {
    const CanonicalAudit = Entity("conflictingAudit", { canonical: string() });
    const ConflictingAudit = Entity("conflictingAudit", { other: string() });
    const Owner = Entity(
      "writeOwner",
      {},
      {
        operations: (Operation) => ({
          write: Operation({
            writes: [ConflictingAudit],
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        lowerOwnedOperations(
          catalog,
          CatalogSchema({ conflictingAudit: CanonicalAudit, writeOwner: Owner }),
          artifactHash,
        ),
      ),
    );
    expect(failure.message).toBe(
      "conflicting write definition 'conflictingAudit' in operation 'writeOwner.write'",
    );
  });

  test("rejects target-resource schema inputs on targetless definitions", async () => {
    const Invalid = Entity(
      "invalid",
      {},
      {
        operations: (Operation) => ({
          inspect: Operation({
            self: false,
            input: Schema.Struct({ nested: Schema.optionalKey(RefSchema.self) }),
            output: Schema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        lowerOwnedOperations(
          catalog,
          CatalogSchema({ invalid: Invalid }),
          artifactHash,
        ),
      ),
    );
    expect(failure.message).toBe(
      "targetless operation 'invalid.inspect' cannot reference self",
    );
  });

  test("rejects entity-trait namespace clashes across schema components", async () => {
    const FooEntity = Entity("foo", {});
    const FooTrait = Trait("foo", {});
    const BarEntity = Entity("bar", {}, { traits: [FooTrait] });
    const failure = await Effect.runPromise(
      Effect.flip(
        lowerOwnedOperations(
          catalog,
          [CatalogSchema({ foo: FooEntity }), CatalogSchema({ bar: BarEntity })],
          artifactHash,
        ),
      ),
    );
    expect(failure.message).toBe(
      'ramose/schema: "foo" is both an entity and a trait',
    );
  });
});
