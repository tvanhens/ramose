/** Named group of fields. `User.name` is the stamped field ref (`:user/name`). */

import {
  flattenTraitFields,
  mergeComposerFields,
  walkTraits,
  type ComposerLike,
} from "./compose.ts";
import { COMPOSED_TRAITS } from "./Composer.ts";
import type { AnyField, Cardinality } from "./Field.ts";
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
import {
  attachAttrNav,
  cardsOf,
  pathOf,
  revsOf,
  type AttrNav,
  type PathCarrier,
} from "./shapes.ts";
import type { AnyTrait } from "./Trait.ts";
import {
  bindOwnedOperations,
  OwnedOperations,
  ownedOperationAuthor,
  type AnyUnboundOperation,
  type BoundOwnerOperations,
  type OwnedOperationAuthor,
  type ValidOwnedOperationMap,
} from "./Operation.ts";
import { DOCUMENTATION, normalizeDoc } from "./documentation.ts";

export type FieldMap = Record<string, AnyField>;

/**
 * Stamp a field with `name` / `ident` and the pull-shaping methods
 * (`.optional`, `.orDefault`, `.select`). Constraints live in the query
 * language (`Q`, the pipeable stdlib) — a field ref is data, not a builder.
 */
export type StampedField<
  Ns extends string,
  Name extends string,
  A extends AnyField,
> = AttrNav<
  A & {
    readonly attrName: Name;
    readonly ident: `:${Ns}/${Name}`;
  } & PathCarrier
>;

/**
 * The backlink `field.reverse` denotes: from the ref's **target**, the entities
 * of the ref's *owning* entity type that point at you. It is a shape node, not
 * a datom: select a shape through it (`Issue.creator.reverse.select({ … })`).
 *
 * `Card` is the backlink's own cardinality — see {@link ReverseNav} and
 * {@link OwnedReverseNav}.
 */
type BacklinkNav<
  Ns extends string,
  A extends AnyField,
  Name extends string,
  Card extends "one" | "many",
> = AttrNav<
  Omit<A, "cardinality" | "valueType" | "schema"> & {
    readonly attrName: Name;
    readonly ident: `:${Ns}/${Name}`;
    readonly cardinality: Card;
    readonly valueType: "ref";
    /** Distinguishes a backlink from a forward field of the same ident. */
    readonly __reverse: true;
  } & PathCarrier
>;

/**
 * The ordinary backlink: cardinality-many, because any number of entities may
 * point at one. Its shape is an array.
 */
export type ReverseNav<
  Ns extends string,
  A extends AnyField,
  Name extends string,
> = BacklinkNav<Ns, A, Name, "many">;

/**
 * The backlink of an owned ref: cardinality-**one**. An owned record is
 * owned by the entity that refers to it, so at most one entity points at it,
 * and the server answers such a backlink with a single value rather than a
 * collection (`cardMany = !field.owned` in the pull engine). Its
 * `.reverse.select({ … })` reads as one nested object — `.optional` when the
 * owned record may have no owner.
 */
export type OwnedReverseNav<
  Ns extends string,
  A extends AnyField,
  Name extends string,
> = BacklinkNav<Ns, A, Name, "one">;

/** One stamped field: a ref also exposes its backlink. */
export type NavStamp<
  Ns extends string,
  A extends AnyField,
  Name extends string,
> = A["valueType"] extends "ref"
  ? StampedField<Ns, Name, A> & {
      /**
       * An owned ref's backlink is single-valued; every other one is a
       * collection. A field whose ownership is not known statically
       * (a plain `boolean`, as {@link AnyField} carries) takes the
       * many-valued reading — the one that holds for any ref.
       */
      readonly reverse: [A["owned"]] extends [true]
        ? OwnedReverseNav<Ns, A, Name>
        : ReverseNav<Ns, A, Name>;
    }
  : StampedField<Ns, Name, A>;

export type StampedMap<Ns extends string, Fields extends FieldMap> = {
  readonly [K in keyof Fields]: NavStamp<Ns, Fields[K], K & string>;
};

