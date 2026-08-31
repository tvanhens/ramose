import {
  assertEntityTraitNames,
  assertUniqueIdents,
  reachableTraits,
  type ComposerLike,
} from "./compose.ts";
import {
  collectSchemaPolicy,
  type ApplyPolicy,
} from "../internal/authorization/authoring/policy.ts";
import type { CompileReadAuthorizationInput } from "../internal/authorization/authoring/types.ts";
import type { AnyEntity } from "./Entity.ts";
import {
  duplicateEntityName,
  schemaKeyMismatch,
  type EntitiesFromArray,
  type ValidEntityList,
  type ValidEntityMap,
  type ValidMerge,
} from "./IdentName.ts";
import type { AnyTrait } from "./Trait.ts";

export type EntityMap = Record<string, AnyEntity>;

export interface SchemaShape<Es extends EntityMap = EntityMap> {
  readonly _tag: "Schema";
  readonly entities: Es;
}

export interface Schema<
  Key extends string = string,
  Es extends EntityMap = EntityMap,
> extends SchemaShape<Es> {
  readonly key: Key;
  readonly schema: Schema<Key, Es>;
  readonly applyPolicy: ApplyPolicy<Es>;
}

export type AnySchema = SchemaShape<EntityMap>;
export type AnySchemaDefinition = Schema<string, EntityMap>;

export const SCHEMA_POLICY: unique symbol = Symbol.for("ramose.schema.policy");

type SchemaPolicyState = {
  registered: boolean;
  policy?: CompileReadAuthorizationInput;
};

type SchemaWithPolicyState = AnySchemaDefinition & {
  readonly [SCHEMA_POLICY]?: SchemaPolicyState;
};

const collectPolicy = collectSchemaPolicy as unknown as (
  schema: AnySchemaDefinition,
  ...args: unknown[]
) => CompileReadAuthorizationInput;

const isEntity = (value: unknown): value is AnyEntity =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Entity" &&
  typeof (value as { readonly ns?: unknown }).ns === "string";

const assertCatalog = (entities: EntityMap): void => {
  assertUniqueIdents(Object.values(entities) as ComposerLike[]);
  const traits = reachableTraits(Object.values(entities) as ComposerLike[]);
  assertEntityTraitNames(Object.keys(entities), traits);
};

const fromList = (list: readonly unknown[]): EntityMap => {
  const entities: Record<string, AnyEntity> = {};
  for (const value of list) {
    if (!isEntity(value)) {
      throw new Error(
        "ramose/schema: Schema([...]) expects Entity values",
      );
    }
    if (Object.hasOwn(entities, value.ns)) throw duplicateEntityName(value.ns);
    entities[value.ns] = value;
  }
  assertCatalog(entities);
  return entities;
};

const fromMap = (input: EntityMap): EntityMap => {
  const seen = new Set<string>();
  for (const [key, entity] of Object.entries(input)) {
    if (!isEntity(entity)) {
      throw new Error(
        `ramose/schema: Schema key ${JSON.stringify(key)} is not an Entity`,
      );
    }
    if (key !== entity.ns) throw schemaKeyMismatch(key, entity.ns);
    if (seen.has(entity.ns)) throw duplicateEntityName(entity.ns);
    seen.add(entity.ns);
  }
  assertCatalog(input);
  return input;
};

/**
 * Define a named schema. Address fields via `User.name`.
 *
 * Object form requires each key to equal that entity's name, so a policy's
 * `ns.todo` and the wire prefix `:todo/*` cannot drift. Array form keys
 * each entity by its own name: `Schema("app", [User, Label])` is
 * `{ user: User, label: Label }`.
 */
export function Schema<
  const Key extends string,
  const Es extends readonly AnyEntity[],
>(
  key: Key,
  entities: ValidEntityList<Es>,
): Schema<Key, EntitiesFromArray<Es>>;
export function Schema<const Key extends string, const Es extends EntityMap>(
  key: Key,
  entities: ValidEntityMap<Es>,
): Schema<Key, Es>;
export function Schema<const Key extends string>(
  key: Key,
  entities: EntityMap | readonly AnyEntity[],
): Schema<Key, EntityMap> {
  if (key.length === 0) {
    throw new Error("ramose/schema: permanent key must not be empty");
  }
  const entityMap = Array.isArray(entities)
    ? fromList(entities)
    : fromMap(entities as EntityMap);
  const policyState: SchemaPolicyState = { registered: false };
  let schema!: Schema<Key, EntityMap>;
  const applyPolicy = ((...args: unknown[]) => {
    if (policyState.registered) {
      throw new Error(
        `ramose/schema: policy already applied to schema ${JSON.stringify(key)}`,
      );
    }
    policyState.registered = true;
    policyState.policy = collectPolicy(schema, ...args);
  }) as ApplyPolicy<EntityMap>;
  schema = {
    _tag: "Schema",
    key,
    get schema() {
      return schema;
    },
    entities: entityMap,
    applyPolicy,
  };
  Object.defineProperty(schema, SCHEMA_POLICY, {
    value: policyState,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(schema);
}

export declare namespace Schema {
  export type Any = Schema<string, EntityMap>;
}

export const merge = <
  const Key extends string,
  const A extends EntityMap,
  const B extends EntityMap,
>(
  key: Key,
  left: Schema<string, A>,
  right: Schema<string, ValidMerge<A, B>>,
): Schema<Key, A & B> => {
  for (const ns of Object.keys(right.entities)) {
    if (Object.hasOwn(left.entities, ns)) throw duplicateEntityName(ns);
  }
  return Schema(key, { ...left.entities, ...right.entities } as A & B) as Schema<
    Key,
    A & B
  >;
};

export const appliedPolicyOf = (
  schema: AnySchemaDefinition,
): CompileReadAuthorizationInput | undefined =>
  (schema as SchemaWithPolicyState)[SCHEMA_POLICY]?.policy;

export const isSchemaDefinition = (
  value: unknown,
): value is AnySchemaDefinition =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Schema" &&
  typeof (value as { readonly key?: unknown }).key === "string" &&
  (value as { readonly key: string }).key.length > 0 &&
  (value as { readonly schema?: unknown }).schema === value &&
  typeof (value as { readonly entities?: unknown }).entities === "object" &&
  (value as { readonly entities?: unknown }).entities !== null &&
  typeof (value as { readonly applyPolicy?: unknown }).applyPolicy === "function";

export type EntityOf<
  C extends AnySchema,
  K extends keyof C["entities"],
> = C["entities"][K];

export const schemaTraits = (
  schema: AnySchema,
): ReadonlyMap<string, AnyTrait> =>
  reachableTraits(Object.values(schema.entities) as ComposerLike[]) as unknown as ReadonlyMap<
    string,
    AnyTrait
  >;
