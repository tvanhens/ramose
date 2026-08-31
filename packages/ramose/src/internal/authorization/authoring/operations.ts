import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import {
  isOwnedOperation,
  OwnedOperations,
  type AnyOwnedOperation,
  type OperationOwner,
} from "../../../db/Operation.ts";
import {
  assertEntityTraitNames,
  reachableTraits,
  walkTraits,
  type ComposerLike,
} from "../../../db/compose.ts";
import type { AnyEntity } from "../../../db/Entity.ts";
import type { AnySchema } from "../../../db/Schema.ts";
import type { AnyTrait } from "../../../db/Trait.ts";
import {
  bindDeployedSchema,
  type DeployedSchemaCodec,
} from "../../../db/deployedSchema.ts";
import {
  isSelfRefSchema,
  refTargetOf,
  tryInferDbValueType,
  type DbValueType,
} from "../../../db/valueTypes.ts";
import { InvalidIR } from "../failures.ts";
import {
  CatalogId,
  type DigestHex,
  EntityId,
  OperationId,
  TraitId,
  type OwnerRef,
} from "../identities.ts";
import {
  OperationDescriptor,
  type FieldRefTarget,
  type OperationInputShape,
  type OperationWireShape,
  type OperationDescriptor as OperationDescriptorType,
} from "../catalog.ts";
import {
  hashDomainSeparatedCanonicalJson,
} from "../decode.ts";
import {
  hashOperationVersion,
  requireOperationRevision,
  type OperationVersionDescriptor,
} from "../operation-version.ts";
import type { JsonValue } from "../json.ts";

const OPERATION_SCHEMA_HASH_DOMAIN_V1 = "ramose/operation-schema/v1\0";
const OPERATION_IMPLEMENTATION_HASH_DOMAIN_V1 =
  "ramose/operation-implementation/v1\0";

export type DeployedOperationCodec = DeployedSchemaCodec;

export type DeployedOperationRun = (
  op: unknown,
  input: unknown,
) => unknown | Promise<unknown>;

export type DeployedEntityRuntimeDefinition = {
  readonly ns: string;
  readonly fields: Readonly<Record<string, {
    readonly ident: string;
    readonly cardinality: "one" | "many";
    readonly valueType: DbValueType | undefined;
    readonly unique?: "upsert" | "strict";
  }>>;
};

export type DeployedOperationDefinition = {
  readonly id: OperationDescriptorType["id"];
  readonly owner: OwnerRef;
  readonly localName: string;
  readonly self: boolean;
  readonly writes: readonly EntityId[];
  readonly input: DeployedOperationCodec;
  readonly output: DeployedOperationCodec;
  readonly inputWireShape: OperationWireShape;
  readonly inputSchemaHash: DigestHex;
  readonly outputSchemaHash: DigestHex;
  readonly doc: string | undefined;
  readonly implementationHash: DigestHex;
  readonly entityDefinitions: readonly DeployedEntityRuntimeDefinition[];
  readonly run: DeployedOperationRun;
};

export type DeployedOperationBinding = {
  readonly descriptor: OperationDescriptorType;
  readonly input: DeployedOperationCodec;
  readonly output: DeployedOperationCodec;
  readonly inputWireShape: OperationWireShape;
  readonly run: DeployedOperationRun;
  readonly entityDefinitions: readonly DeployedEntityRuntimeDefinition[];
};

export type LoweredOwnedOperations = {
  readonly descriptors: readonly OperationDescriptorType[];
  readonly definitions: readonly DeployedOperationDefinition[];
};

type Draft = {
  readonly operation: AnyOwnedOperation;
  readonly owner: OperationOwner;
  readonly ownerRef: OwnerRef;
  readonly localName: string;
  readonly composers: readonly AnyEntity[];
};

