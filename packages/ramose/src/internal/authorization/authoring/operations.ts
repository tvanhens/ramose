/**
 * Lower public entity/trait-owned operations into catalog-local data.
 *
 * The descriptor side is inert, canonical hash material. The definition side
 * retains the trusted Effect Schemas and executable body for the later #417
 * authoritative boundary. Nothing is registered globally or by import order.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
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
  isSelfRefSchema,
  refTargetOf,
  tryInferDbValueType,
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
  type OperationDescriptor as OperationDescriptorType,
} from "../catalog.ts";
import {
  hashDomainSeparatedCanonicalJson,
} from "../decode.ts";
import type { JsonValue } from "../json.ts";

const OPERATION_SCHEMA_HASH_DOMAIN_V1 = "ramose/operation-schema/v1\0";
const OPERATION_BODY_HASH_DOMAIN_V1 = "ramose/operation-body/v1\0";

export type DeployedOperationDefinition = {
  readonly id: OperationDescriptorType["id"];
  readonly owner: OperationOwner;
  readonly localName: string;
  readonly self: boolean;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  readonly doc: string | undefined;
  readonly run: AnyOwnedOperation["run"];
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

const invalid = (message: string): InvalidIR => new InvalidIR({ message });

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const ownerRefOf = (owner: OperationOwner): OwnerRef => ({
  kind: owner._tag === "Entity" ? "entity" : "trait",
  name: owner.ns,
});

const definitionKey = (owner: OwnerRef, localName: string): string =>
  `${owner.kind}\0${owner.name}\0${localName}`;

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

/** Remove Effect struct-key wrappers while retaining their inner ref metadata. */
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

const astContainsRamoseRef = (
  ast: SchemaAST.AST,
  active: ReadonlySet<object> = new Set(),
): boolean => {
  if (active.has(ast)) return false;
  const next = new Set(active).add(ast);
  const node = ast as SchemaAST.AST & {
    readonly types?: ReadonlyArray<SchemaAST.AST>;
    readonly elements?: ReadonlyArray<SchemaAST.AST>;
    readonly rest?: ReadonlyArray<SchemaAST.AST>;
    readonly propertySignatures?: ReadonlyArray<{ readonly type: SchemaAST.AST }>;
    readonly encoding?: ReadonlyArray<{ readonly to: SchemaAST.AST }>;
  };
  if (astHasRamoseRefMarker(ast)) return true;
  const children = [
    ...(node.types ?? []),
    ...(node.elements ?? []),
    ...(node.rest ?? []),
    ...(node.propertySignatures ?? []).map((field) => field.type),
    ...(node.encoding ?? []).map((link) => link.to),
  ];
  return children.some((child) => astContainsRamoseRef(child, next));
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

/** Conservative policy-visible projection of an Effect Schema. */
export const lowerOperationSchema = (
  catalog: CatalogId,
  schema: Schema.Top,
  active: ReadonlySet<Schema.Top> = new Set(),
): OperationInputShape => {
  schema = unwrapPropertySchema(schema);
  if (active.has(schema)) return { _tag: "opaque" };
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
  };
  if (record.fields !== undefined) {
    const keys = Reflect.ownKeys(record.fields);
    if (keys.some((key) => typeof key !== "string")) return { _tag: "opaque" };
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
  if (schemaContainsRamoseRef(schema)) {
    throw new Error(
      `refs nested inside an unsupported ${SchemaAST.toType(schema.ast)._tag} operation schema cannot be lowered`,
    );
  }
  return primitiveShape(schema.ast) ?? { _tag: "opaque" };
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

const callbackSources = (root: object): readonly string[] => {
  const seen = new WeakSet<object>();
  const sources: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "function") {
      sources.push(`${path}\0${Function.prototype.toString.call(value)}`);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value).sort(compareText)) {
      visit((value as Record<string, unknown>)[key], `${path}.${key}`);
    }
  };
  visit(root, "schema");
  return sources;
};

