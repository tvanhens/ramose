/** Immutable permanent-key catalog-definition assembly (#323). */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  isCatalogDefinition,
  type CatalogDefinition,
} from "../../Catalog.ts";
import {
  traitDefinitionOf,
  type TraitLike,
} from "../../db/Binding.ts";
import {
  compileCreationPlan,
  resolveCompiledCreationValues,
  type CompiledCreationPlan,
  type CompositionValueMetadata,
} from "../../db/creation.ts";
import type { AnyEntity } from "../../db/Entity.ts";
import { documentationOf } from "../../db/documentation.ts";
import {
  type AnyField,
  type CreationDefaultContext,
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
import type {
  CatalogDescriptor,
  FieldRefTarget,
  OperationDescriptor,
} from "./catalog.ts";
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
  lowerOwnedOperationSnapshots,
  snapshotOwnedOperations,
  type DeployedOperationDefinition,
  type OwnedOperationSnapshot,
} from "./authoring/operations.ts";
import { requireUnitHash } from "./deployed.ts";

/** Descriptor and executable plan produced from one normalized snapshot. */
export type InstalledOperationDefinition = DeployedOperationDefinition & {
  readonly descriptor: OperationDescriptor;
};

export type InstalledCatalogDefinition = {
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
  readonly unit: InstalledCatalogUnitV2;
  readonly composition: CompositionIndex;
  /** Inseparable descriptor/runtime pairs produced by the assembly boundary. */
  readonly operations: readonly InstalledOperationDefinition[];
  /** Caller-free authoritative creation plans used by operation execution. */
  readonly creationPlans: readonly CompiledCreationPlan[];
  readonly path: readonly string[];
  /** Resolve authoritative creation values from assembly's binding snapshot. */
  readonly resolveCreationValues: (
    entityName: string,
    input: Readonly<Record<string, unknown>>,
    context: CreationDefaultContext,
  ) => Readonly<Record<string, unknown>>;
};

const installedOperationKey = (id: OperationDescriptor["id"]): string =>
  `${id.catalog}\0${id.owner.kind}\0${id.owner.name}\0${id.localName}\0${id.target}`;

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

type NormalizedDefinitionSnapshot = {
  readonly catalog: CatalogId;
  readonly key: string;
  readonly path: readonly string[];
  readonly policy: CatalogDefinition["policy"];
  readonly descriptorTables: Omit<
    CatalogDescriptor,
    "database" | "version" | "fingerprint"
  >;
  readonly creationPlans: readonly CompiledCreationPlan[];
  readonly creationHashMaterial: JsonValue;
  readonly operationSnapshots: readonly OwnedOperationSnapshot[];
};

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
      ...(field.doc === undefined ? {} : { doc: field.doc }),
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
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { _tag: "instant", value: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { _tag: "bytes", value: [...value] };
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null) {
    const out = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value).sort(compareText)) {
      out[key] = jsonValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new Error("catalog fixed values must encode as finite stored data");
};