export type OwnedOperationSnapshot = {
  readonly id: OperationDescriptorType["id"];
  readonly owner: OwnerRef;
  readonly localName: string;
  readonly self: boolean;
  readonly writes: readonly EntityId[];
  readonly composers: readonly EntityId[];
  readonly inputShape: OperationInputShape;
  readonly inputWireShape: OperationWireShape;
  readonly outputShape: OperationInputShape;
  readonly inputSchemaMaterial: JsonValue;
  readonly outputSchemaMaterial: JsonValue;
  readonly inputCodec: DeployedOperationCodec;
  readonly outputCodec: DeployedOperationCodec;
  readonly doc: string | undefined;
  readonly run: DeployedOperationRun;
  readonly implementationHashMaterial: JsonValue;
  readonly entityDefinitions: readonly DeployedEntityRuntimeDefinition[];
  readonly revision: number;
  readonly versionDescriptor: OperationVersionDescriptor;
};

const invalid = (message: string): InvalidIR => new InvalidIR({ message });

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const ownerRefOf = (owner: OperationOwner): OwnerRef => ({
  kind: owner._tag === "Entity" ? "entity" : "trait",
  name: owner.ns,
});

const definitionKey = (owner: OwnerRef, localName: string): string =>
  `${owner.kind}\0${owner.name}\0${localName}`;

const operationLabel = (owner: OwnerRef, localName: string): string =>
  `${owner.kind} '${owner.name}.${localName}'`;

const hasCodec = (value: unknown): value is DeployedOperationCodec =>
  typeof value === "object" && value !== null &&
  typeof (value as { readonly decode?: unknown }).decode === "function" &&
  typeof (value as { readonly encode?: unknown }).encode === "function";

export const pairDeployedOperations = (
  descriptors: readonly OperationDescriptorType[],
  definitions: readonly DeployedOperationDefinition[],
): Result.Result<readonly DeployedOperationBinding[], InvalidIR> =>
  Result.gen(function* () {
    const byKey = new Map<string, DeployedOperationDefinition>();
    for (const definition of definitions) {
      const key = definitionKey(definition.owner, definition.localName);
      if (byKey.has(key)) {
        return yield* Result.fail(invalid(
          `duplicate deployed operation binding for ${
            operationLabel(definition.owner, definition.localName)
          }`,
        ));
      }
      if (!hasCodec(definition.input) || !hasCodec(definition.output)) {
        return yield* Result.fail(invalid(
          `missing deployed operation codec for ${
            operationLabel(definition.owner, definition.localName)
          }`,
        ));
      }
      if (typeof definition.run !== "function") {
        return yield* Result.fail(invalid(
          `missing deployed operation executable for ${
            operationLabel(definition.owner, definition.localName)
          }`,
        ));
      }
      byKey.set(key, definition);
    }

    const paired: DeployedOperationBinding[] = [];
    const descriptorKeys = new Set<string>();
    for (const descriptor of descriptors) {
      const key = definitionKey(descriptor.id.owner, descriptor.id.localName);
      if (descriptorKeys.has(key)) {
        return yield* Result.fail(invalid(
          `duplicate operation descriptor for ${
            operationLabel(descriptor.id.owner, descriptor.id.localName)
          }`,
        ));
      }
      descriptorKeys.add(key);
      const definition = byKey.get(key);
      if (definition === undefined) {
        return yield* Result.fail(invalid(
          `missing deployed operation binding for ${
            operationLabel(descriptor.id.owner, descriptor.id.localName)
          }`,
        ));
      }
      if (
        definition.id.catalog !== descriptor.id.catalog ||
        definition.id.owner.kind !== descriptor.id.owner.kind ||
        definition.id.owner.name !== descriptor.id.owner.name ||
        definition.id.localName !== descriptor.id.localName ||
        definition.id.target !== descriptor.id.target ||
        (definition.self ? "required" : "none") !== descriptor.id.target ||
        definition.inputSchemaHash !== descriptor.inputSchemaHash ||
        definition.outputSchemaHash !== descriptor.outputSchemaHash ||
        definition.implementationHash !== descriptor.bodyHash
      ) {
        return yield* Result.fail(invalid(
          `mismatched deployed operation binding for ${
            operationLabel(descriptor.id.owner, descriptor.id.localName)
          }`,
        ));
      }
      byKey.delete(key);
      paired.push(Object.freeze({
        descriptor,
        input: definition.input,
        output: definition.output,
        inputWireShape: definition.inputWireShape,
        run: definition.run,
        entityDefinitions: definition.entityDefinitions,
      }));
    }

    const extra = byKey.values().next().value;
    if (extra !== undefined) {
      return yield* Result.fail(invalid(
        `deployed operation binding has no descriptor for ${
          operationLabel(extra.owner, extra.localName)
        }`,
      ));
    }
    return Object.freeze(paired);
  });