/**
 * Stamped fields plus metadata. Address a field as `User.name`.
 * `fields` is the iteration map (`schemaTx`, `pick`, policy) — not a
 * second public handle. `id`, `ns`, `fields`, `_tag`, and `traits` cannot
 * be field names, so spreading cannot overwrite metadata. Entity documentation
 * uses a collision-free internal slot, leaving `doc` available as an
 * application field.
 *
 * Composed trait fields are intersected onto the instance (`Issue.tag`)
 * and keep the trait ident (`Issue.tag.ident === ":taggable/tag"`).
 */
export type Entity<
  Name extends string = string,
  Fields extends FieldMap = FieldMap,
  Ops extends Readonly<Record<string, AnyUnboundOperation>> = {},
> = {
  readonly _tag: "Entity";
  readonly ns: Name;
  /**
   * Iteration map. Use `User.name` at call sites; this property exists
   * so schema / policy / pull can walk keys without listing them.
   */
  readonly fields: StampedMap<Name, Fields>;
  /**
   * Direct composed traits, in author order. Empty when the entity
   * composes none.
   */
  readonly traits: readonly { readonly ns: string }[];
  /** Symbol-keyed operations canonically owned by this entity. */
  readonly [OwnedOperations]: BoundOwnerOperations<Entity<Name, Fields, Ops>, Ops>;
  /**
   * Pseudo-field `:db/id`, usable in `select` shapes. Typed as a stamped
   * field so it is a valid shape field, and
   * as a number so comparisons over it take the id they compare against.
   * The `_ns` phantom is the entity itself: it is what brands the
   * `select({ id: N.id })` row cell as `Eid<N>` (see `IdCell` in Pull.ts).
   */
  readonly id: AttrNav<
    AnyField & {
      readonly schema: { readonly Type: number };
      readonly attrName: "id";
      readonly ident: ":db/id";
      readonly valueType: "ref";
      readonly cardinality: "one";
      /** Phantom: the entity whose `:db/id` this is. Never at runtime. */
      readonly _ns?: Entity<Name, Fields>;
    } & PathCarrier
  >;
} & StampedMap<Name, Fields>;

/**
 * Bound for entity-generic helpers. `fields` is a wide record so a
 * composer with flattened trait fields stays assignable — `StampedMap`
 * would demand `orDefault(unknown)` and reject specific field refs.
 */
export type AnyEntity = {
  readonly _tag: "Entity";
  readonly ns: string;
  readonly fields: {
    readonly [key: string]: AnyField & { readonly ident: string };
  };
  readonly [COMPOSED_TRAITS]?: Readonly<Record<string, true>>;
  readonly id: AttrNav<
    AnyField & {
      readonly schema: { readonly Type: number };
      readonly attrName: "id";
      readonly ident: ":db/id";
      readonly valueType: "ref";
      readonly cardinality: "one";
    } & PathCarrier
  >;
  readonly [OwnedOperations]?: Readonly<Record<string, unknown>>;
};

type TraitClosure<T> = T extends AnyTrait
  ? T | TraitClosure<T["traits"][number]>
  : never;

type ComposedTraitMap<T extends AnyTrait> = {
  readonly [Trait in T as Trait["ns"]]: true;
};

export type EntityOptions<
  Traits extends readonly AnyTrait[] = readonly AnyTrait[],
> = {
  readonly traits?: Traits;
  readonly doc?: string;
};

type EntityImplementationOptions<
  Traits extends readonly AnyTrait[],
  Ops extends Readonly<Record<string, AnyUnboundOperation>>,
> = EntityOptions<Traits> & {
  readonly operations?:
    | Ops
    | ((Operation: OwnedOperationAuthor<any>) => Ops);
};

export declare namespace Entity {
  /** Any entity — the bound for entity-generic helpers. */
  export type Any = AnyEntity;
}

