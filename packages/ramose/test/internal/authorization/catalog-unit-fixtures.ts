/**
 * Shared catalog-unit builders for seal / publish tests.
 * Mirrors the helpers in catalog-unit.test.ts without duplicating the
 * assertion suite.
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
  installAuthorization,
  sealInstalledCatalogUnit,
  type CatalogBindingInput,
  type CatalogDescriptor,
  type FieldRefTarget,
  type InstalledAuthorizationIRV1,
  type InstalledCatalogUnitV1,
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
    readonly optional?: boolean;
  } = {},
): CatalogDescriptor["fields"][number] => ({
  id: field(owner, localName),
  valueType: "string",
  cardinality: options.cardinality ?? "one",
  ...(options.unique === undefined ? {} : { unique: options.unique }),
  index: options.index ?? options.unique !== undefined,
  optional: options.optional ?? false,
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

export const bindingInput = (
  descriptor: CatalogDescriptor = catalogDescriptor(),
  template: PolicyTemplateIR = templateOf(),
): CatalogBindingInput => ({
  target: {
    database: descriptor.database,
    catalog: descriptor.id,
    catalogVersion: descriptor.version,
    schemaFingerprint: descriptor.fingerprint,
  },
  descriptor,
  template,
});

export const install = (
  descriptor: CatalogDescriptor = catalogDescriptor(),
  template: PolicyTemplateIR = templateOf(),
) => Effect.runPromise(installAuthorization(bindingInput(descriptor, template)));

export const seal = (descriptor: CatalogDescriptor, policy: InstalledAuthorizationIRV1) =>
  Effect.runPromise(sealInstalledCatalogUnit(descriptor, policy));

export const sealUnit = async (
  descriptor: CatalogDescriptor = catalogDescriptor(),
  template: PolicyTemplateIR = templateOf(),
): Promise<InstalledCatalogUnitV1> => seal(descriptor, await install(descriptor, template));

/** Second-generation catalog: issue also composes `named`. */
export const evolvedCatalogDescriptor = async (): Promise<CatalogDescriptor> => {
  const named = trait("named");
  const tables: Omit<CatalogDescriptor, "fingerprint"> = {
    ...catalogSchemaTables(),
    version: CatalogVersion.make("2"),
    traits: [{ id: trait("taggable"), traits: [] }, { id: named, traits: [] }],
    entities: [
      { id: entity("user"), traits: [] },
      { id: entity("issue"), traits: [trait("taggable"), named] },
    ],
    traitComposition: [
      {
        composer: entity("issue"),
        trait: trait("taggable"),
        transitive: [trait("taggable")],
      },
      {
        composer: entity("issue"),
        trait: named,
        transitive: [named],
      },
    ],
  };
  const digest = SchemaFingerprint.make(
    await Effect.runPromise(
      hashCatalogSchemaFingerprint({
        ...tables,
        fingerprint: SchemaFingerprint.make("placeholder"),
      }),
    ),
  );
  return { ...tables, fingerprint: digest };
};