const operationsOf = (
  owner: OperationOwner,
): Readonly<Record<string, unknown>> => owner[OwnedOperations] ?? {};

const collectOwners = (
  schemas: readonly AnySchema[],
): Result.Result<
  {
    readonly entities: readonly AnyEntity[];
    readonly traits: ReadonlyMap<string, AnyTrait>;
  },
  InvalidIR
> => {
  const entities = new Map<string, AnyEntity>();
  for (const schema of schemas) {
    for (const entity of Object.values(schema.entities)) {
      const previous = entities.get(entity.ns);
      if (previous !== undefined && previous !== entity) {
        return Result.fail(invalid(`duplicate entity definition '${entity.ns}'`));
      }
      entities.set(entity.ns, entity);
    }
  }
  try {
    const traits = reachableTraits(
      entities.values() as Iterable<ComposerLike>,
    ) as unknown as ReadonlyMap<string, AnyTrait>;
    assertEntityTraitNames(
      entities.keys(),
      traits as unknown as ReadonlyMap<string, ComposerLike>,
    );
    return Result.succeed({
      entities: [...entities.values()].sort((left, right) =>
        compareText(left.ns, right.ns)
      ),
      traits,
    });
  } catch (cause) {
    return Result.fail(
      invalid(cause instanceof Error ? cause.message : String(cause)),
    );
  }
};

const composerEntities = (
  trait: AnyTrait,
  entities: readonly AnyEntity[],
): readonly AnyEntity[] =>
  entities.filter((entity) =>
    walkTraits((entity as ComposerLike).traits).all.some(
      (candidate) => candidate === (trait as unknown as ComposerLike),
    )
  );

const collectDrafts = (
  schemas: readonly AnySchema[],
): Result.Result<readonly Draft[], InvalidIR> =>
  Result.gen(function* () {
    const { entities, traits } = yield* collectOwners(schemas);
    const drafts: Draft[] = [];
    const seen = new Map<string, AnyOwnedOperation>();
    const writeDefinitions = new Map(
      entities.map((entity) => [entity.ns, entity] as const),
    );

    const collect = (
      owner: OperationOwner,
      composers: readonly AnyEntity[],
    ): Result.Result<void, InvalidIR> => {
      for (const localName of Object.keys(operationsOf(owner)).sort(compareText)) {
        const candidate = operationsOf(owner)[localName];
        if (!isOwnedOperation(candidate)) {
          return Result.fail(
            invalid(`malformed operation '${owner.ns}.${localName}'`),
          );
        }
        if (candidate.owner !== owner || candidate.localName !== localName) {
          return Result.fail(
            invalid(`conflicting operation binding '${owner.ns}.${localName}'`),
          );
        }
        const localWrites = new Set<string>();
        for (const entity of candidate.writes) {
          if (localWrites.has(entity.ns)) {
            return Result.fail(
              invalid(
                `duplicate write definition '${entity.ns}' in operation '${owner.ns}.${localName}'`,
              ),
            );
          }
          localWrites.add(entity.ns);
          const previousDefinition = writeDefinitions.get(entity.ns);
          if (previousDefinition !== undefined && previousDefinition !== entity) {
            return Result.fail(
              invalid(
                `conflicting write definition '${entity.ns}' in operation '${owner.ns}.${localName}'`,
              ),
            );
          }
          writeDefinitions.set(entity.ns, entity);
        }
        const ownerRef = ownerRefOf(owner);
        const key = definitionKey(ownerRef, localName);
        const previous = seen.get(key);
        if (previous !== undefined) {
          if (previous !== candidate) {
            return Result.fail(invalid(`duplicate operation identity '${owner.ns}.${localName}'`));
          }
          continue;
        }
        seen.set(key, candidate);
        drafts.push({ operation: candidate, owner, ownerRef, localName, composers });
      }
      return Result.succeed(undefined);
    };

    for (const entity of entities) yield* collect(entity, []);
    for (const trait of [...traits.values()].sort((left, right) =>
      compareText(left.ns, right.ns)
    )) {
      yield* collect(trait, composerEntities(trait, entities));
    }
    return drafts;
  });

