import * as Effect from "effect/Effect";
import * as EffectSchema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { Catalog, Policy } from "ramose";
import {
  Entity,
  EntityId as OperationEntityId,
  Field,
  OperationRejected,
  OwnedOperations,
  Ref,
  Schema,
  Trait,
  bytes,
  stored,
  string,
  timestamp,
  uuid,
} from "ramose/db";

export const OPERATION_DATABASES = Object.freeze([
  "operations-static",
  "operations-idempotent-concurrent",
  "operations-idempotent-disconnect",
  "operations-idempotent-authorization",
  "operations-idempotent-indeterminate",
  "operations-idempotent-revocation",
  "operations-idempotent-self-delete",
  "operations-targeted",
  "operations-expiry",
  "operations-response-expiry",
  "operations-denials",
  "operations-trusted",
  "operations-version-compatibility",
  "operations-version-changed",
  "operations-version-shape",
  "operations-version-pinned-replay",
  "operations-allocation-mappings",
  "operations-allocation-undeclared",
  "operations-sealed-target",
  "operations-sealed-hidden",
  "operations-sealed-quarantine",
  "operations-allocation-misbound",
  "operations-sealed-cold",
  "operations-client-submission",
  "operations-client-root-proof",
  "operations-client-answers",
  "operations-mcp-describe",
  "operations-mcp-query",
  "operations-mcp-mutate",
  "operations-mcp-expiry",
  "operations-mcp-budget",
  "operations-sealed-input",
  "operations-sealed-input-taxonomy",
  "operations-sealed-input-consumed",
  "operations-sealed-input-pinned",
  "operations-sealed-input-renamed",
  "operations-client-input-refs",
  "operations-client-storm",
  "operations-seal-order",
]);

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

export const Other = Entity("nativeOther", { name: Field.unique(string(), "strict") }, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        return { id: op.create({ name: input.name }) };
      },
    }),

    createAllocating: Operation({
      self: false,
      allocates: { other: ["id"] },
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        return { id: op.create({ name: input.name }) };
      },
    }),
    rename: Operation({
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ name: EffectSchema.String }),
      run(op, input) {
        op.self.set(Other.name, input.name);
        return { name: input.name };
      },
    }),
  }),
});

export const Item = Entity("nativeItem", {
  title: string(),
  state: string({ default: () => "new" }),
  guarded: Field(stored(CrashingFieldValue, "string"), { optional: true }),
  invalidRef: Field(stored(InvalidRefValue, "ref"), { optional: true }),
  crashingRef: Field(stored(CrashingRefValue, "ref"), { optional: true }),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        return { id: op.create({ title: input.title }) };
      },
    }),

    createAllocating: Operation({
      self: false,
      allocates: { item: ["id"] },
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        return { id: op.create({ title: input.title }) };
      },
    }),

    misallocating: Operation({
      allocates: { item: ["id"] },
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        op.self.set(Item.title, input.title);
        return { id: op.self };
      },
    }),
    rename: Operation({
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId, title: EffectSchema.String }),
      run(op, input) {
        op.self.set(Item.title, input.title);
        return { id: op.self, title: input.title };
      },
    }),

    retitleByRef: Operation({
      self: false,
      input: EffectSchema.Struct({
        item: OperationEntityId,
        title: EffectSchema.String,
        note: EffectSchema.String,
      }),
      output: EffectSchema.Struct({
        item: OperationEntityId,
        title: EffectSchema.String,
        note: EffectSchema.String,
      }),
      run(op, input) {
        op.set(Item, input.item, Item.title, input.title);
        return { item: input.item, title: input.title, note: input.note };
      },
    }),
    retitleByRenamedRef: Operation({
      self: false,
      input: EffectSchema.Struct({
        item: OperationEntityId,
        also: OperationEntityId,
        title: EffectSchema.String,
        note: EffectSchema.String,
      }).pipe(EffectSchema.encodeKeys({ item: "item_id", note: "wire_note" })),
      output: EffectSchema.Struct({
        item: OperationEntityId,
        also: OperationEntityId,
        title: EffectSchema.String,
        note: EffectSchema.String,
      }),
      run(op, input) {
        op.set(Item, input.item, Item.title, input.title);
        return {
          item: input.item,
          also: input.also,
          title: input.title,
          note: input.note,
        };
      },
    }),
    deleteAndEchoTitle: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({ title: EffectSchema.String }),
      async run(op) {
        const row = await op.pull(op.self.eid, [":nativeItem/title"]) as Record<string, unknown>;
        op.self.delete();
        return { title: (row[":nativeItem/title"] as string).toUpperCase() };
      },
    }),
    deleteHiddenOther: Operation({
      self: false,
      input: EffectSchema.Struct({ id: Ref(Other).schema }),
      output: EffectSchema.Struct({ name: EffectSchema.String }),
      async run(op, input) {
        const row = await op.pull(input.id, [":nativeOther/name"]) as Record<string, unknown>;
        (op as any).delete(Other, input.id);
        return { name: (row[":nativeOther/name"] as string).toUpperCase() };
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
    echoTransportTagInput: Operation({
      self: false,
      input: EffectSchema.Struct({ $inst: EffectSchema.String }),
      output: EffectSchema.Struct({ $inst: EffectSchema.String }),
      run(_op, input) {
        return input;
      },
    }),
    returnTransportTag: Operation({
      self: false,
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({ $inst: EffectSchema.String }),
      run() {
        return { $inst: "application-value" };
      },
    }),
    echoExactWireValues: Operation({
      self: false,
      input: EffectSchema.Unknown,
      output: EffectSchema.Unknown,
      run(op, input) {
        return {
          input,
          claim: op.principal.claims.transportClaim,
          tagged: { vt: 1, v: "output-owned" },
          ownProto: JSON.parse('{"__proto__":"output-owned","kept":true}'),
        };
      },
    }),
    reject: Operation({
      self: false,
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run() {
        throw new OperationRejected({
          message: "domain refused",
          operation: "nativeItem/reject",
          step: "rule",
          reason: "intentional",
        });
      },
    }),
  }),
});

