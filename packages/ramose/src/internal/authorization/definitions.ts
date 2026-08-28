/** Immutable permanent-key catalog-definition assembly (#323). */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  isCatalogDefinition,
  type CatalogDefinition,
} from "../../Catalog.ts";
import {
  resolveCodeDefinition,
  traitDefinitionOf,
  type TraitLike,
} from "../../db/Binding.ts";
import { compositionValueMetadata } from "../../db/creation.ts";
import type { AnyEntity } from "../../db/Entity.ts";
import {
  creationDefaultIdentityOf,
  type AnyField,
  type CreationDefault,
} from "../../db/Field.ts";
import {
  collectCodeReachability,
  collectDefinitionEntities,
  type ReachableCodeDefinition,
} from "../../db/reachability.ts";
import { schemaTraits, type AnySchema } from "../../db/Schema.ts";
import type { AnyTrait } from "../../db/Trait.ts";
import { traitsOf, walkTraits, type ComposerLike } from "../../db/compose.ts";
import {
  isSelfRefSchema,
  refTargetOf,
} from "../../db/valueTypes.ts";
import type { CompositionIndex } from "../core/composition.ts";
import type { CatalogDescriptor, FieldRefTarget } from "./catalog.ts";
import {
  type AssembleCatalogUnitFailure,
  type InstalledCatalogUnitV2,
  sealInstalledCatalogUnit,
} from "./catalog-unit.ts";
import { compositionFromUnit } from "./composition.ts";
import {
  decodePolicyTemplateResult,
  hashCatalogSchemaFingerprint,
  hashDomainSeparatedCanonicalJson,
} from "./decode.ts";
import {
  CatalogMismatch,
  CatalogUnitCorrupt,
  CatalogVersionMismatch,
  InvalidIR,
} from "./failures.ts";
import {
  CatalogId,
  type CatalogUnitHash,
  CatalogVersion,
  DatabaseId,
  type DigestHex,
  EntityId,
  FieldId,
  type OwnerRef,
  SchemaFingerprint,
  TraitId,
} from "./identities.ts";
import { installAuthorization, type InstallFailure } from "./install.ts";
import type { JsonValue } from "./json.ts";
import {
  lowerOwnedOperations,
  type DeployedOperationDefinition,
} from "./authoring/operations.ts";
import { requireUnitHash } from "./deployed.ts";

export type InstalledCatalogDefinition = {
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
  readonly unit: InstalledCatalogUnitV2;
  readonly composition: CompositionIndex;
  /** Trusted code retained for the authoritative operation boundary. */
  readonly operations: readonly DeployedOperationDefinition[];
  /** Complete same-database schema closure, including operation writes. */
  readonly schema: AnySchema;
  readonly definition: CatalogDefinition;
  readonly path: readonly string[];
};

export type CatalogDefinitions = {
  readonly root: CatalogId;
  readonly require: (
    catalogKey: CatalogId,
  ) => Result.Result<InstalledCatalogDefinition, CatalogMismatch>;
  readonly keys: () => readonly CatalogId[];
};

export type CatalogDefinitionBoundRef = {
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
};

export type AssembleCatalogDefinitionsInput = {
  readonly root: CatalogDefinition;
  /** SHA-256 of the immutable deployed bundle containing these definitions. */
  readonly artifactHash: DigestHex;
};

type AssemblyFailure =
  | AssembleCatalogUnitFailure
  | CatalogUnitCorrupt
  | InstallFailure
  | InvalidIR;

const invalid = (message: string): InvalidIR => new InvalidIR({ message });

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const CATALOG_DEFINITION_VERSION_DOMAIN = "ramose/catalog-definition/v1\0";