/**
 * `field.reverse` — the same ref hop, read backwards: a shape node for
 * backlink selects. The hop's cardinality is the backlink's: many for an
 * ordinary ref (any number of entities may point at one), **one** for an
 * owned ref — the owned record is owned by its referrer, so at most
 * one entity points at it, and the server answers that backlink with a single
 * value.
 */
const reverseNode = (from: PathCarrier): unknown => {
  const card: Cardinality =
    (from as { owned?: boolean }).owned === true ? "one" : "many";
  const path = pathOf(from);
  const cards = [...cardsOf(from)];
  const revs = [...revsOf(from)];
  cards[cards.length - 1] = card;
  revs[revs.length - 1] = true;

  return attachAttrNav({
    ...(from as object),
    ident: from.ident,
    cardinality: card,
    __path: path,
    __cards: cards,
    __revs: revs,
    __reverse: true,
  } satisfies PathCarrier as PathCarrier);
};

const stampOne = (
  ns: string,
  key: string,
  a: AnyField,
): StampedField<string, string, AnyField> => {
  const base = {
    ...a,
    attrName: key,
    ident: `:${ns}/${key}` as const,
  };

  const navigable = attachAttrNav(base as PathCarrier);
  if (a.valueType !== "ref") {
    return navigable as StampedField<string, string, AnyField>;
  }

  return new Proxy(navigable, {
    get(target, prop, receiver) {
      if (prop === "reverse") return reverseNode(receiver as PathCarrier);
      return Reflect.get(target, prop, receiver);
    },
  }) as StampedField<string, string, AnyField>;
};

export const stamp = <Name extends string, Fields extends FieldMap>(
  name: Name,
  fields: Fields,
): StampedMap<Name, Fields> => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    out[key] = stampOne(name, key, fields[key]!);
  }
  return out as unknown as StampedMap<Name, Fields>;
};

const assertEntityName = (name: string): void => {
  if (!isIdentName(name)) throw invalidIdentName("entity", name);
};

const assertFieldKeys = (fields: FieldMap): void => {
  for (const key of Object.keys(fields)) {
    if (isReservedFieldKey(key)) throw reservedFieldName(key);
    if (!isIdentName(key)) throw invalidIdentName("field", key);
  }
};

type EntityWithTraits<
  Name extends string,
  Fields extends FieldMap,
  Traits extends readonly AnyTrait[],
  Ops extends Readonly<Record<string, AnyUnboundOperation>>,
> = Entity<Name, Fields, Ops> &
  FlattenedTraitFields<Traits> & {
    readonly fields: StampedMap<Name, Fields> & FlattenedTraitFields<Traits>;
    readonly traits: Traits;
    readonly [OwnedOperations]: BoundOwnerOperations<
      Entity<Name, Fields, Ops> & {
        readonly fields: StampedMap<Name, Fields> & FlattenedTraitFields<Traits>;
        readonly traits: Traits;
        readonly [COMPOSED_TRAITS]: ComposedTraitMap<
          TraitClosure<Traits[number]>
        >;
      },
      Ops
    >;
    readonly [COMPOSED_TRAITS]: ComposedTraitMap<TraitClosure<Traits[number]>>;
  };

type EntityOperationContext<
  Name extends string,
  Fields extends FieldMap,
  Traits extends readonly AnyTrait[],
> = {
  readonly _tag: "Entity";
  readonly ns: Name;
  readonly fields: StampedMap<Name, Fields> & FlattenedTraitFields<Traits>;
  readonly traits: Traits;
  readonly [COMPOSED_TRAITS]: ComposedTraitMap<TraitClosure<Traits[number]>>;
};

/** Group fields under one ident prefix. */
export function Entity<const Name extends string, Fields extends FieldMap>(
  name: ValidIdentName<Name>,
  fields: Fields & ValidFieldMap<Fields>,
): Entity<Name, Fields>;
export function Entity<
  const Name extends string,
  Fields extends FieldMap,
  const Ops extends Readonly<Record<string, AnyUnboundOperation>> = {},
