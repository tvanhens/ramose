/** Deployed owned-operation catalog used by the real local Worker stack. */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Db from "ramose/db";
import {
  CatalogId,
  CatalogVersion,
  DatabaseId,
  DigestHex,
  EntityId,
  FieldId,
  SchemaFingerprint,
  TraitId,
  allow,
  assembleDeployedCatalogs,
  compileReadAuthorizationResult,
  eq,
  hashCatalogSchemaFingerprint,
  invoke,
  lowerOwnedOperations,
  me,
  read,
  subject,
  type CatalogDescriptor,
} from "../../packages/ramose/src/internal/authorization/index.ts";

export const OP_DATABASE = DatabaseId.make("operations");
export const OP_CATALOG = CatalogId.make("operation-test");
const version = CatalogVersion.make("1");
const artifact = DigestHex.make("417".padEnd(64, "0"));

export const OperationUser = Db.Entity(
  "operation-user",
  { authId: Db.Field.unique(Db.string(), "upsert") },
  {
    operations: (Operation) => ({
      changeIdentity: Operation({
        input: Schema.Struct({ authId: Schema.String }),
        output: Schema.Struct({}),
        run(op, input) {
          op.self.set(OperationUser.authId, input.authId);
          return {};
        },
      }),
    }),
  },
);

export const OperationIssue = Db.Entity(
  "operation-issue",
  {
    owner: Db.Ref(OperationUser),
    title: Db.string(),
  },
  {
    operations: (Operation) => ({
      rename: Operation({
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({ title: Schema.String }),
        run(op, input) {
          op.self.set(OperationIssue.title, input.title);
          return { title: input.title };
        },
      }),
      ungrantedRename: Operation({
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({ title: Schema.String }),
        run(op, input) {
          op.self.set(OperationIssue.title, input.title);
          return { title: input.title };
        },
      }),
      changeType: Operation({
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run(op) {
          op.self.set(":ramose/type" as never, ":operation-user" as never);
          return {};
        },
      }),
    }),
  },
);

const OperationBound = Db.Trait(
  "operation-bound",
  { catalog: Db.string() },
  {
    bind: (definition) => ({ values: { catalog: definition.key } }),
    operations: (Operation) => ({
      inspect: Operation({
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run() {
          return { ok: true };
        },
      }),
    }),
  },
);
const operationBinding = {
  key: "authoritative",
  schema: Db.Schema({}),
};

export const OperationCreated = Db.Entity(
  "operation-created",
  { title: Db.string({ default: () => "created by default" }) },
  {
    traits: [OperationBound(operationBinding)],
    operations: (Operation) => ({
      create: Operation({
        self: false,
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run(op) {
          op.create({});
          return { ok: true };
        },
      }),
      forgeFixed: Operation({
        self: false,
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run(op) {
          const created = op.create({});
          created.set(OperationBound.catalog as never, "authoritative" as never);
          return {};
        },
      }),
    }),
  },
);

export const OperationSchema = Db.Schema({
  "operation-user": OperationUser,
  "operation-issue": OperationIssue,
  "operation-created": OperationCreated,
});

const entity = (name: string) => EntityId.make({ catalog: OP_CATALOG, name });
const owner = (name: string) => ({ kind: "entity" as const, name });
const field = (name: string, localName: string) =>
  FieldId.make({ catalog: OP_CATALOG, owner: owner(name), localName });
const operationBoundId = TraitId.make({
  catalog: OP_CATALOG,
  name: OperationBound.ns,
});
const createdTitleId = FieldId.make({
  catalog: OP_CATALOG,
  owner: owner(OperationCreated.ns),
  localName: "title",
});
const boundCatalogId = FieldId.make({
  catalog: OP_CATALOG,
  owner: { kind: "trait", name: OperationBound.ns },
  localName: "catalog",
});

const lowered = await Effect.runPromise(
  lowerOwnedOperations(OP_CATALOG, OperationSchema, artifact),
);

