/**
 * Shared catalog-unit builders for deployed-registry tests.
 * Copied from catalog-unit.test.ts patterns — not imported from that file.
 */

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

export const withFingerprint = async (
  tables: Omit<CatalogDescriptor, "fingerprint">,
): Promise<CatalogDescriptor> => {
  const fingerprint = SchemaFingerprint.make(
    await Effect.runPromise(
      hashCatalogSchemaFingerprint({
        ...tables,
        fingerprint: SchemaFingerprint.make("placeholder"),
      }),
    ),
  );
  return { ...tables, fingerprint };
};

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

/** Principal-only catalog: one entity and its unique subject field. */
export const principalOnlyTables = (
  id: CatalogId,
  databaseId: DatabaseId,
  entityName: string,
): Omit<CatalogDescriptor, "fingerprint"> => ({
  id,
  database: databaseId,
  version,
  entities: [{ id: EntityId.make({ catalog: id, name: entityName }), traits: [] }],
  traits: [],
  fields: [
    {
      id: FieldId.make({
        catalog: id,
        owner: { kind: "entity", name: entityName },
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

export const principalOnlyTemplate = (entityName: string): PolicyTemplateIR => ({
  _tag: "PolicyTemplateIR",
  version: POLICY_TEMPLATE_IR_VERSION,
  languageVersion: "v1",
  classes: ["member"],
  claims: [],
  principal: {
    subjectClaim: "sub",
    entity: RelativeFieldId.make({ owner: { kind: "entity", name: entityName }, localName: "authId" }),
  },
  rules: [
    {
      id: RuleId.make(digestHex(0x21)),
      focus: { _tag: "entity", entity: { _tag: "RelativeEntityId", name: entityName } },
      expr: { _tag: "hasClass", class: "member" },
      usesResource: false,
      usesMe: false,
      usesSubject: false,
      traversalDepth: 0,
    },
  ],
  decisions: {
    entities: [
      {
        target: { _tag: "RelativeEntityId", name: entityName },
        decision: { allow: [RuleId.make(digestHex(0x21))], deny: [] },
      },
    ],
    traits: [],
    fields: [],
  },
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

export const childCatalog = CatalogId.make("lib");
/** Non-colliding child entity so `lib` can share `todos` with `app`. */
export const childEntityName = "account";

export const childCatalogTables = (): Omit<CatalogDescriptor, "fingerprint"> =>
  principalOnlyTables(childCatalog, database, childEntityName);

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

export const childTemplate = (): PolicyTemplateIR => principalOnlyTemplate(childEntityName);
