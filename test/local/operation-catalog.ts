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
    title: Db.string({ optional: true }),
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
      clearTitle: Operation({
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run(op) {
          op.remove(OperationIssue, op.self.eid, OperationIssue.title);
          return {};
        },
      }),
    }),
  },
);

const OperationBound = Db.Trait(
  "operation-bound",
  { catalog: Db.string({ optional: true }) },
  {
    bind: (definition) => definition.key === "mutable"
      ? { values: {} }
      : { values: { catalog: definition.key } },
    operations: (Operation) => ({
      inspect: Operation({
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run() {
          return { ok: true };
        },
      }),
      destroy: Operation({
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run(op) {
          op.self.delete();
          return {};
        },
      }),
    }),
  },
);
const operationBinding = {
  key: "authoritative",
  schema: Db.Schema({}),
};
const otherOperationBinding = {
  key: "other-authoritative",
  schema: Db.Schema({}),
};
const mutableOperationBinding = {
  key: "mutable",
  schema: Db.Schema({}),
};

export const OperationComponent = Db.Entity(
  "operation-component",
  { value: Db.string() },
);

export const OperationCreatedOther = Db.Entity(
  "operation-created-other",
  { title: Db.string({ default: () => "other default" }) },
  { traits: [OperationBound(otherOperationBinding)] },
);

export const OperationMutable = Db.Entity(
  "operation-mutable",
  { title: Db.string() },
  { traits: [OperationBound(mutableOperationBinding)] },
);

export const OperationUndeclared = Db.Entity(
  "operation-undeclared",
  { title: Db.string() },
  { traits: [OperationBound(mutableOperationBinding)] },
);