const schemaHashMaterial = (
  catalog: CatalogId,
  schema: Schema.Top,
  artifactHash: DigestHex,
): Result.Result<JsonValue, InvalidIR> => {
  try {
    return Result.succeed({
      representation: SchemaRepresentation.toJson(
        SchemaRepresentation.toRepresentation(schema.ast),
      ),
      ramoseShape: lowerOperationSchema(catalog, schema),
      callbacks: callbackSources(schema.ast),
      artifactHash,
    } as JsonValue);
  } catch (cause) {
    return Result.fail(
      invalid(`operation schema lowering failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    );
  }
};

const hashOperationSchema = Effect.fn("Authorization.hashOperationSchema")(
  function* (catalog: CatalogId, schema: Schema.Top, artifactHash: DigestHex) {
    const material = yield* Effect.fromResult(
      schemaHashMaterial(catalog, schema, artifactHash),
    );
    return yield* hashDomainSeparatedCanonicalJson(
      OPERATION_SCHEMA_HASH_DOMAIN_V1,
      material,
    );
  },
);

const bodySource = (run: AnyOwnedOperation["run"]): Result.Result<string, InvalidIR> => {
  try {
    return Result.succeed(Function.prototype.toString.call(run));
  } catch (cause) {
    return Result.fail(
      invalid(`operation body lowering failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    );
  }
};

const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

/**
 * Deterministically lower every operation reachable from one catalog's schema
 * components. Repeated reachability of the same definition is idempotent;
 * owner/local collisions between different definitions fail. `artifactHash`
 * must identify the immutable deployed bundle so captured constants and schema
 * callback closures cannot reuse a fingerprint across distinct artifacts.
 */
export const lowerOwnedOperations = Effect.fn("Authorization.lowerOwnedOperations")(
  function* (
    catalog: CatalogId,
    input: AnySchema | readonly AnySchema[],
    artifactHash: DigestHex,
  ): Effect.fn.Return<LoweredOwnedOperations, InvalidIR> {
    const schemas = Array.isArray(input) ? input : [input as AnySchema];
    const drafts = yield* Effect.fromResult(collectDrafts(schemas));
    const descriptors: OperationDescriptorType[] = [];
    const definitions: DeployedOperationDefinition[] = [];

    for (const draft of drafts) {
      const operation = draft.operation;
      const id = OperationId.make({
        catalog,
        owner: draft.ownerRef,
        localName: draft.localName,
        target: operation.self ? "required" : "none",
      });
      const [inputSchemaHash, outputSchemaHash, bodyHash] = yield* Effect.all([
        hashOperationSchema(catalog, operation.input, artifactHash),
        hashOperationSchema(catalog, operation.output, artifactHash),
        Effect.flatMap(
          Effect.fromResult(bodySource(operation.run)),
          (source) =>
            hashDomainSeparatedCanonicalJson(OPERATION_BODY_HASH_DOMAIN_V1, {
              artifactHash,
              source,
            }),
        ),
      ]);
      const inputShape = lowerOperationSchema(catalog, operation.input);
      const outputShape = lowerOperationSchema(catalog, operation.output);
      if (
        !operation.self &&
        (shapeContainsSelf(inputShape) || shapeContainsSelf(outputShape))
      ) {
        return yield* invalid(
          `targetless operation '${draft.owner.ns}.${draft.localName}' cannot reference self`,
        );
      }
      const descriptorInput = {
        id,
        input: inputShape,
        output: outputShape,
        inputSchemaHash,
        outputSchemaHash,
        bodyHash,
        composers:
          draft.owner._tag === "Trait" && operation.self
            ? draft.composers.map((entity) => EntityId.make({ catalog, name: entity.ns }))
            : [],
        ...(operation.doc === undefined ? {} : { doc: operation.doc }),
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
          id,
          owner: draft.owner,
          localName: draft.localName,
          self: operation.self,
          input: operation.input,
          output: operation.output,
          doc: operation.doc,
          run: operation.run,
        }) as DeployedOperationDefinition,
      );
    }

    return freeze({
      descriptors: Object.freeze(descriptors),
      definitions: Object.freeze(definitions),
    });
  },
);