const fromPure = <A>(label: string, evaluate: () => A): Effect.Effect<A, InvalidIR> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => invalid(
      `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
    ),
  });

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
    };
    fields.push(field.valueType === "ref"
      ? { ...common, valueType: "ref", refTarget: refTarget(catalog, field) }
      : { ...common, valueType: field.valueType });
  }
  return fields;
};

const completeSchema = (definition: CatalogDefinition): AnySchema => {
  const entities: Record<string, AnyEntity> = {};
  for (const reachable of collectDefinitionEntities(definition)) {
    entities[reachable.entity.ns] = reachable.entity;
  }
  return Object.freeze({
    _tag: "Schema" as const,
    entities: Object.freeze(entities),
  });
};

const jsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { _tag: "instant", value: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { _tag: "bytes", value: [...value] };
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort(compareText)) {
      out[key] = jsonValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new Error("catalog fixed values must encode as finite stored data");
};

const defaultIdentity = (
  get: CreationDefault<unknown>,
  label: string,
): JsonValue => {
  const identity = creationDefaultIdentityOf(get);
  if (identity === undefined) {
    throw new Error(
      `${label} must declare canonical captured inputs with creationDefault(inputs, get)`,
    );
  }
  return {
    source: identity.source,
    inputs: jsonValue(identity.inputs),
  };
};

/** Canonical executable creation metadata retained outside the inert unit. */
const creationHashMaterial = (
  schema: AnySchema,
  artifactHash: DigestHex,
): JsonValue => ({
  artifactHash,
  entities: Object.values(schema.entities)
    .sort((left, right) => compareText(left.ns, right.ns))
    .map((entity) => {
      const metadata = compositionValueMetadata(entity);
      return {
        name: entity.ns,
        fieldDefaults: Object.values(entity.fields)
          .filter((field) => typeof field.default === "function")
          .sort((left, right) => compareText(left.ident, right.ident))
          .map((field) => ({
            field: field.ident,
            default: defaultIdentity(
              field.default!,
              `field default '${field.ident}'`,
            ),
          })),
        fixed: [...metadata.fixed.values()]
          .sort((left, right) => compareText(left.ident, right.ident))
          .map((entry) => ({ field: entry.ident, value: jsonValue(entry.value) })),
        defaults: [...metadata.defaults.entries()]
          .sort(([left], [right]) => compareText(left, right))
          .map(([field, entries]) => ({
            field,
            defaults: entries.map((entry) => defaultIdentity(
              entry.get,
              `composition default '${field}'`,
            )),
          })),
        bindings: metadata.bindings.map((use) => ({
          trait: use.binding.trait.ns,
          definition: use.binding.definition.key,
          dependencies: use.binding.dependencies
            .map(resolveCodeDefinition)
            .map((dependency) => dependency.key)
            .sort(compareText),
        })),
      };
    }),
});

const descriptorTables = (
  catalog: CatalogId,
  schema: AnySchema,
  operations: CatalogDescriptor["operations"],
): Omit<CatalogDescriptor, "database" | "version" | "fingerprint"> => {
  const entities = Object.values(schema.entities).sort((left, right) =>
    compareText(left.ns, right.ns)
  );
  const traits = [...schemaTraits(schema).values()].sort((left, right) =>
    compareText(left.ns, right.ns)
  );
  const entityDescriptors = entities.map((entity) => ({
    id: EntityId.make({ catalog, name: entity.ns }),
    traits: directTraits(catalog, entity as ComposerLike),
  }));
  const traitDescriptors = traits.map((trait) => ({
    id: TraitId.make({ catalog, name: trait.ns }),
    traits: directTraits(catalog, trait as unknown as ComposerLike),
  }));
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

const assembleOne = Effect.fn("Authorization.assembleCatalogDefinition")(
  function* (
    reachable: ReachableCodeDefinition,
    artifactHash: DigestHex,
  ): Effect.fn.Return<InstalledCatalogDefinition, AssemblyFailure> {
    if (!isCatalogDefinition(reachable.definition)) {
      return yield* invalid(
        `reachable key '${reachable.key}' has no runnable Catalog definition (path: ${reachable.path.join(" → ")})`,
      );
    }
    const definition = reachable.definition;
    const catalog = CatalogId.make(definition.key);
    const authoredPolicy = Effect.isEffect(definition.policy)
      ? yield* definition.policy
      : definition.policy;
    const template = yield* Effect.fromResult(
      decodePolicyTemplateResult(authoredPolicy),
    );
    const schema = yield* fromPure(
      `catalog '${definition.key}' schema reachability failed`,
      () => completeSchema(definition),
    );
    const lowered = yield* lowerOwnedOperations(catalog, schema, artifactHash);
    const tables = yield* fromPure(
      `catalog '${definition.key}' descriptor lowering failed`,
      () => descriptorTables(catalog, schema, lowered.descriptors),
    );
    const version = CatalogVersion.make(yield* hashDomainSeparatedCanonicalJson(
      CATALOG_DEFINITION_VERSION_DOMAIN,
      yield* fromPure(
        `catalog '${definition.key}' creation metadata lowering failed`,
        () => creationHashMaterial(schema, artifactHash),
      ),
    ));
    const descriptorWithoutFingerprint = {
      ...tables,
      // Definition-local seal target. Concrete DatabaseId binding is #459.
      database: DatabaseId.make(`catalog-definition:${definition.key}`),
      version,
      fingerprint: SchemaFingerprint.make("pending"),
    } satisfies CatalogDescriptor;
    const fingerprint = yield* hashCatalogSchemaFingerprint(descriptorWithoutFingerprint);
    const descriptor: CatalogDescriptor = {
      ...descriptorWithoutFingerprint,
      fingerprint,
    };
    const policy = yield* installAuthorization({
      target: {
        database: descriptor.database,
        catalog,
        catalogVersion: descriptor.version,
        schemaFingerprint: descriptor.fingerprint,
      },
      descriptor,
      template,
    });
    const unit = yield* sealInstalledCatalogUnit(descriptor, policy);
    const composition = yield* Effect.fromResult(compositionFromUnit(unit));
    return Object.freeze({
      catalogKey: catalog,
      unitHash: unit.unitHash,
      unit,
      composition,
      operations: Object.freeze([...lowered.definitions]),
      schema,
      definition,
      path: Object.freeze([...reachable.path]),
    });
  },
);

const buildRegistry = (
  root: CatalogId,
  byKey: ReadonlyMap<CatalogId, InstalledCatalogDefinition>,
): CatalogDefinitions => Object.freeze({
  root,
  require: (catalogKey: CatalogId) => {
    const found = byKey.get(catalogKey);
    return found === undefined
      ? Result.fail(new CatalogMismatch({ message: "catalog definition mismatch" }))
      : Result.succeed(found);
  },
  keys: () => Object.freeze([...byKey.keys()].sort(compareText)),
});

/** Resolve a definition and require its exact immutable unit hash. */
export const resolveCatalogDefinition = (
  definitions: CatalogDefinitions,
  ref: CatalogDefinitionBoundRef,
): Result.Result<
  InstalledCatalogDefinition,
  CatalogMismatch | CatalogVersionMismatch
> => Result.gen(function* () {
  const definition = yield* definitions.require(ref.catalogKey);
  yield* requireUnitHash(ref.unitHash, definition.unitHash, definition.catalogKey);
  return definition;
});

/**
 * Startup/orchestration shell. Reachability, closure, lookup, and agreement
 * stay pure; hashing, operation lowering, policy install, and sealing use one
 * Effect boundary.
 */
export const assembleCatalogDefinitions = Effect.fn(
  "Authorization.assembleCatalogDefinitions",
)(function* (
  input: AssembleCatalogDefinitionsInput,
): Effect.fn.Return<CatalogDefinitions, AssemblyFailure> {
  if (!/^[0-9a-f]{64}$/.test(input.artifactHash)) {
    return yield* invalid("catalog artifact hash must be 64 lowercase hexadecimal characters");
  }
  const reachability = yield* fromPure(
    "catalog definition reachability failed",
    () => collectCodeReachability(input.root),
  );
  const byKey = new Map<CatalogId, InstalledCatalogDefinition>();
  for (const reachable of reachability.definitions) {
    const assembled = yield* assembleOne(reachable, input.artifactHash);
    byKey.set(assembled.catalogKey, assembled);
  }
  return buildRegistry(CatalogId.make(reachability.root.key), Object.freeze(byKey));
});
