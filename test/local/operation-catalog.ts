/** Runnable deployed catalog shared by the local Worker bundle and tests. */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as EffectSchema from "effect/Schema";
import { Catalog } from "../../packages/ramose/src/Catalog.ts";
import {
  Entity,
  EntityId as OperationEntityId,
  OwnedOperations,
  Schema,
  string,
} from "../../packages/ramose/src/db/internal.ts";
import {
  CatalogId,
  DatabaseId,
  DigestHex,
  any,
  assembleCatalogDefinitions,
  compileReadAuthorization,
  deployCatalogDefinitions,
  hasClass,
  invoke,
  read,
} from "../../packages/ramose/src/internal/authorization/index.ts";

export const OPERATION_DATABASES = Object.freeze([
  "operations-static",
  "operations-targeted",
  "operations-expiry",
  "operations-response-expiry",
  "operations-denials",
]);

export const Other = Entity("nativeOther", { name: string() }, {
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
    crash: Operation({
      self: false,
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run() {
        throw new Error("postgres://secret@internal/operation");
      },
    }),
  }),
});

export const OperationSchema = Schema({ nativeItem: Item, nativeOther: Other });

const policy = await Effect.runPromise(compileReadAuthorization({
  schema: OperationSchema,
  classes: ["member", "reader", "operator"],
  rules: [
    read(Item).when(any(hasClass("member"), hasClass("reader"))),
    read(Other).when(hasClass("member")),
    invoke(Item[OwnedOperations].create).when(hasClass("member")),
    invoke(Item[OwnedOperations].rename).when(any(hasClass("member"), hasClass("operator"))),
    invoke(Item[OwnedOperations].crash).when(hasClass("member")),
    invoke(Other[OwnedOperations].create).when(hasClass("member")),
  ],
}));

const definitions = await Effect.runPromise(assembleCatalogDefinitions({
  root: Catalog("local-native-operations", { schema: OperationSchema, policy }),
  artifactHash: DigestHex.make("7".repeat(64)),
}));

export const operationCatalogs = Result.getOrThrow(deployCatalogDefinitions(
  definitions,
  OPERATION_DATABASES.map((database) => ({
    database: DatabaseId.make(database),
    catalogKey: CatalogId.make("local-native-operations"),
  })),
));

const installed = Result.getOrThrow(
  definitions.require(CatalogId.make("local-native-operations")),
);

export const operationProof = Object.freeze({
  catalog: installed.catalogKey,
  unitHash: installed.unitHash,
});
