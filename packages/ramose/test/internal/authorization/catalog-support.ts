import * as Effect from "effect/Effect";
import {
  CatalogId,
  CatalogVersion,
  DatabaseId,
  EntityId,
  FieldId,
  OperationId,
  POLICY_TEMPLATE_IR_VERSION,
  RelativeFieldId,
  RuleId,
  SchemaFingerprint,
  TraitId,
  hashCatalogSchemaFingerprint,
  type CatalogDescriptor,
  type FieldRefTarget,
  type OwnerRef,
  type PolicyTemplateIR,
} from "../../../src/internal/authorization/index.ts";
import { digestHex } from "./fixtures.ts";
import { operationMetadata } from "./operation-support.ts";

export const catalog = CatalogId.make("app");
export const database = DatabaseId.make("todos");
export const version = CatalogVersion.make("1");

export const issueOwner = { kind: "entity" as const, name: "issue" };
export const userOwner = { kind: "entity" as const, name: "user" };
export const taggableOwner = { kind: "trait" as const, name: "taggable" };

export const entity = (name: string) => EntityId.make({ catalog, name });
export const trait = (name: string) => TraitId.make({ catalog, name });
export const field = (owner: OwnerRef, localName: string) => FieldId.make({ catalog, owner, localName });
export const relativeField = (owner: OwnerRef, localName: string) =>
  RelativeFieldId.make({ owner, localName });
export const operation = (owner: OwnerRef, localName: string, operationTarget: "required" | "none") =>
  OperationId.make({ catalog, owner, localName, target: operationTarget });

export const scalarField = (
  owner: OwnerRef,
  localName: string,
  options: {
    readonly unique?: "upsert" | "strict";
    readonly cardinality?: "one" | "many";
    readonly index?: boolean;
  } = {},
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "string",
  cardinality: options.cardinality ?? "one",
  ...(options.unique === undefined ? {} : { unique: options.unique }),
  index: options.index ?? options.unique !== undefined,
  optional: false,
  owned: false,
});

export const refField = (
  owner: OwnerRef,
  localName: string,
  refTarget: FieldRefTarget,
  cardinality: "one" | "many" = "one",
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "ref",
  refTarget,
  cardinality,
  index: false,
  optional: false,
  owned: false,
});

