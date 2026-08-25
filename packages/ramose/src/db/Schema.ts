/** Composition of entities; the typed client's type parameter. */

import type { AnyEntity } from "./Entity.ts";
import {
  conflictingIdent,
  duplicateEntityName,
  schemaKeyMismatch,
  type EntitiesFromArray,
  type ValidEntityList,
  type ValidEntityMap,
  type ValidMerge,
} from "./IdentName.ts";

export type EntityMap = Record<string, AnyEntity>;

export interface Schema<Es extends EntityMap = EntityMap> {
  readonly _tag: "Schema";
  readonly entities: Es;
}

/** @internal The public spelling is {@link Schema.Any}. */
export type AnySchema = Schema<EntityMap>;

const isEntity = (value: unknown): value is AnyEntity =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Entity" &&
  typeof (value as { readonly ns?: unknown }).ns === "string";

const assertIdents = (entities: EntityMap): void => {
  const seen = new Set<string>();
  for (const entity of Object.values(entities)) {
    for (const key of Object.keys(entity.fields)) {
      const ident = `:${entity.ns}/${key}`;
      if (seen.has(ident)) throw conflictingIdent(ident);
      seen.add(ident);
    }
  }
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
  assertIdents(entities);
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
  assertIdents(input);
  return input;
};

/**
 * Compose entities into a schema. Address fields via `User.name`.
 *
 * Object form requires each key to equal that entity's name, so a policy's
 * `ns.todo` and the wire prefix `:todo/*` cannot drift. Array form keys
 * each entity by its own name: `Schema([User, Label])` is
 * `{ user: User, label: Label }`.
 */
export function Schema<const Es extends readonly AnyEntity[]>(
  entities: ValidEntityList<Es>,
): Schema<EntitiesFromArray<Es>>;
export function Schema<const Es extends EntityMap>(
  entities: ValidEntityMap<Es>,
): Schema<Es>;
export function Schema(
  entities: EntityMap | readonly AnyEntity[],
): Schema<EntityMap> {
  if (Array.isArray(entities)) {
    return { _tag: "Schema", entities: fromList(entities) };
  }
  return { _tag: "Schema", entities: fromMap(entities as EntityMap) };
}

export declare namespace Schema {
  /** Any schema — the bound for schema-generic helpers. */
  export type Any = Schema<EntityMap>;
}

/** Concatenate schemas. Overlapping entity names are rejected. */
export const merge = <const A extends EntityMap, const B extends EntityMap>(
  left: Schema<A>,
  right: Schema<ValidMerge<A, B>>,
): Schema<A & B> => {
  for (const ns of Object.keys(right.entities)) {
    if (Object.hasOwn(left.entities, ns)) throw duplicateEntityName(ns);
  }
  const entities = { ...left.entities, ...right.entities };
  assertIdents(entities);
  return { _tag: "Schema", entities };
};

export type EntityOf<
  C extends AnySchema,
  K extends keyof C["entities"],
> = C["entities"][K];