const refShape = (
  catalog: CatalogId,
  schema: Schema.Top,
): OperationInputShape => {
  if (isSelfRefSchema(schema)) {
    return { _tag: "ref", refTarget: { _tag: "self" } };
  }
  const resolve = refTargetOf(schema);
  if (resolve === undefined) {
    return { _tag: "ref", refTarget: { _tag: "untargeted" } };
  }
  const target = resolve();
  if (target.ns === undefined) {
    return { _tag: "ref", refTarget: { _tag: "untargeted" } };
  }
  const refTarget: FieldRefTarget = target._tag === "Trait"
    ? { _tag: "trait", trait: TraitId.make({ catalog, name: target.ns }) }
    : { _tag: "entity", entity: EntityId.make({ catalog, name: target.ns }) };
  return { _tag: "ref", refTarget };
};

const primitiveShape = (ast: SchemaAST.AST): OperationInputShape | undefined => {
  const type = SchemaAST.toType(ast);
  switch (type._tag) {
    case "String":
    case "TemplateLiteral":
      return { _tag: "scalar", valueType: "string" };
    case "Number":
      return { _tag: "scalar", valueType: "double" };
    case "Boolean":
      return { _tag: "scalar", valueType: "boolean" };
    case "Literal":
      return typeof type.literal === "string"
        ? { _tag: "scalar", valueType: "string" }
        : typeof type.literal === "number"
          ? { _tag: "scalar", valueType: "double" }
          : typeof type.literal === "boolean"
            ? { _tag: "scalar", valueType: "boolean" }
            : undefined;
    case "Enum": {
      const kinds = new Set(type.enums.map(([, value]) => typeof value));
      return kinds.size === 1 && kinds.has("string")
        ? { _tag: "scalar", valueType: "string" }
        : kinds.size === 1 && kinds.has("number")
          ? { _tag: "scalar", valueType: "double" }
          : undefined;
    }
    default:
      return undefined;
  }
};

const unwrapPropertySchema = (schema: Schema.Top): Schema.Top => {
  let current = schema;
  const seen = new Set<Schema.Top>();
  while (SchemaAST.isOptional(current.ast) && !seen.has(current)) {
    seen.add(current);
    const inner = (current as Schema.Top & { readonly schema?: unknown }).schema;
    if (!Schema.isSchema(inner)) break;
    current = inner;
  }
  return current;
};

const isRamoseRefIdentifier = (value: unknown): boolean =>
  value === "ramose/ref" || value === "ramose/ref-self";

const astHasRamoseRefMarker = (ast: SchemaAST.AST): boolean => {
  const node = ast as SchemaAST.AST & {
    readonly annotations?: { readonly identifier?: unknown };
    readonly checks?: ReadonlyArray<{
      readonly annotations?: { readonly identifier?: unknown };
    }>;
  };
  return (
    isRamoseRefIdentifier(node.annotations?.identifier) ||
    node.checks?.some((check) =>
      isRamoseRefIdentifier(check.annotations?.identifier)
    ) === true
  );
};

const astChildren = (ast: SchemaAST.AST): readonly SchemaAST.AST[] => {
  const children: SchemaAST.AST[] = [];
  const seen = new WeakSet<object>([ast]);
  const isAst = (value: object): value is SchemaAST.AST =>
    (value as { readonly "~effect/Schema"?: unknown })["~effect/Schema"] ===
      "~effect/Schema" &&
    typeof (value as { readonly _tag?: unknown })._tag === "string";
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    if (isAst(value)) {
      children.push(value);
      return;
    }
    seen.add(value);
    for (const child of Object.values(value)) visit(child);
  };
  for (const [key, value] of Object.entries(ast)) {
    if (key === "annotations" || key === "checks" || key === "context") continue;
    visit(value);
  }
  return children;
};

