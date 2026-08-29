/** Public operation definitions shared by the local Worker bundle and tests. */

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
  stored,
  string,
} from "ramose/db";

export const OPERATION_DATABASES = Object.freeze([
  "operations-static",
  "operations-targeted",
  "operations-expiry",
  "operations-response-expiry",
  "operations-denials",
  "operations-trusted",
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
    rename: Operation({
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({ id: OperationEntityId, title: EffectSchema.String }),
      run(op, input) {
        op.self.set(Item.title, input.title);
        return { id: op.self, title: input.title };
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

export const OperationSchema = Schema({ nativeItem: Item, nativeOther: Other });

const policy = await Effect.runPromise(Policy.compileReadAuthorization({
  schema: OperationSchema,
  classes: ["member", "reader", "operator"],
  rules: [
    Policy.read(Item).when(Policy.any(Policy.hasClass("member"), Policy.hasClass("reader"))),
    Policy.read(Other).when(Policy.hasClass("reader")),
    Policy.invoke(Item[OwnedOperations].create).when(Policy.hasClass("member")),
    Policy.invoke(Item[OwnedOperations].rename).when(Policy.any(
      Policy.hasClass("member"),
      Policy.hasClass("operator"),
    )),
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
