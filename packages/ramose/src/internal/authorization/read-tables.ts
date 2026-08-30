/**
 * The catalog descriptor tables an authorized *read* is derived from.
 *
 * Extracted from the deployment assembly so both sides of the read-compatibility
 * agreement can produce them from one implementation: the server folds them into
 * the installed catalog unit, and #477's browser client derives its activation
 * `readCompatibilityHash` from the very same walk over the very same authored
 * `Schema`. A second copy on the client would be a hash that drifts silently and
 * fails every activation with `update-required`.
 *
 * These tables carry no deployment, policy, or operation identity: operations
 * are supplied by the caller, and {@link catalogReadTables} passes none.
 */

import { traitDefinitionOf, type TraitLike } from "../../db/Binding.ts";
import type { AnyEntity } from "../../db/Entity.ts";
import { documentationOf } from "../../db/documentation.ts";
import type { AnyField } from "../../db/Field.ts";
import { collectDefinitionEntities } from "../../db/reachability.ts";
import { schemaTraits, type AnySchema } from "../../db/Schema.ts";
import { traitsOf, walkTraits, type ComposerLike } from "../../db/compose.ts";
import type { AnyTrait } from "../../db/Trait.ts";
import { isSelfRefSchema, refTargetOf } from "../../db/valueTypes.ts";
import type { CatalogDefinition } from "../../Catalog.ts";
import type { CatalogDescriptor, FieldRefTarget } from "./catalog.ts";
import { InvalidIR } from "./failures.ts";
import { CatalogId, EntityId, FieldId, type OwnerRef, TraitId } from "./identities.ts";

/** Everything one catalog's authorized read is derived from. */
export type CatalogReadTables = Omit<
  CatalogDescriptor,
  "database" | "version" | "fingerprint"
>;

const invalid = (message: string): InvalidIR => new InvalidIR({ message });

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const ownerRef = (kind: "entity" | "trait", name: string): OwnerRef => ({
  kind,
  name,
});

const stableDirectTraits = (
  owner: ComposerLike,
): readonly TraitLike[] => {
  const seen = new Set<string>();
  const out: TraitLike[] = [];
  for (const trait of traitsOf(owner)) {
    const stable = traitDefinitionOf(trait as unknown as TraitLike);
    if (seen.has(stable.ns)) continue;
    seen.add(stable.ns);
    out.push(stable);
  }
  return out;
};

const directTraits = (
  catalog: CatalogId,
  owner: ComposerLike,
): readonly TraitId[] =>
  stableDirectTraits(owner).map((trait) =>
    TraitId.make({ catalog, name: trait.ns })
  );

const refTarget = (
  catalog: CatalogId,
  field: AnyField,
): FieldRefTarget => {
  if (isSelfRefSchema(field.schema)) return { _tag: "self" };
  const target = refTargetOf(field.schema)?.();
  if (target?._tag === "Entity" && target.ns !== undefined) {
    return { _tag: "entity", entity: EntityId.make({ catalog, name: target.ns }) };
  }
  if (target?._tag === "Trait" && target.ns !== undefined) {
    return { _tag: "trait", trait: TraitId.make({ catalog, name: target.ns }) };
  }
  return { _tag: "untargeted" };
};

const ownFields = (
  catalog: CatalogId,
  kind: "entity" | "trait",
  owner: AnyEntity | AnyTrait,
): CatalogDescriptor["fields"] => {
  const fields: CatalogDescriptor["fields"][number][] = [];
  const expectedPrefix = `:${owner.ns}/`;
  for (const field of Object.values(owner.fields)) {
    if (!field.ident.startsWith(expectedPrefix)) continue;
    const localName = field.ident.slice(expectedPrefix.length);
    if (localName.length === 0 || localName.includes("/")) {
      throw invalid(`invalid field identity '${field.ident}'`);
    }
    if (field.valueType === undefined) {
      throw invalid(`field '${field.ident}' has no storage value type`);
    }
    const common = {
      id: FieldId.make({ catalog, owner: ownerRef(kind, owner.ns), localName }),
      cardinality: field.cardinality,
      ...(field.unique === undefined ? {} : { unique: field.unique }),
      index: field.index,
      optional: field.isOptional,
      owned: field.owned,
      ...(field.doc === undefined ? {} : { doc: field.doc }),
    };
    fields.push(field.valueType === "ref"
      ? { ...common, valueType: "ref", refTarget: refTarget(catalog, field) }
      : { ...common, valueType: field.valueType });
  }
  return fields;
};

/**
 * Every entity one definition reaches, including the ones only its operations
 * name. Assembly and the client must walk the same closure or their tables
 * would describe different catalogs.
 */
export const completeSchema = (definition: CatalogDefinition): AnySchema => {
  const entities: Record<string, AnyEntity> = {};
  for (const reachable of collectDefinitionEntities(definition)) {
    entities[reachable.entity.ns] = reachable.entity;
  }
  return Object.freeze({
    _tag: "Schema" as const,
    entities: Object.freeze(entities),
  });
};

export const descriptorTables = (
  catalog: CatalogId,
  schema: AnySchema,
  operations: CatalogDescriptor["operations"],
): CatalogReadTables => {
  const entities = Object.values(schema.entities).sort((left, right) =>
    compareText(left.ns, right.ns)
  );
  const traits = [...schemaTraits(schema).values()].sort((left, right) =>
    compareText(left.ns, right.ns)
  );
  const entityDescriptors = entities.map((entity) => {
    const doc = documentationOf(entity);
    return {
      id: EntityId.make({ catalog, name: entity.ns }),
      traits: directTraits(catalog, entity as ComposerLike),
      ...(doc === undefined ? {} : { doc }),
    };
  });
  const traitDescriptors = traits.map((trait) => {
    const doc = documentationOf(trait);
    return {
      id: TraitId.make({ catalog, name: trait.ns }),
      traits: directTraits(catalog, trait as unknown as ComposerLike),
      ...(doc === undefined ? {} : { doc }),
    };
  });
  const fields = [
    ...entities.flatMap((entity) => ownFields(catalog, "entity", entity)),
    ...traits.flatMap((trait) => ownFields(catalog, "trait", trait)),
  ];
  const traitComposition = entities.flatMap((entity) =>
    stableDirectTraits(entity as ComposerLike).map((stable) => {
      const nested = walkTraits(traitsOf(stable as unknown as ComposerLike)).all;
      const names = [stable.ns, ...nested.map((trait) => trait.ns)];
      return {
        composer: EntityId.make({ catalog, name: entity.ns }),
        trait: TraitId.make({ catalog, name: stable.ns }),
        transitive: [...new Set(names)].map((name) => TraitId.make({ catalog, name })),
      };
    })
  );
  return {
    id: catalog,
    entities: entityDescriptors,
    traits: traitDescriptors,
    fields,
    operations,
    traitComposition,
  };
};

/**
 * The read tables of one authored catalog definition, with no operations.
 *
 * Read compatibility deliberately excludes operations, so the client never has
 * to lower them to agree with the server on the hash.
 */
export const catalogReadTables = (
  definition: CatalogDefinition,
): CatalogReadTables =>
  descriptorTables(
    CatalogId.make(definition.key),
    completeSchema(definition),
    [],
  );