const astContainsRamoseRef = (
  ast: SchemaAST.AST,
  active: ReadonlySet<object> = new Set(),
): boolean => {
  if (active.has(ast)) return false;
  const next = new Set(active).add(ast);
  if (astHasRamoseRefMarker(ast)) return true;
  return astChildren(ast).some((child) => astContainsRamoseRef(child, next));
};

const astContainsSuspend = (
  ast: SchemaAST.AST,
  active: ReadonlySet<object> = new Set(),
): boolean => {
  if (active.has(ast)) return false;
  if (ast._tag === "Suspend") return true;
  const next = new Set(active).add(ast);
  return astChildren(ast).some((child) => astContainsSuspend(child, next));
};

const schemaContainsRamoseRef = (
  schema: Schema.Top,
  active: ReadonlySet<Schema.Top> = new Set(),
): boolean => {
  schema = unwrapPropertySchema(schema);
  if (active.has(schema)) return false;
  if (tryInferDbValueType(schema) === "ref") return true;
  if (astContainsRamoseRef(schema.ast)) return true;
  const next = new Set(active).add(schema);
  const node = schema as Schema.Top & {
    readonly fields?: Readonly<Record<PropertyKey, Schema.Top>>;
    readonly value?: Schema.Top;
    readonly members?: ReadonlyArray<Schema.Top>;
    readonly elements?: ReadonlyArray<Schema.Top>;
    readonly rest?: ReadonlyArray<Schema.Top>;
    readonly from?: Schema.Top;
    readonly to?: Schema.Top;
  };
  return [
    ...Object.values(node.fields ?? {}),
    ...(node.value === undefined ? [] : [node.value]),
    ...(node.members ?? []),
    ...(node.elements ?? []),
    ...(node.rest ?? []),
    ...(node.from === undefined ? [] : [node.from]),
    ...(node.to === undefined ? [] : [node.to]),
  ].some((child) => schemaContainsRamoseRef(child, next));
};

export const lowerOperationSchema = (
  catalog: CatalogId,
  schema: Schema.Top,
  active: ReadonlySet<Schema.Top> = new Set(),
): OperationInputShape => {
  schema = unwrapPropertySchema(schema);
  if (active.has(schema)) return { _tag: "opaque" };
  if (schema.ast._tag === "Suspend") {
    throw new Error("suspended operation schemas cannot be lowered");
  }
  const next = new Set(active).add(schema);
  const valueType = tryInferDbValueType(schema);
  if (valueType === "ref") return refShape(catalog, schema);
  if (astHasRamoseRefMarker(schema.ast)) {
    throw new Error(
      `refs wrapped by an unsupported ${SchemaAST.toType(schema.ast)._tag} operation schema cannot be lowered`,
    );
  }
  if (valueType !== undefined) {
    return { _tag: "scalar", valueType };
  }

  const record = schema as Schema.Top & {
    readonly fields?: Readonly<Record<PropertyKey, Schema.Top>>;
    readonly value?: Schema.Top;
    readonly to?: Schema.Top;
  };
  if (record.fields !== undefined) {
    const keys = Reflect.ownKeys(record.fields);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error("operation structs with symbol keys cannot be lowered");
    }
    return {
      _tag: "struct",
      fields: (keys as string[]).sort(compareText).map((key) => {
        const field = record.fields![key]!;
        return {
          key,
          optional: SchemaAST.isOptional(field.ast),
          shape: lowerOperationSchema(catalog, field, next),
        };
      }),
    };
  }
  if (record.value !== undefined && SchemaAST.toType(schema.ast)._tag === "Arrays") {
    return {
      _tag: "array",
      items: lowerOperationSchema(catalog, record.value, next),
    };
  }
  if (record.to !== undefined && record.to !== schema) {
    return lowerOperationSchema(catalog, record.to, next);
  }
  if (astContainsSuspend(schema.ast)) {
    throw new Error(
      `suspended schemas nested inside an unsupported ${SchemaAST.toType(schema.ast)._tag} operation schema cannot be lowered`,
    );
  }
  if (schemaContainsRamoseRef(schema)) {
    throw new Error(
      `refs nested inside an unsupported ${SchemaAST.toType(schema.ast)._tag} operation schema cannot be lowered`,
    );
  }
  return primitiveShape(schema.ast) ?? { _tag: "opaque" };
};

