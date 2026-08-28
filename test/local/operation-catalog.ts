/** Deployed owned-operation catalog used by the real local Worker stack. */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Db from "ramose/db";
import { Catalog } from "../../packages/ramose/src/Catalog.ts";
import {
  CatalogId,
  DatabaseId,
  DigestHex,
  allow,
  assembleCatalogDefinitions,
  assembleDeployedCatalogs,
  compileReadAuthorizationResult,
  eq,
  invoke,
  me,
  read,
  subject,
} from "../../packages/ramose/src/internal/authorization/index.ts";

export const OP_DATABASE = DatabaseId.make("operations");
export const OP_CATALOG = CatalogId.make("operation-test");
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
      changeIdentityMap: Operation({
        input: Schema.Struct({ authId: Schema.String }),
        output: Schema.Struct({}),
        run(op, input) {
          op.update(OperationUser, op.self.eid, { authId: input.authId });
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
  {
    catalog: Db.string({ optional: true }),
    instants: Db.Field.many(Db.timestamp()),
  },
  {
    bind: (definition) => definition.key === "mutable"
      ? { values: {} }
      : {
          values: {
            catalog: definition.key,
            instants: [new Date(0), new Date(1_000)],
          },
        },
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
  { value: Db.Field.unique(Db.string(), "upsert") },
);

export const OperationCreatedOther = Db.Entity(
  "operation-created-other",
  {
    title: Db.string({
      default: Db.creationDefault(
        { value: "other default" },
        (inputs) => inputs.value,
      ),
    }),
  },
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
    title: Db.string({
      default: Db.creationDefault(
        { value: "created by default" },
        (inputs) => inputs.value,
      ),
    }),
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
      rawTempid: Operation({
        self: false,
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run(op) {
          const row = op.tempid("raw-operation-row");
          op.set(OperationCreated, row, OperationCreated.title, "raw tempid");
          return {};
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
      createThenUpdateByLookup: Operation({
        self: false,
        writes: [OperationComponent],
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run(op) {
          op.put(OperationComponent, { value: "lookup-before" });
          op.update(
            OperationComponent,
            [OperationComponent.value, "lookup-before"],
            { value: "lookup-after" },
          );
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

const rename = OperationIssue[Db.OwnedOperations].rename;
const changeType = OperationIssue[Db.OwnedOperations].changeType;
const clearTitle = OperationIssue[Db.OwnedOperations].clearTitle;
const changeIdentity = OperationUser[Db.OwnedOperations].changeIdentity;
const changeIdentityMap = OperationUser[Db.OwnedOperations].changeIdentityMap;
const create = OperationCreated[Db.OwnedOperations].create;
const rawTempid = OperationCreated[Db.OwnedOperations].rawTempid;
const forgeFixed = OperationCreated[Db.OwnedOperations].forgeFixed;
const inspectBound = OperationBound[Db.OwnedOperations].inspect;
const destroyBound = OperationBound[Db.OwnedOperations].destroy;
const createBoth = OperationCreated[Db.OwnedOperations].createBoth;
const createWithComponent = OperationCreated[Db.OwnedOperations].createWithComponent;
const createThenUpdateByLookup = OperationCreated[Db.OwnedOperations].createThenUpdateByLookup;
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
      invoke(changeIdentityMap).when(allow),
      invoke(create).when(allow),
      invoke(rawTempid).when(allow),
      invoke(forgeFixed).when(allow),
      invoke(inspectBound).when(allow),
      invoke(destroyBound).when(allow),
      invoke(createBoth).when(allow),
      invoke(createWithComponent).when(allow),
      invoke(createThenUpdateByLookup).when(allow),
      invoke(mutateCatalog).when(allow),
      invoke(seedMutableCatalog).when(allow),
      invoke(seedUndeclaredCatalog).when(allow),
    ],
  }),
);

export const operationCatalogs = await Effect.runPromise(
  Effect.gen(function* () {
    const definitions = yield* assembleCatalogDefinitions({
      root: Catalog("operation-test", {
        schema: OperationSchema,
        policy,
      }),
      artifactHash: artifact,
    });
    const definition = yield* Effect.fromResult(definitions.require(OP_CATALOG));
    return yield* assembleDeployedCatalogs({
      units: [{ database: OP_DATABASE, definition }],
    });
  }),
);

const idOf = (localName: string) =>
  [...Result.getOrThrow(operationCatalogs.requireDatabase(OP_DATABASE)).operations
    .values()]
    .find((definition) => definition.localName === localName)!.id;
export const RENAME_OPERATION_ID = idOf("rename");
export const CHANGE_TYPE_OPERATION_ID = idOf("changeType");
export const CLEAR_TITLE_OPERATION_ID = idOf("clearTitle");
export const CHANGE_IDENTITY_OPERATION_ID = idOf("changeIdentity");
export const CHANGE_IDENTITY_MAP_OPERATION_ID = idOf("changeIdentityMap");
export const UNGRANTED_OPERATION_ID = idOf("ungrantedRename");
export const CREATE_OPERATION_ID = idOf("create");
export const RAW_TEMPID_OPERATION_ID = idOf("rawTempid");
export const FORGE_FIXED_OPERATION_ID = idOf("forgeFixed");
export const INSPECT_BOUND_OPERATION_ID = idOf("inspect");
export const DESTROY_BOUND_OPERATION_ID = idOf("destroy");
export const CREATE_BOTH_OPERATION_ID = idOf("createBoth");
export const CREATE_WITH_COMPONENT_OPERATION_ID = idOf("createWithComponent");
export const CREATE_THEN_UPDATE_BY_LOOKUP_OPERATION_ID = idOf("createThenUpdateByLookup");
export const MUTATE_CATALOG_OPERATION_ID = idOf("mutateCatalog");
export const SEED_MUTABLE_CATALOG_OPERATION_ID = idOf("seedMutableCatalog");
export const SEED_UNDECLARED_CATALOG_OPERATION_ID = idOf("seedUndeclaredCatalog");
