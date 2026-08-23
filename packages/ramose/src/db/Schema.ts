/** Composition of entities; the typed client's type parameter. */

import type { AnyEntity, Entity } from "./Entity.ts";

export type EntityMap = Record<string, AnyEntity>;

export interface Schema<Es extends EntityMap = EntityMap> {
  readonly _tag: "Schema";
  readonly entities: Es;
}

/** @internal The public spelling is {@link Schema.Any}. */
export type AnySchema = Schema<EntityMap>;

/** Compose entities into a schema. Address fields via `User.name`. */
export const Schema = <const Es extends EntityMap>(
  entities: Es,
): Schema<Es> => ({
  _tag: "Schema",
  entities,
});

export declare namespace Schema {
  /** Any schema — the bound for schema-generic helpers. */
  export type Any = Schema<EntityMap>;
}

/** Concatenate schemas. Later keys win on collision. */
export const merge = <const A extends EntityMap, const B extends EntityMap>(
  left: Schema<A>,
  right: Schema<B>,
): Schema<A & B> => ({
  _tag: "Schema",
  entities: { ...left.entities, ...right.entities },
});

export type EntityOf<
  C extends AnySchema,
  K extends keyof C["entities"],
> = C["entities"][K];