const refDepths = (
  shape: OperationInputShape | OperationWireShape,
  prefix: string,
  into: string[],
): readonly string[] => {
  switch (shape._tag) {
    case "ref":
      into.push(prefix);
      break;
    case "array":
      refDepths(shape.items, `${prefix}[]`, into);
      break;
    case "struct":
      for (const field of shape.fields) refDepths(field.shape, `${prefix}*`, into);
      break;
    default:
      break;
  }
  return into;
};

const wireRefsAreDeclared = (
  wire: OperationWireShape,
  decoded: OperationInputShape,
): boolean => {
  const declared = [...refDepths(decoded, "", [])];
  for (const depth of refDepths(wire, "", [])) {
    const at = declared.indexOf(depth);
    if (at < 0) return false;
    declared.splice(at, 1);
  }
  return true;
};

export const lowerOperationWireShape = (
  catalog: CatalogId,
  schema: Schema.Top,
  active: ReadonlySet<Schema.Top> = new Set(),
): OperationWireShape => {
  schema = unwrapPropertySchema(schema);
  if (active.has(schema)) return { _tag: "opaque" };
  const next = new Set(active).add(schema);
  if (
    tryInferDbValueType(schema) === "ref" || astHasRamoseRefMarker(schema.ast)
  ) return { _tag: "ref" };

  const record = schema as Schema.Top & {
    readonly fields?: Readonly<Record<PropertyKey, Schema.Top>>;
    readonly value?: Schema.Top;
    readonly from?: Schema.Top;
    readonly to?: Schema.Top;
  };
  if (record.fields !== undefined) {
    const keys = Reflect.ownKeys(record.fields);
    if (keys.some((key) => typeof key !== "string")) return { _tag: "opaque" };
    return {
      _tag: "struct",
      fields: (keys as string[]).sort(compareText).map((key) => ({
        key,
        shape: lowerOperationWireShape(catalog, record.fields![key]!, next),
      })),
    };
  }
  if (record.value !== undefined && SchemaAST.toType(schema.ast)._tag === "Arrays") {
    return {
      _tag: "array",
      items: lowerOperationWireShape(catalog, record.value, next),
    };
  }
  if (record.from !== undefined && record.to !== undefined && record.to !== schema) {
    const wire = lowerOperationWireShape(catalog, record.from, next);
    let decoded: OperationInputShape;
    try {
      decoded = lowerOperationSchema(catalog, record.to, next);
    } catch {
      return { _tag: "opaque" };
    }
    return wireRefsAreDeclared(wire, decoded) ? wire : { _tag: "opaque" };
  }
  return primitiveShape(schema.ast) === undefined
    ? { _tag: "opaque" }
    : { _tag: "scalar" };
};

const shapeContainsSelf = (shape: OperationInputShape): boolean => {
  switch (shape._tag) {
    case "scalar":
    case "opaque":
      return false;
    case "ref":
      return shape.refTarget._tag === "self";
    case "array":
      return shapeContainsSelf(shape.items);
    case "struct":
      return shape.fields.some((field) => shapeContainsSelf(field.shape));
  }
};

