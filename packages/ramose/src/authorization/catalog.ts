/** Build an in-memory authoritative catalog descriptor from a Schema. */

import { reachableTraits } from "../db/compose.ts";
import type { AnyEntity } from "../db/Entity.ts";
import type { AnyField } from "../db/Field.ts";
import type { AnySchema } from "../db/Schema.ts";
import { refTargetOf } from "../db/valueTypes.ts";
import { canonicalJson } from "../internal/authorization/canonical.ts";
import type {
  CatalogDescriptor,
  CatalogEntityDescriptor,
  CatalogFieldDescriptor,
  CatalogOperationDescriptor,
  CatalogTraitDescriptor,
} from "../internal/authorization/descriptor.ts";
import { sha256Hex } from "../internal/authorization/hash.ts";
import type { RelativeOwnerRef } from "../internal/authorization/identity.ts";
import type { AnyPolicyOperation } from "./operation.ts";
import { ownerRefOf } from "./operation.ts";

const fieldOwner = (
  schema: AnySchema,
  field: AnyField & { readonly ident: string; readonly attrName?: string },
): RelativeOwnerRef => {
  const ident = field.ident;
  const rest = ident.startsWith(":") ? ident.slice(1) : ident;
  const slash = rest.indexOf("/");
  const ns = slash >= 0 ? rest.slice(0, slash) : rest;
  if (schema.entities[ns] !== undefined) {
    return { kind: "entity", name: ns };
  }
  return { kind: "trait", name: ns };
};

const fieldDescriptor = (
  schema: AnySchema,
  field: AnyField & { readonly ident: string; readonly attrName?: string },
  localName: string,
): CatalogFieldDescriptor => {
  const owner = fieldOwner(schema, field);
  const target = field.valueType === "ref" ? refTargetOf(field.schema)?.() : undefined;
  return {
    owner,
    localName,
    ident: field.ident,
    cardinality: field.cardinality,
    valueType: field.valueType ?? "string",
    optional: field.isOptional === true,
    unique: field.unique,
    refTarget: target?.ns,
  };
};

const fieldsOf = (
  schema: AnySchema,
  owner: { readonly fields: Record<string, AnyField & { readonly ident: string }> },
): CatalogFieldDescriptor[] =>
  Object.entries(owner.fields).map(([localName, field]) =>
    fieldDescriptor(schema, field, localName),
  );

export const catalogDescriptorFrom = (args: {
  readonly catalogId: string;
  readonly catalogVersion: string;
  readonly schema: AnySchema;
  readonly operations?: readonly AnyPolicyOperation[];
  readonly fingerprint?: string;
}): CatalogDescriptor => {
  const entities: CatalogEntityDescriptor[] = Object.values(args.schema.entities).map(
    (entity: AnyEntity) => ({
      name: entity.ns,
      fields: fieldsOf(args.schema, entity),
      traits: ((entity as { readonly traits?: readonly { readonly ns: string }[] }).traits ?? []).map(
        (trait) => trait.ns,
      ),
    }),
  );
  const reachable = reachableTraits(Object.values(args.schema.entities));
  const traits: CatalogTraitDescriptor[] = [...reachable.values()].map((trait) => ({
    name: trait.ns,
    fields: fieldsOf(
      args.schema,
      trait as { readonly fields: Record<string, AnyField & { readonly ident: string }> },
    ),
    traits: (trait.traits ?? []).map((inner) => inner.ns),
    reachable: true,
  }));
  const operations: CatalogOperationDescriptor[] = (args.operations ?? []).map((op) => ({
    owner: ownerRefOf(op.owner),
    localName: op.localName,
    target: op.target,
    inputKeys: op.inputKeys,
  }));
  const fingerprint =
    args.fingerprint ??
    sha256Hex(
      canonicalJson({
        catalogId: args.catalogId,
        catalogVersion: args.catalogVersion,
        entities,
        traits,
        operations,
      }),
    );
  return {
    catalogId: args.catalogId,
    catalogVersion: args.catalogVersion,
    fingerprint,
    entities,
    traits,
    operations,
  };
};