>(
  name: ValidIdentName<Name>,
  fields: Fields & ValidFieldMap<Fields>,
  options: {
    readonly traits?: never;
    readonly doc?: string;
    readonly operations: (
      Operation: OwnedOperationAuthor<
        EntityOperationContext<Name, Fields, readonly []>
      >,
    ) => ValidOwnedOperationMap<
      Ops,
      EntityOperationContext<Name, Fields, readonly []>
    > & Ops;
  },
): EntityWithTraits<Name, Fields, readonly [], Ops>;
export function Entity<
  const Name extends string,
  Fields extends FieldMap,
  const Traits extends readonly AnyTrait[] = [],
  const Ops extends Readonly<Record<string, AnyUnboundOperation>> = {},
>(
  name: ValidIdentName<Name>,
  fields: Fields & ValidFieldMap<Fields>,
  options: {
    readonly traits: Traits;
    readonly doc?: string;
    readonly operations: (
      Operation: OwnedOperationAuthor<EntityOperationContext<Name, Fields, Traits>>,
    ) => ValidOwnedOperationMap<
      Ops,
      EntityOperationContext<Name, Fields, Traits>
    > & Ops;
  } & ValidTraitCompose<Fields, Traits>,
): EntityWithTraits<Name, Fields, Traits, Ops>;
export function Entity<
  const Name extends string,
  Fields extends FieldMap,
  const Traits extends readonly AnyTrait[] = [],
>(
  name: ValidIdentName<Name>,
  fields: Fields & ValidFieldMap<Fields>,
  options: {
    readonly traits?: Traits;
    readonly doc?: string;
    readonly operations?: never;
  } & ValidTraitCompose<Fields, Traits>,
): EntityWithTraits<Name, Fields, Traits, {}>;
export function Entity<
  const Name extends string,
  Fields extends FieldMap,
  const Traits extends readonly AnyTrait[] = [],
  const Ops extends Readonly<Record<string, AnyUnboundOperation>> = {},
>(
  name: ValidIdentName<Name>,
  fields: Fields & ValidFieldMap<Fields>,
  options?: EntityImplementationOptions<Traits, Ops> &
    ValidTraitCompose<Fields, Traits>,
): Entity<Name, Fields, Ops> | EntityWithTraits<Name, Fields, Traits, Ops> {
  assertEntityName(name);
  assertFieldKeys(fields);
  const direct = (options?.traits ?? []) as readonly ComposerLike[];
  const traitClosure = walkTraits(direct).all;
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
  const doc = normalizeDoc(options?.doc);
  const entity = {
    _tag: "Entity" as const,
    ns: name,
    [DOCUMENTATION]: doc,
    fields: merged,
    traits: direct,
    [COMPOSED_TRAITS]: Object.fromEntries(
      traitClosure.map((trait) => [trait.ns, true]),
    ),
    [OwnedOperations]: {},
    id: idField,
    ...merged,
  };
  const operationAuthor =
    typeof options?.operations === "function"
      ? ownedOperationAuthor<EntityOperationContext<Name, Fields, Traits>>()
      : undefined;
  const operationSpecs =
    typeof options?.operations === "function"
      ? options.operations(operationAuthor!)
      : options?.operations;
  (entity as { [OwnedOperations]: unknown })[OwnedOperations] = bindOwnedOperations(
    entity as unknown as Entity<Name, Fields, Ops> & {
      readonly fields: StampedMap<Name, Fields> & FlattenedTraitFields<Traits>;
      readonly traits: Traits;
    },
    operationSpecs,
    operationAuthor,
  );
  return entity as unknown as
    | Entity<Name, Fields, Ops>
    | EntityWithTraits<Name, Fields, Traits, Ops>;
}

export type FieldOf<
  N extends AnyEntity,
  K extends keyof N["fields"],
> = N["fields"][K];

export type IdentOf<
  N extends AnyEntity,
  K extends keyof N["fields"] & string,
> = N["fields"][K] extends { readonly ident: infer I extends string }
  ? I
  : `:${N["ns"]}/${K}`;