const schemaHashMaterial = (
  catalog: CatalogId,
  schema: Schema.Top,
  representation: JsonValue,
  artifactHash: DigestHex,
): Result.Result<JsonValue, InvalidIR> => {
  try {
    return Result.succeed({
      representation,
      ramoseShape: lowerOperationSchema(catalog, schema),
      artifactHash,
    } as JsonValue);
  } catch (cause) {
    return Result.fail(
      invalid(`operation schema lowering failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    );
  }
};

const hashOperationSchema = Effect.fn("Authorization.hashOperationSchema")(
  function* (material: JsonValue) {
    return yield* hashDomainSeparatedCanonicalJson(
      OPERATION_SCHEMA_HASH_DOMAIN_V1,
      material,
    );
  },
);

const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

const runtimeEntityDefinition = (
  entity: AnyEntity,
): DeployedEntityRuntimeDefinition => Object.freeze({
  ns: entity.ns,
  fields: Object.freeze(Object.fromEntries(
    Object.entries(entity.fields).map(([key, field]) => [key, Object.freeze({
      ident: field.ident,
      cardinality: field.cardinality,
      valueType: field.valueType,
      ...(field.unique === undefined ? {} : { unique: field.unique }),
    })]),
  )),
});

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) deepFreeze(child, seen);
  return Object.freeze(value);
};

export const snapshotOwnedOperations = (
  catalog: CatalogId,
  schemas: readonly AnySchema[],
  artifactHash: DigestHex,
): Result.Result<readonly OwnedOperationSnapshot[], InvalidIR> =>
  Result.gen(function* () {
    const drafts = yield* collectDrafts(schemas);
    const { entities } = yield* collectOwners(schemas);
    const entityDefinitions = Object.freeze(
      entities.map(runtimeEntityDefinition),
    );
    const snapshots: OwnedOperationSnapshot[] = [];
    for (const draft of drafts) {
      const operation = draft.operation;
      const id = OperationId.make({
        catalog,
        owner: draft.ownerRef,
        localName: draft.localName,
        target: operation.self ? "required" : "none",
      });
      let inputSchemaBinding: ReturnType<typeof bindDeployedSchema>;
      let outputSchemaBinding: ReturnType<typeof bindDeployedSchema>;
      try {
        inputSchemaBinding = bindDeployedSchema(operation.input);
        outputSchemaBinding = bindDeployedSchema(operation.output);
      } catch (cause) {
        return yield* Result.fail(invalid(
          `operation schema binding failed for '${draft.owner.ns}.${draft.localName}': ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ));
      }
      const inputSchemaMaterial = yield* schemaHashMaterial(
        catalog,
        operation.input,
        inputSchemaBinding.projection as JsonValue,
        artifactHash,
      );
      const outputSchemaMaterial = yield* schemaHashMaterial(
        catalog,
        operation.output,
        outputSchemaBinding.projection as JsonValue,
        artifactHash,
      );
      const inputShape = lowerOperationSchema(catalog, operation.input);
      const outputShape = lowerOperationSchema(catalog, operation.output);
      if (
        !operation.self &&
        (shapeContainsSelf(inputShape) || shapeContainsSelf(outputShape))
      ) {
        return yield* Result.fail(invalid(
          `targetless operation '${draft.owner.ns}.${draft.localName}' cannot reference self`,
        ));
      }
      const writes = Object.freeze(operation.writes.map((entity) =>
        deepFreeze(EntityId.make({ catalog, name: entity.ns }))
      ));
      const composers = Object.freeze(
        draft.owner._tag === "Trait" && operation.self
          ? draft.composers.map((entity) =>
            deepFreeze(EntityId.make({ catalog, name: entity.ns }))
          )
          : [],
      );
      let revision: number;
      try {
        revision = requireOperationRevision(
          operation.revision,
          `${draft.owner.ns}.${draft.localName}`,
        );
      } catch (cause) {
        return yield* Result.fail(invalid(
          cause instanceof Error ? cause.message : String(cause),
        ));
      }
      snapshots.push(freeze({
        id: deepFreeze(id),
        owner: deepFreeze({ ...draft.ownerRef }),
        localName: draft.localName,
        self: operation.self,
        writes,
        composers,
        revision,
        versionDescriptor: deepFreeze({
          catalog,
          owner: { ...draft.ownerRef },
          localName: draft.localName,
          target: operation.self ? "required" : "none",
          revision,
          input: {
            representation: inputSchemaBinding.projection as JsonValue,
            shape: inputShape,
          },
          output: {
            representation: outputSchemaBinding.projection as JsonValue,
            shape: outputShape,
          },
          composers: composers.map((entity) => entity.name),
          writes: writes.map((entity) => entity.name),
          allocations: operation.allocations ?? [],
        }) as OperationVersionDescriptor,
        inputShape: deepFreeze(inputShape),
        inputWireShape: deepFreeze(
          lowerOperationWireShape(catalog, operation.input),
        ),
        outputShape: deepFreeze(outputShape),
        inputSchemaMaterial: deepFreeze(inputSchemaMaterial),
        outputSchemaMaterial: deepFreeze(outputSchemaMaterial),
        inputCodec: deepFreeze(inputSchemaBinding.codec),
        outputCodec: deepFreeze(outputSchemaBinding.codec),
        doc: operation.doc,
        run: operation.run as DeployedOperationRun,
        entityDefinitions,
        implementationHashMaterial: deepFreeze({
          artifactHash,
          operation: id,
        }),
      }));
    }
    return Object.freeze(snapshots);
  });