const descriptorTables: Omit<CatalogDescriptor, "fingerprint"> = {
  id: OP_CATALOG,
  database: OP_DATABASE,
  version,
  entities: [
    { id: entity(OperationIssue.ns), traits: [] },
    {
      id: entity(OperationCreated.ns),
      traits: [operationBoundId],
    },
    { id: entity(OperationUser.ns), traits: [] },
  ],
  traits: [
    {
      id: operationBoundId,
      traits: [],
    },
  ],
  fields: [
    {
      id: createdTitleId,
      valueType: "string",
      cardinality: "one",
      index: false,
      optional: false,
      owned: false,
    },
    {
      id: boundCatalogId,
      valueType: "string",
      cardinality: "one",
      index: false,
      optional: false,
      owned: false,
    },
    {
      id: field(OperationIssue.ns, "owner"),
      valueType: "ref",
      refTarget: { _tag: "entity", entity: entity(OperationUser.ns) },
      cardinality: "one",
      index: false,
      optional: false,
      owned: false,
    },
    {
      id: field(OperationIssue.ns, "title"),
      valueType: "string",
      cardinality: "one",
      index: false,
      optional: false,
      owned: false,
    },
    {
      id: field(OperationUser.ns, "authId"),
      valueType: "string",
      cardinality: "one",
      unique: "upsert",
      index: true,
      optional: false,
      owned: false,
    },
  ],
  operations: lowered.descriptors,
  traitComposition: [
    {
      composer: entity(OperationCreated.ns),
      trait: operationBoundId,
      transitive: [operationBoundId],
    },
  ],
};

const descriptor: CatalogDescriptor = {
  ...descriptorTables,
  fingerprint: SchemaFingerprint.make(
    await Effect.runPromise(hashCatalogSchemaFingerprint(descriptorTables)),
  ),
};

const rename = OperationIssue[Db.OwnedOperations].rename;
const changeType = OperationIssue[Db.OwnedOperations].changeType;
const changeIdentity = OperationUser[Db.OwnedOperations].changeIdentity;
const create = OperationCreated[Db.OwnedOperations].create;
const forgeFixed = OperationCreated[Db.OwnedOperations].forgeFixed;
const inspectBound = OperationBound[Db.OwnedOperations].inspect;
const policy = Result.getOrThrow(
  compileReadAuthorizationResult({
    schema: OperationSchema,
    classes: ["member"],
    principal: { entity: OperationUser.authId },
    rules: [
      read(OperationUser).when(eq(OperationUser.authId, subject)),
      read(OperationIssue).when(eq(OperationIssue.owner, me)),
      read(OperationCreated).when(allow),
      invoke(rename).when(allow),
      invoke(changeType).when(allow),
      invoke(changeIdentity).when(allow),
      invoke(create).when(allow),
      invoke(forgeFixed).when(allow),
      invoke(inspectBound).when(allow),
    ],
  }),
);

export const operationCatalogs = await Effect.runPromise(
  assembleDeployedCatalogs({
    root: OP_CATALOG,
    units: [
      {
        catalog: OP_CATALOG,
        database: OP_DATABASE,
        version,
        descriptor,
        policy,
        operations: lowered,
      },
    ],
  }),
);

const idOf = (localName: string) =>
  lowered.definitions.find((definition) => definition.localName === localName)!.id;
export const RENAME_OPERATION_ID = idOf("rename");
export const CHANGE_TYPE_OPERATION_ID = idOf("changeType");
export const CHANGE_IDENTITY_OPERATION_ID = idOf("changeIdentity");
export const UNGRANTED_OPERATION_ID = idOf("ungrantedRename");
export const CREATE_OPERATION_ID = idOf("create");
export const FORGE_FIXED_OPERATION_ID = idOf("forgeFixed");
export const INSPECT_BOUND_OPERATION_ID = idOf("inspect");