export const OperationCreated = Db.Entity(
  "operation-created",
  {
    title: Db.string({ default: () => "created by default" }),
    child: Db.Field.owned(Db.Ref(OperationComponent), { optional: true }),
  },
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
      createBoth: Operation({
        self: false,
        writes: [OperationCreatedOther],
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run(op) {
          op.create({});
          op.put(OperationCreatedOther, {});
          return { ok: true };
        },
      }),
      createWithComponent: Operation({
        self: false,
        writes: [OperationComponent],
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run(op) {
          const child = op.put(OperationComponent, { value: "child" });
          const created = op.create({});
          created.set(OperationCreated.child, child);
          return { ok: true };
        },
      }),
      mutateCatalog: Operation({
        self: false,
        writes: [OperationMutable],
        input: Schema.Struct({ id: Schema.Finite, catalog: Schema.String }),
        output: Schema.Struct({}),
        run(op, input) {
          op.set(
            OperationMutable,
            input.id,
            OperationBound.catalog as never,
            input.catalog as never,
          );
          return {};
        },
      }),
      seedMutableCatalog: Operation({
        self: false,
        writes: [OperationMutable],
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run(op) {
          const row = op.put(OperationMutable, { title: "Mutable" });
          row.set(OperationBound.catalog as never, "initial" as never);
          return {};
        },
      }),
      seedUndeclaredCatalog: Operation({
        self: false,
        writes: [OperationUndeclared],
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run(op) {
          const row = op.put(OperationUndeclared, { title: "Undeclared" });
          row.set(OperationBound.catalog as never, "initial" as never);
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
  "operation-created-other": OperationCreatedOther,
  "operation-component": OperationComponent,
  "operation-mutable": OperationMutable,
  "operation-undeclared": OperationUndeclared,
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
    { id: entity(OperationComponent.ns), traits: [] },
    { id: entity(OperationMutable.ns), traits: [operationBoundId] },
    { id: entity(OperationUndeclared.ns), traits: [operationBoundId] },
    {
      id: entity(OperationCreated.ns),
      traits: [operationBoundId],
    },
    {
      id: entity(OperationCreatedOther.ns),
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
      id: field(OperationCreated.ns, "child"),
      valueType: "ref",
      refTarget: { _tag: "entity", entity: entity(OperationComponent.ns) },
      cardinality: "one",
      index: false,
      optional: true,
      owned: true,
    },
    {
      id: field(OperationComponent.ns, "value"),
      valueType: "string",
      cardinality: "one",
      index: false,
      optional: false,
      owned: false,
    },
    {
      id: field(OperationMutable.ns, "title"),
      valueType: "string",
      cardinality: "one",
      index: false,
      optional: false,
      owned: false,
    },
    {
      id: field(OperationUndeclared.ns, "title"),
      valueType: "string",
      cardinality: "one",
      index: false,
      optional: false,
      owned: false,
    },
    {
      id: field(OperationCreatedOther.ns, "title"),
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
      optional: true,
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
      optional: true,
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
    {
      composer: entity(OperationCreatedOther.ns),
      trait: operationBoundId,
      transitive: [operationBoundId],
    },
    {
      composer: entity(OperationMutable.ns),
      trait: operationBoundId,
      transitive: [operationBoundId],
    },
    {
      composer: entity(OperationUndeclared.ns),
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
const clearTitle = OperationIssue[Db.OwnedOperations].clearTitle;
const changeIdentity = OperationUser[Db.OwnedOperations].changeIdentity;
const create = OperationCreated[Db.OwnedOperations].create;
const forgeFixed = OperationCreated[Db.OwnedOperations].forgeFixed;
const inspectBound = OperationBound[Db.OwnedOperations].inspect;
const destroyBound = OperationBound[Db.OwnedOperations].destroy;
const createBoth = OperationCreated[Db.OwnedOperations].createBoth;
const createWithComponent = OperationCreated[Db.OwnedOperations].createWithComponent;
const mutateCatalog = OperationCreated[Db.OwnedOperations].mutateCatalog;
const seedMutableCatalog = OperationCreated[Db.OwnedOperations].seedMutableCatalog;
const seedUndeclaredCatalog = OperationCreated[Db.OwnedOperations].seedUndeclaredCatalog;
const policy = Result.getOrThrow(
  compileReadAuthorizationResult({
    schema: OperationSchema,
    classes: ["member"],
    principal: { entity: OperationUser.authId },
    rules: [
      read(OperationUser).when(eq(OperationUser.authId, subject)),
      read(OperationIssue).when(eq(OperationIssue.owner, me)),
      read(OperationCreated).when(allow),
      read(OperationCreatedOther).when(allow),
      read(OperationComponent).when(allow),
      read(OperationMutable).when(allow),
      read(OperationUndeclared).when(allow),
      invoke(rename).when(allow),
      invoke(changeType).when(allow),
      invoke(clearTitle).when(allow),
      invoke(changeIdentity).when(allow),
      invoke(create).when(allow),
      invoke(forgeFixed).when(allow),
      invoke(inspectBound).when(allow),
      invoke(destroyBound).when(allow),
      invoke(createBoth).when(allow),
      invoke(createWithComponent).when(allow),
      invoke(mutateCatalog).when(allow),
      invoke(seedMutableCatalog).when(allow),
      invoke(seedUndeclaredCatalog).when(allow),
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
export const CLEAR_TITLE_OPERATION_ID = idOf("clearTitle");
export const CHANGE_IDENTITY_OPERATION_ID = idOf("changeIdentity");
export const UNGRANTED_OPERATION_ID = idOf("ungrantedRename");
export const CREATE_OPERATION_ID = idOf("create");
export const FORGE_FIXED_OPERATION_ID = idOf("forgeFixed");
export const INSPECT_BOUND_OPERATION_ID = idOf("inspect");
export const DESTROY_BOUND_OPERATION_ID = idOf("destroy");
export const CREATE_BOTH_OPERATION_ID = idOf("createBoth");
export const CREATE_WITH_COMPONENT_OPERATION_ID = idOf("createWithComponent");
export const MUTATE_CATALOG_OPERATION_ID = idOf("mutateCatalog");
export const SEED_MUTABLE_CATALOG_OPERATION_ID = idOf("seedMutableCatalog");
export const SEED_UNDECLARED_CATALOG_OPERATION_ID = idOf("seedUndeclaredCatalog");