export const SealedTrait = Trait("nativeSealed", { sealedNote: string() });

const encodedRow = (label: string) => ({
  sealedNote: "trait-hidden",
  label,
  at: new Date(1_700_000_000_000),
  blob: new Uint8Array([1, 2, 3, 250]),
  key: "8f14e45f-ceea-467a-9c8b-4e2f9b7c1a30",
  secret: "policy-hidden",
  tenantOnly: "acme-only",
  rowScoped: "row-scoped",
});

export const Encoded = Entity("nativeEncoded", {
  label: string(),
  at: timestamp(),
  blob: bytes(),
  key: uuid(),

  secret: string(),

  tenantOnly: string(),

  rowScoped: string(),
}, {
  traits: [SealedTrait],
  operations: (Operation) => ({
    opaqueOutcome: Operation({
      self: false,
      input: EffectSchema.Struct({ label: EffectSchema.String }),
      output: EffectSchema.Unknown,
      run(op, input) {
        op.create(encodedRow(input.label));
        return { principalEid: 4099 };
      },
    }),
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ label: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId }),
      run(op, input) {
        return { id: op.create(encodedRow(input.label)) };
      },
    }),

    createRenamed: Operation({
      self: false,
      input: EffectSchema.Struct({ label: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId }).pipe(
        EffectSchema.encodeKeys({ id: "wire_id" }),
      ),
      run(op, input) {
        return { id: op.create(encodedRow(input.label)) };
      },
    }),
  }),
});

export const OperationSchema = Schema({
  nativeItem: Item,
  nativeOther: Other,
  nativeEncoded: Encoded,
});

const policy = await Effect.runPromise(Policy.compileReadAuthorization({
  schema: OperationSchema,
  classes: ["member", "reader", "operator"],
  claims: [{ key: "tenant", optional: true, shape: { _tag: "scalar", valueType: "string" } }],
  rules: [
    Policy.read(Item).when(Policy.any(Policy.hasClass("member"), Policy.hasClass("reader"))),
    Policy.read(Other).when(Policy.hasClass("reader")),
    Policy.invoke(Item[OwnedOperations].create).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].createAllocating).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].misallocating).when(Policy.hasClass("member")),
    Policy.invoke(Other[OwnedOperations].createAllocating).when(Policy.hasClass("member")),
    Policy.invoke(Other[OwnedOperations].rename).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].rename).when(Policy.any(
      Policy.hasClass("member"),
      Policy.hasClass("operator"),
    )),
    Policy.invoke(Item[OwnedOperations].retitleByRef).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].retitleByRenamedRef).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].deleteAndEchoTitle).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].deleteHiddenOther).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].crash).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].inputCrash).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].fieldCodec).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].refFieldCodec).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].echoTransportTagInput).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].returnTransportTag).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].echoExactWireValues).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].reject).when(Policy.hasClass("member")),
    Policy.invoke(Other[OwnedOperations].create).when(Policy.hasClass("member")),
    Policy.read(Encoded).when(Policy.hasClass("member")),
    Policy.read(Encoded.secret).deny(Policy.hasClass("member")),

    Policy.read(Encoded.tenantOnly).when(
      Policy.eq(Policy.claim("tenant"), "acme"),
    ),

    Policy.read(Encoded.rowScoped).when(
      Policy.eq(Encoded.label, Policy.claim("tenant")),
    ),
    Policy.invoke(Encoded[OwnedOperations].create).when(Policy.hasClass("member")),
    Policy.invoke(Encoded[OwnedOperations].createRenamed).when(Policy.hasClass("member")),
    Policy.invoke(Encoded[OwnedOperations].opaqueOutcome).when(Policy.hasClass("member")),
  ],
}));

export const operationCatalog = Catalog("local-native-operations", {
  schema: OperationSchema,
  policy,
});

export const operationCatalogDeployment = Object.freeze({
  root: operationCatalog,
  deployments: OPERATION_DATABASES.map((database) => ({ database })),
});