export const lowerOwnedOperationSnapshots = Effect.fn(
  "Authorization.lowerOwnedOperationSnapshots",
)(
  function* (
    snapshots: readonly OwnedOperationSnapshot[],
  ): Effect.fn.Return<LoweredOwnedOperations, InvalidIR> {
    const descriptors: OperationDescriptorType[] = [];
    const definitions: DeployedOperationDefinition[] = [];

    for (const snapshot of snapshots) {
      const [inputSchemaHash, outputSchemaHash, implementationHash, version] =
        yield* Effect.all([
          hashOperationSchema(snapshot.inputSchemaMaterial),
          hashOperationSchema(snapshot.outputSchemaMaterial),
          hashDomainSeparatedCanonicalJson(
            OPERATION_IMPLEMENTATION_HASH_DOMAIN_V1,
            snapshot.implementationHashMaterial,
          ),
          hashOperationVersion(snapshot.versionDescriptor),
        ]);
      const descriptorInput = {
        id: snapshot.id,
        input: snapshot.inputShape,
        output: snapshot.outputShape,
        version,
        revision: snapshot.revision,
        inputSchemaHash,
        outputSchemaHash,
        bodyHash: implementationHash,
        composers: snapshot.composers,
        writes: snapshot.writes,
        ...(snapshot.versionDescriptor.allocations.length === 0 ? {} : {
          allocations: snapshot.versionDescriptor.allocations.map(
            (allocation) => ({ slot: allocation.slot, path: [...allocation.path] }),
          ),
        }),
        ...(snapshot.doc === undefined ? {} : { doc: snapshot.doc }),
      };
      const descriptor = yield* Effect.fromResult(
        Result.mapError(
          Schema.decodeResult(OperationDescriptor)(descriptorInput),
          (failure) => invalid(`invalid lowered operation: ${failure.message}`),
        ),
      );
      descriptors.push(freeze(descriptor) as OperationDescriptorType);
      definitions.push(
        freeze({
          id: snapshot.id,
          owner: snapshot.owner,
          localName: snapshot.localName,
          self: snapshot.self,
          writes: snapshot.writes,
          input: snapshot.inputCodec,
          output: snapshot.outputCodec,
          inputWireShape: snapshot.inputWireShape,
          inputSchemaHash,
          outputSchemaHash,
          doc: snapshot.doc,
          implementationHash,
          run: snapshot.run,
          entityDefinitions: snapshot.entityDefinitions,
        }) as DeployedOperationDefinition,
      );
    }

    return freeze({
      descriptors: Object.freeze(descriptors),
      definitions: Object.freeze(definitions),
    });
  },
);

export const lowerOwnedOperations = Effect.fn("Authorization.lowerOwnedOperations")(
  function* (
    catalog: CatalogId,
    input: AnySchema | readonly AnySchema[],
    artifactHash: DigestHex,
  ): Effect.fn.Return<LoweredOwnedOperations, InvalidIR> {
    const schemas = Array.isArray(input) ? input : [input as AnySchema];
    const snapshots = yield* Effect.fromResult(
      snapshotOwnedOperations(catalog, schemas, artifactHash),
    );
    return yield* lowerOwnedOperationSnapshots(snapshots);
  },
);