export const catalogSchemaTables = (): Omit<CatalogDescriptor, "fingerprint"> => ({
  id: catalog,
  database,
  version,
  entities: [
    { id: entity("user"), traits: [] },
    { id: entity("issue"), traits: [trait("taggable")] },
  ],
  traits: [{ id: trait("taggable"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    refField(issueOwner, "owner", { _tag: "entity", entity: entity("user") }),
    scalarField(issueOwner, "title"),
    refField(taggableOwner, "tags", { _tag: "entity", entity: entity("user") }, "many"),
  ],
  operations: [
    {
      id: operation(issueOwner, "rename", "required"),
      ...operationMetadata(),
      input: {
        _tag: "struct",
        fields: [{ key: "title", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
      },
    },
  ],
  traitComposition: [
    {
      composer: entity("issue"),
      trait: trait("taggable"),
      transitive: [trait("taggable")],
    },
  ],
});

const fingerprint = SchemaFingerprint.make(
  await Effect.runPromise(
    hashCatalogSchemaFingerprint({
      ...catalogSchemaTables(),
      fingerprint: SchemaFingerprint.make("placeholder"),
    }),
  ),
);

export const catalogDescriptor = (): CatalogDescriptor => ({
  ...catalogSchemaTables(),
  fingerprint,
});

export const templateOf = (extras: Partial<PolicyTemplateIR> = {}): PolicyTemplateIR => ({
  _tag: "PolicyTemplateIR",
  version: POLICY_TEMPLATE_IR_VERSION,
  languageVersion: "v1",
  classes: ["member"],
  claims: [{ key: "org", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
  principal: { subjectClaim: "sub", entity: relativeField(userOwner, "authId") },
  rules: [
    {
      id: RuleId.make(digestHex(0x11)),
      focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } },
      expr: {
        _tag: "eq",
        left: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: relativeField(issueOwner, "owner") }],
        },
        right: { _tag: "me" },
      },
      usesResource: true,
      usesMe: true,
      usesSubject: false,
      traversalDepth: 1,
    },
  ],
  decisions: {
    operations: [],
    entities: [
      {
        target: { _tag: "RelativeEntityId", name: "issue" },
        decision: { allow: [RuleId.make(digestHex(0x11))], deny: [] },
      },
    ],
    traits: [],
    fields: [],
  },
  ...extras,
});

const childCatalog = CatalogId.make("lib");

export const childCatalogTables = (): Omit<CatalogDescriptor, "fingerprint"> => ({
  id: childCatalog,
  database,
  version,
  entities: [{ id: EntityId.make({ catalog: childCatalog, name: "user" }), traits: [] }],
  traits: [],
  fields: [
    {
      id: FieldId.make({
        catalog: childCatalog,
        owner: { kind: "entity", name: "user" },
        localName: "authId",
      }),
      valueType: "string",
      cardinality: "one",
      unique: "upsert",
      index: true,
      optional: false,
      owned: false,
    },
  ],
  operations: [],
  traitComposition: [],
});

const childFingerprint = SchemaFingerprint.make(
  await Effect.runPromise(
    hashCatalogSchemaFingerprint({
      ...childCatalogTables(),
      fingerprint: SchemaFingerprint.make("placeholder"),
    }),
  ),
);

export const childCatalogDescriptor = (): CatalogDescriptor => ({
  ...childCatalogTables(),
  fingerprint: childFingerprint,
});

export const otherCatalog = CatalogId.make("crm");
export const otherDatabase = DatabaseId.make("crm");

export const otherCatalogTables = (): Omit<CatalogDescriptor, "fingerprint"> => ({
  id: otherCatalog,
  database: otherDatabase,
  version,
  entities: [{ id: EntityId.make({ catalog: otherCatalog, name: "user" }), traits: [] }],
  traits: [],
  fields: [
    {
      id: FieldId.make({
        catalog: otherCatalog,
        owner: { kind: "entity", name: "user" },
        localName: "authId",
      }),
      valueType: "string",
      cardinality: "one",
      unique: "upsert",
      index: true,
      optional: false,
      owned: false,
    },
  ],
  operations: [],
  traitComposition: [],
});

const otherFingerprint = SchemaFingerprint.make(
  await Effect.runPromise(
    hashCatalogSchemaFingerprint({
      ...otherCatalogTables(),
      fingerprint: SchemaFingerprint.make("placeholder"),
    }),
  ),
);

export const otherCatalogDescriptor = (): CatalogDescriptor => ({
  ...otherCatalogTables(),
  fingerprint: otherFingerprint,
});

export const childTemplate = (): PolicyTemplateIR => ({
  _tag: "PolicyTemplateIR",
  version: POLICY_TEMPLATE_IR_VERSION,
  languageVersion: "v1",
  classes: ["member"],
  claims: [],
  principal: {
    subjectClaim: "sub",
    entity: RelativeFieldId.make({ owner: { kind: "entity", name: "user" }, localName: "authId" }),
  },
  rules: [
    {
      id: RuleId.make(digestHex(0x21)),
      focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: "user" } },
      expr: { _tag: "hasClass", class: "member" },
      usesResource: false,
      usesMe: false,
      usesSubject: false,
      traversalDepth: 0,
    },
  ],
  decisions: {
    operations: [],
    entities: [
      {
        target: { _tag: "RelativeEntityId", name: "user" },
        decision: { allow: [RuleId.make(digestHex(0x21))], deny: [] },
      },
    ],
    traits: [],
    fields: [],
  },
});
