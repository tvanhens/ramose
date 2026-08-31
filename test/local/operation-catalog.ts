import * as EffectSchema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  Entity,
  EntityId as OperationEntityId,
  Field,
  OperationRejected,
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
  "operations-allocation-renamed",
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
      allocates: { row: ["id"] },
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

export const OperationSchema = Schema("local-native-operations", {
  nativeItem: Item,
  nativeOther: Other,
  nativeEncoded: Encoded,
});

const tenantClaim = {
  key: "tenant",
  optional: true,
  shape: { _tag: "scalar" as const, valueType: "string" as const },
} as const;

OperationSchema.applyPolicy(
  {
    roles: ["member", "reader", "operator"] as const,
    claims: [tenantClaim] as const,
  },
  ({ policy, session }) => {
    const member = session.roles.member;
    const reader = session.roles.reader;
    const operator = session.roles.operator;

    policy.nativeItem.read.where(member);
    policy.nativeItem.read.where(reader);
    policy.nativeOther.read.where(reader);
    policy.nativeItem.operations.create.where(member);
    policy.nativeItem.operations.createAllocating.where(member);
    policy.nativeItem.operations.misallocating.where(member);
    policy.nativeOther.operations.createAllocating.where(member);
    policy.nativeOther.operations.rename.where(member);
    policy.nativeItem.operations.rename.where(member);
    policy.nativeItem.operations.rename.where(operator);
    policy.nativeItem.operations.retitleByRef.where(member);
    policy.nativeItem.operations.retitleByRenamedRef.where(member);
    policy.nativeItem.operations.deleteAndEchoTitle.where(member);
    policy.nativeItem.operations.deleteHiddenOther.where(member);
    policy.nativeItem.operations.crash.where(member);
    policy.nativeItem.operations.inputCrash.where(member);
    policy.nativeItem.operations.fieldCodec.where(member);
    policy.nativeItem.operations.refFieldCodec.where(member);
    policy.nativeItem.operations.echoTransportTagInput.where(member);
    policy.nativeItem.operations.returnTransportTag.where(member);
    policy.nativeItem.operations.echoExactWireValues.where(member);
    policy.nativeItem.operations.reject.where(member);
    policy.nativeOther.operations.create.where(member);

    policy.nativeEncoded.read.where(member);
    policy.nativeEncoded.fields.secret.read.denyWhere(member);
    policy.nativeEncoded.fields.tenantOnly.read.where(
      session.claims.tenant.eq("acme"),
    );
    policy.nativeEncoded.fields.rowScoped.read.where((row) =>
      row.label.eq(session.claims.tenant)
    );
    policy.nativeEncoded.operations.create.where(member);
    policy.nativeEncoded.operations.createRenamed.where(member);
    policy.nativeEncoded.operations.opaqueOutcome.where(member);
  },
);

export const operationCatalogDeployment = Object.freeze({
  root: OperationSchema,
  deployments: OPERATION_DATABASES.map((database) => ({ database })),
});