/** Type-explicit encoding prevents Date/bytes from colliding with JSON lookalikes. */
const creationInputHashValue = (value: unknown): JsonValue => {
  if (value === null) return { _tag: "null" };
  if (typeof value === "string") return { _tag: "string", value };
  if (typeof value === "boolean") return { _tag: "boolean", value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { _tag: "number", value: Object.is(value, -0) ? 0 : value };
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { _tag: "instant", value: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { _tag: "bytes", value: [...value] };
  }
  if (Array.isArray(value)) {
    return { _tag: "array", value: value.map(creationInputHashValue) };
  }
  if (typeof value === "object" && value !== null) {
    return {
      _tag: "object",
      value: Object.keys(value).sort(compareText).map((key) => [
        key,
        creationInputHashValue((value as Record<string, unknown>)[key]),
      ]),
    };
  }
  throw new Error("creation default inputs must encode as supported canonical data");
};

/** Canonical identity derived from the same copied records as the runtime plan. */
const creationHashMaterial = (
  artifactHash: DigestHex,
  plans: readonly CompiledCreationPlan[],
): JsonValue => ({
  artifactHash,
  entities: [...plans].sort((left, right) => compareText(left.entity, right.entity))
    .map((plan) => ({
      name: plan.entity,
      fieldSchemas: [...plan.fields]
        .sort((left, right) => compareText(left.ident, right.ident))
        .map((field) => ({
          field: field.ident,
          representation: field.schemaRepresentation as JsonValue,
        })),
      fieldDefaults: plan.fields
        .filter((field) => field.fieldDefault !== undefined)
        .sort((left, right) => compareText(left.ident, right.ident))
        .map((field) => ({
          field: field.ident,
          default: {
            source: field.fieldDefault!.source,
            inputs: creationInputHashValue(field.fieldDefault!.inputs),
          },
        })),
      fixed: plan.fields
        .filter((field) => field.fixed !== undefined)
        .sort((left, right) => compareText(left.ident, right.ident))
        .map((field) => ({ field: field.ident, value: jsonValue(field.fixed) })),
      defaults: plan.fields
        .filter((field) => field.defaults.length > 0)
        .sort((left, right) => compareText(left.ident, right.ident))
        .map((field) => ({
          field: field.ident,
          defaults: field.defaults.map((entry) => ({
            source: entry.source,
            inputs: creationInputHashValue(entry.inputs),
          })),
        })),
      bindings: plan.bindings,
    })),
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

const normalizeDefinitionSnapshot = (
  reachable: ReachableCodeDefinition,
  artifactHash: DigestHex,
  metadataByEntity: ReadonlyMap<string, CompositionValueMetadata>,
): NormalizedDefinitionSnapshot => {
  if (!isCatalogDefinition(reachable.definition)) {
    throw invalid(
      `reachable key '${reachable.key}' has no runnable Catalog definition (path: ${reachable.path.join(" → ")})`,
    );
  }
  const catalog = CatalogId.make(reachable.definition.key);
  const schema = completeSchema(reachable.definition);
  const creationPlans = Object.freeze(
    Object.values(schema.entities)
      .sort((left, right) => compareText(left.ns, right.ns))
      .map((entity) => {
        const metadata = metadataByEntity.get(entity.ns);
        if (metadata === undefined) {
          throw invalid(`missing resolved binding metadata for entity '${entity.ns}'`);
        }
        return compileCreationPlan(entity, metadata);
      }),
  );
  const operationSnapshots = Result.getOrThrow(
    snapshotOwnedOperations(catalog, [schema], artifactHash),
  );
  return Object.freeze({
    catalog,
    key: reachable.definition.key,
    path: Object.freeze([...reachable.path]),
    policy: reachable.definition.policy,
    descriptorTables: Object.freeze(descriptorTables(catalog, schema, [])),
    creationPlans,
    creationHashMaterial: Object.freeze(
      creationHashMaterial(artifactHash, creationPlans),
    ),
    operationSnapshots,
  });
};

const assembleOne = Effect.fn("Authorization.assembleCatalogDefinition")(
  function* (
    snapshot: NormalizedDefinitionSnapshot,
  ): Effect.fn.Return<InstalledCatalogDefinition, AssemblyFailure> {
    const authoredPolicy = Effect.isEffect(snapshot.policy)
      ? yield* snapshot.policy
      : snapshot.policy;
    const template = yield* Effect.fromResult(
      decodePolicyTemplateResult(authoredPolicy),
    );
    const lowered = yield* lowerOwnedOperationSnapshots(snapshot.operationSnapshots);
    const tables = {
      ...snapshot.descriptorTables,
      operations: lowered.descriptors,
    };
    const version = CatalogVersion.make(yield* hashDomainSeparatedCanonicalJson(
      CATALOG_DEFINITION_VERSION_DOMAIN,
      snapshot.creationHashMaterial,
    ));
    const descriptorWithoutFingerprint = {
      ...tables,
      // Definition-local seal target. Concrete DatabaseId binding is #459.
      database: DatabaseId.make(`catalog-definition:${snapshot.key}`),
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
        catalog: snapshot.catalog,
        catalogVersion: descriptor.version,
        schemaFingerprint: descriptor.fingerprint,
      },
      descriptor,
      template,
    });
    const unit = yield* sealInstalledCatalogUnit(descriptor, policy);
    const composition = yield* Effect.fromResult(compositionFromUnit(unit));
    if (
      unit.catalog.operations.length !== lowered.definitions.length ||
      lowered.descriptors.length !== lowered.definitions.length
    ) {
      return yield* invalid("catalog operation assembly lost descriptor/runtime correlation");
    }
    const runtimeById = new Map<string, {
      readonly definition: DeployedOperationDefinition;
      readonly descriptor: OperationDescriptor;
    }>();
    for (let index = 0; index < lowered.definitions.length; index++) {
      const definition = lowered.definitions[index]!;
      const descriptor = lowered.descriptors[index]!;
      if (installedOperationKey(definition.id) !== installedOperationKey(descriptor.id)) {
        return yield* invalid("catalog operation snapshot lost descriptor/runtime correlation");
      }
      runtimeById.set(installedOperationKey(definition.id), { definition, descriptor });
    }
    if (runtimeById.size !== lowered.definitions.length) {
      return yield* invalid("catalog operation assembly contains duplicate runtime identities");
    }
    const operations: InstalledOperationDefinition[] = [];
    for (const descriptor of unit.catalog.operations) {
      const paired = runtimeById.get(installedOperationKey(descriptor.id));
      if (
        paired === undefined ||
        paired.descriptor.bodyHash !== descriptor.bodyHash ||
        paired.definition.implementationHash !== descriptor.bodyHash ||
        paired.descriptor.inputSchemaHash !== descriptor.inputSchemaHash ||
        paired.descriptor.outputSchemaHash !== descriptor.outputSchemaHash
      ) {
        return yield* invalid("catalog operation assembly lost sealed runtime identity");
      }
      operations.push(Object.freeze({
        ...paired.definition,
        descriptor,
      }));
    }
    const creationByEntity = new Map(
      snapshot.creationPlans.map((plan) => [plan.entity, plan] as const),
    );
    const catalogKeyText = snapshot.key;
    const resolveCreationValues = Object.freeze((
      entityName: string,
      input: Readonly<Record<string, unknown>>,
      context: CreationDefaultContext,
    ): Readonly<Record<string, unknown>> => {
      const plan = creationByEntity.get(entityName);
      if (plan === undefined) {
        throw new Error(
          `ramose/create: unknown entity ${JSON.stringify(entityName)} in catalog ${JSON.stringify(catalogKeyText)}`,
        );
      }
      return resolveCompiledCreationValues(plan, input, context);
    });
    return Object.freeze({
      catalogKey: snapshot.catalog,
      unitHash: unit.unitHash,
      unit,
      composition,
      operations: Object.freeze(operations),
      creationPlans: snapshot.creationPlans,
      path: snapshot.path,
      resolveCreationValues,
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
  const snapshots = yield* fromPure(
    "catalog definition authoring snapshot failed",
    () => reachability.definitions.map((reachable) => {
      const metadataByEntity = new Map<string, CompositionValueMetadata>();
      for (const creation of reachability.creation) {
        if (creation.catalogKey === reachable.key) {
          metadataByEntity.set(creation.entity, creation.metadata);
        }
      }
      return normalizeDefinitionSnapshot(
        reachable,
        input.artifactHash,
        metadataByEntity,
      );
    }),
  );
  const byKey = new Map<CatalogId, InstalledCatalogDefinition>();
  for (const snapshot of snapshots) {
    const assembled = yield* assembleOne(snapshot);
    byKey.set(assembled.catalogKey, assembled);
  }
  return buildRegistry(CatalogId.make(reachability.root.key), Object.freeze(byKey));
});
