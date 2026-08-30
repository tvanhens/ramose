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
  "operations-mcp-describe",
  "operations-mcp-query",
  "operations-mcp-mutate",
  "operations-mcp-expiry",
  "operations-mcp-budget",
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

/** Composed by `nativeEncoded` and granted to nobody: its field is unreadable. */
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

/**
 * Field types JSON cannot represent natively, so a transport that forgets the
 * engine's canonical `$inst` / `$uuid` / `$bytes` encoding is caught rather
 * than silently mangling the value.
 */
export const Encoded = Entity("nativeEncoded", {
  label: string(),
  at: timestamp(),
  blob: bytes(),
  key: uuid(),
  /** Declared on a readable entity but denied to `member` by policy. */
  secret: string(),
  /** Readable only by a principal whose `tenant` claim is `acme`. */
  tenantOnly: string(),
  /**
   * Readable only where the row's own `label` matches the caller's `tenant`
   * claim — decidable per row, never from the principal alone, so the static
   * layer must defer it to the deployed filter.
   */
  rowScoped: string(),
}, {
  traits: [SealedTrait],
  operations: (Operation) => ({
    /**
     * An `Unknown` output contract proves nothing about its interior, so
     * whatever it carries has to be withheld.
     *
     * The returned number stands in for a storage id: the Transactor refuses
     * to transport a live entity handle through an undeclared output at all
     * ("operation output changes during JSON transport"), so an id can only
     * reach an opaque contract as a plain number like this one. The exact
     * value is immaterial — the projection is contract-only and never reads
     * it; the unit tests pin the `{ principalEid: <eid> }` shape directly.
     */
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
    /**
     * Same reference-shaped output, published under a codec-renamed key. The
     * declared shape says `id`; the wire says `wire_id`.
     */
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
    Policy.invoke(Item[OwnedOperations].rename).when(Policy.any(
      Policy.hasClass("member"),
      Policy.hasClass("operator"),
    )),
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
    // Decidable from the principal alone: no row is consulted to know whether
    // this caller's `tenant` claim is `acme`.
    Policy.read(Encoded.tenantOnly).when(
      Policy.eq(Policy.claim("tenant"), "acme"),
    ),
    // Row-dependent: no label in this fixture ever equals a caller's claim,
    // so the field is hidden on every row while remaining undecidable from
    // the principal alone.
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
