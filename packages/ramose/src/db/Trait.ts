/** Reusable field group. Fields keep the trait namespace when composed. */

import {
  makeBindableTrait,
  type BindableTrait,
  type TraitBind,
} from "./Binding.ts";
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
import { attachAttrNav, type AttrNav, type PathCarrier } from "./shapes.ts";
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

export type BindableTraitOptions<
  Fields extends FieldMap,
  Traits extends readonly AnyTrait[],
  Bind extends TraitBind<Fields>,
> = TraitOptions<Traits> & { readonly bind: Bind };

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
  /** Pseudo-field `:db/id`, usable in trait-root select shapes. */
  readonly id: AttrNav<
    AnyField & {
      readonly schema: { readonly Type: number };
      readonly attrName: "id";
      readonly ident: ":db/id";
      readonly valueType: "ref";
      readonly cardinality: "one";
      readonly _ns?: Trait<Name, Fields>;
    } & PathCarrier
  >;
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
  readonly id: AttrNav<
    AnyField & {
      readonly schema: { readonly Type: number };
      readonly attrName: "id";
      readonly ident: ":db/id";
      readonly valueType: "ref";
      readonly cardinality: "one";
    } & PathCarrier
  >;
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

type TraitResult<
  Name extends string,
  Fields extends FieldMap,
  Traits extends readonly AnyTrait[],
  Bind extends TraitBind<Fields> | undefined,
> = Bind extends TraitBind<Fields>
  ? BindableTrait<TraitWithTraits<Name, Fields, Traits>, Bind>
  : TraitWithTraits<Name, Fields, Traits>;

/** Group fields under one ident prefix, optionally composing other traits. */
export function Trait<const Name extends string, Fields extends FieldMap>(
  name: ValidIdentName<Name>,
  fields: Fields & ValidFieldMap<Fields>,
): Trait<Name, Fields>;
export function Trait<
  const Name extends string,
  Fields extends FieldMap,
  const Bind extends TraitBind<Fields>,
  const Traits extends readonly AnyTrait[] = [],
>(
  name: ValidIdentName<Name>,
  fields: Fields & ValidFieldMap<Fields>,
  options: BindableTraitOptions<Fields, Traits, Bind> &
    ValidTraitCompose<Fields, Traits>,
): BindableTrait<TraitWithTraits<Name, Fields, Traits>, Bind>;
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
  const Bind extends TraitBind<Fields> | undefined = undefined,
>(
  name: ValidIdentName<Name>,
  fields: Fields & ValidFieldMap<Fields>,
  options?: (TraitOptions<Traits> & { readonly bind?: Bind }) &
    ValidTraitCompose<Fields, Traits>,
): Trait<Name, Fields> | TraitResult<Name, Fields, Traits, Bind> {
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
  const idField = attachAttrNav({
    _tag: "Field" as const,
    schema: null as never,
    cardinality: "one" as const,
    unique: undefined,
    index: false,
    owned: false,
    doc: undefined,
    valueType: "ref" as const,
    isOptional: false,
    default: undefined,
    attrName: "id" as const,
    ident: ":db/id" as const,
  });
  const trait = {
    _tag: "Trait" as const,
    ns: name,
    fields: merged,
    traits: direct,
    id: idField,
    ...merged,
  } as unknown as TraitWithTraits<Name, Fields, Traits>;
  if (options?.bind !== undefined) {
    return makeBindableTrait(
      trait,
      options.bind,
    ) as unknown as TraitResult<Name, Fields, Traits, Bind>;
  }
  return trait;
}
