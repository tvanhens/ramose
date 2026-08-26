/** Reusable field group. Fields keep the trait namespace when composed. */

import {
  flattenTraitFields,
  mergeComposerFields,
  walkTraits,
  type ComposerLike,
} from "./compose.ts";
import {
  stamp,
  type FieldMap,
  type StampedMap,
} from "./Entity.ts";
import type { AnyField } from "./Field.ts";
import {
  invalidIdentName,
  isIdentName,
  isReservedFieldKey,
  reservedFieldName,
  type FlattenedTraitFields,
  type ValidFieldMap,
  type ValidIdentName,
  type ValidTraitCompose,
} from "./IdentName.ts";

export type TraitOptions<
  Traits extends readonly AnyTrait[] = readonly AnyTrait[],
> = {
  readonly traits?: Traits;
};

/**
 * Stamped fields plus metadata. Address a field as `Taggable.tag`.
 * `fields` is the iteration map — not a second public handle. Trait
 * fields keep this trait's ident (`:taggable/tag`) when flattened onto
 * a composer.
 */
export type Trait<
  Name extends string = string,
  Fields extends FieldMap = FieldMap,
> = {
  readonly _tag: "Trait";
  readonly ns: Name;
  /**
   * Iteration map. Use `Taggable.tag` at call sites; this property exists
   * so schema / install can walk keys without listing them.
   */
  readonly fields: StampedMap<Name, Fields>;
  /** Direct composed traits, in author order. */
  readonly traits: readonly { readonly ns: string }[];
} & StampedMap<Name, Fields>;

/**
 * Bound for trait-generic helpers. `fields` is a wide record so a
 * composer with flattened trait fields stays assignable — `StampedMap`
 * would demand `orDefault(unknown)` and reject specific field refs.
 */
export type AnyTrait = {
  readonly _tag: "Trait";
  readonly ns: string;
  readonly fields: {
    readonly [key: string]: AnyField & { readonly ident: string };
  };
  readonly traits: readonly { readonly ns: string }[];
};

export declare namespace Trait {
  /** Any trait — the bound for trait-generic helpers. */
  export type Any = AnyTrait;
}

const assertTraitName = (name: string): void => {
  if (!isIdentName(name)) throw invalidIdentName("trait", name);
};

const assertFieldKeys = (fields: FieldMap): void => {
  for (const key of Object.keys(fields)) {
    if (isReservedFieldKey(key)) throw reservedFieldName(key);
    if (!isIdentName(key)) throw invalidIdentName("field", key);
  }
};

type TraitWithTraits<
  Name extends string,
  Fields extends FieldMap,
  Traits extends readonly AnyTrait[],
> = Trait<Name, Fields> &
  FlattenedTraitFields<Traits> & {
    readonly fields: StampedMap<Name, Fields> & FlattenedTraitFields<Traits>;
    readonly traits: Traits;
  };

/** Group fields under one ident prefix, optionally composing other traits. */
export function Trait<const Name extends string, Fields extends FieldMap>(
  name: ValidIdentName<Name>,
  fields: Fields & ValidFieldMap<Fields>,
): Trait<Name, Fields>;
export function Trait<
  const Name extends string,
  Fields extends FieldMap,
  const Traits extends readonly AnyTrait[],
>(
  name: ValidIdentName<Name>,
  fields: Fields & ValidFieldMap<Fields>,
  options: TraitOptions<Traits> & ValidTraitCompose<Fields, Traits>,
): TraitWithTraits<Name, Fields, Traits>;
export function Trait<
  const Name extends string,
  Fields extends FieldMap,
  const Traits extends readonly AnyTrait[],
>(
  name: ValidIdentName<Name>,
  fields: Fields & ValidFieldMap<Fields>,
  options?: TraitOptions<Traits> & ValidTraitCompose<Fields, Traits>,
): Trait<Name, Fields> | TraitWithTraits<Name, Fields, Traits> {
  assertTraitName(name);
  assertFieldKeys(fields);
  const direct = (options?.traits ?? []) as readonly ComposerLike[];
  walkTraits(direct);
  const stamped = stamp(name, fields);
  const flattened = flattenTraitFields(direct);
  const merged = mergeComposerFields(
    stamped as Record<string, unknown>,
    flattened,
  );
  return {
    _tag: "Trait" as const,
    ns: name,
    fields: merged,
    traits: direct,
    ...merged,
  } as Trait<Name, Fields> | TraitWithTraits<Name, Fields, Traits>;
}
