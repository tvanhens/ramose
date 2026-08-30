/**
 * Explicitly defined, schema-checked operations — the typed write path.
 *
 * An operation is a named value: input/output are `effect/Schema`, the body
 * is an async function. Transaction verbs accumulate one authoritative
 * commit; `op.effect` is a server-side side-effect step.
 *
 * Portable: this module is on `ramose/db` and must not import the Worker
 * or the engine barrel.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  allocationSlots,
  type AllocationDeclaration,
  type AllocationSlots,
} from "./allocations.ts";
import {
  normalizeProjectionRevision,
  type AnyOptimisticProjection,
  type OptimisticProjection,
} from "./Projection.ts";
import type { EntityId as OpaqueEntityId } from "./refs.ts";
import { COMPOSED_TRAITS } from "./Composer.ts";
import { normalizeDoc } from "./documentation.ts";
import type { Eid } from "./Eid.ts";
import type { AnySchema } from "./Schema.ts";
import { InvalidRequest, OperationsCoverageError } from "./Errors.ts";
import type { AnyEntity } from "./Entity.ts";
import type { AnyTrait } from "./Trait.ts";
import type { Tempid } from "./entityArg.ts";
import { invalidIdentName, isIdentName, type ValidIdentName } from "./IdentName.ts";
import type { EntityRef, LookupRef, UnbrandedId } from "./idents.ts";
import type { AnyQueryObject, QueryObject } from "./query/index.ts";
import { untargetedRef } from "./valueTypes.ts";
import {
  type PutAttrs,
  type PutCreateAttrs,
  type PutSubject,
  type TxEntity,
  type TxField,
  type TxHandle,
  type TxKnownEntity,
  type TxValue,
  type UpdateMapAttrs,
} from "./Tx.ts";

/**
 * `true` when `C` is a concrete catalog (keys are entity names). The
 * `AnySchema` bound is `Record<string, …>` — `string extends keyof` — and
 * `TxValue` against that bound is `never`.
 */
type ConcreteCatalog<C extends AnySchema> = string extends keyof C["entities"]
  ? false
  : true;

type OpKnownEntity<C extends AnySchema> = [ConcreteCatalog<C>] extends [true]
  ? TxKnownEntity<C>
  : AnyEntity;

type OpPutAttrs<C extends AnySchema, E extends AnyEntity> =
  [ConcreteCatalog<C>] extends [true]
    ? PutAttrs<C, E, TxHandle<C> | AnyOpHandle<C>>
    : Record<string, unknown>;

type OpPutCreateAttrs<C extends AnySchema, E extends AnyEntity> =
  [ConcreteCatalog<C>] extends [true]
    ? PutCreateAttrs<C, E, TxHandle<C> | AnyOpHandle<C>>
    : Record<string, unknown>;

type OpUpdateMapAttrs<C extends AnySchema, E extends AnyEntity> =
  [ConcreteCatalog<C>] extends [true]
    ? UpdateMapAttrs<C, E, TxHandle<C> | AnyOpHandle<C>>
    : Record<string, unknown>;

/**
 * Field slot on the op handle. Same union as {@link TxField} once the
 * catalog is known. Against the open `AnySchema` bound: a field ref or
 * an ident string (`":user/name"`), matching `TxField`'s two spellings.
 */
export type OpField<C extends AnySchema> = [ConcreteCatalog<C>] extends [true]
  ? TxField<C>
  : { readonly ident: string } | string;

type FieldRefValue<C extends AnySchema, A> = A extends {
  readonly schema: { readonly Type: infer T };
}
  ? T | (A extends { readonly valueType: "ref" } ? EntityRef<C, AnyEntity, TxHandle<C> | AnyOpHandle<C>> : never)
  : unknown;

/**
 * Value correlated to an {@link OpField}. Delegates to {@link TxValue}
 * on a concrete catalog — ref fields use the shared {@link EntityRef}
 * vocabulary (no bare `string`). Against `AnySchema`, a field ref uses
 * its Schema type; an ident string is `unknown`.
 */
export type OpValue<C extends AnySchema, A> = [ConcreteCatalog<C>] extends [true]
  ? TxValue<C, A, TxHandle<C> | AnyOpHandle<C>>
  : FieldRefValue<C, A>;

/**
 * Entity slot on the op handle. Same bag as {@link TxEntity}, plus any
 * {@link OpHandle} — including contextual `self` (`Eid<N> | Tempid`).
 */
export type OpEntity<C extends AnySchema> = TxEntity<C> | AnyOpHandle<C>;

type OpPutSubject<C extends AnySchema, E extends AnyEntity> =
  [ConcreteCatalog<C>] extends [true]
    ? PutSubject<C, E, TxHandle<C> | AnyOpHandle<C>>
    : OpEntity<C>;

/**
 * A contextual operation's entity — the shared {@link EntityRef} vocabulary,
 * narrowed to `N`. A branded cell of the wrong entity is rejected. The
 * unbranded-number hatch remains (mint-by-id). Bare `string` does not —
 * pass {@link Tempid} (`op.tempid("ada")` / `tempid("ada")`).
 */
export type RunEntity<C extends AnySchema, N extends AnyEntity> = EntityRef<
  C,
  N,
  TxHandle<C> | AnyOpHandle<C>
>;

/**
 * Distributes over a union `C` so every member must cover `OC`. A
 * `Movies | Alt` db therefore rejects a Movies-bound op; a superset db
 * (extra entity keys) accepts it.
 */
type CatalogCovers<C extends AnySchema, OC extends AnySchema> = C extends AnySchema
  ? keyof OC["entities"] extends keyof C["entities"]
    ? true
    : false
  : false;

/**
 * Whether operation catalog `OC` may run on db catalog `C`. A schema-less
 * op (open `AnySchema` bound) runs anywhere; a `schema:`-bound op runs on
 * a db that has at least that catalog's entity keys.
 */
export type OpCatalogFitsDb<
  C extends AnySchema,
  OC extends AnySchema,
> = [ConcreteCatalog<OC>] extends [false]
  ? true
  : CatalogCovers<C, OC> extends true
    ? true
    : false;

/** Parameter type when {@link OpCatalogFitsDb} is false — names the catalog. */
export type OpCatalogMismatch = "operation schema does not match this db";

/** `I` / entity argument, or {@link OpCatalogMismatch} when the catalogs diverge. */
export type RunArg<C extends AnySchema, OC extends AnySchema, A> =
  OpCatalogFitsDb<C, OC> extends true ? A : OpCatalogMismatch;

/**
 * Schema for an entity id in operation input / output.
 *
 * The decoded type is `number`, which is the *private* eid the authoritative
 * writer works in. A body may return a handle (or `{ id: handle }`) in an
 * `EntityId` slot; authoritative execution resolves it after the writer assigns
 * eids. What crosses the operation boundary is never that number: the public
 * projection seals every `EntityId` position of the result into the opaque
 * {@link EntityId} handle below. Sealing is deterministic per
 * `(root, scope, eid)`, so that is byte-identical to the handle an allocation
 * mapping returns and to the one logical replication binds to the same entity
 * in the same scope — one identity, three carriers (#475, #477).
 */
export const EntityId: typeof untargetedRef = untargetedRef;

/**
 * The opaque public handle that fills an {@link EntityId} slot.
 *
 * The value above declares the *slot*; this type is the durable, entity-branded
 * identity that travels through it — the sealed server-issued handle a queued
 * mutation may name as its target, never a numeric eid. Declaring both under
 * one name is deliberate: `Ramose.EntityId` is the entity id, whether an author
 * is writing a schema or typing a handle they were given.
 */
export type EntityId<Entity extends AnyEntity = AnyEntity> = OpaqueEntityId<
  Entity
>;

/**
 * What a body may return for output type `O`: a handle is legal
 * wherever the schema expects a number (an {@link EntityId} slot).
 */
export type OutputDraft<O> = O extends number
  ? O | { readonly _tag: "TxHandle" }
  : O extends ReadonlyArray<infer U>
    ? { readonly [K in keyof O]: OutputDraft<U> }
    : O extends object
      ? { [K in keyof O]: OutputDraft<O[K]> }
      : O;

/** Who the body sees as the caller. `eid` is `null` until the principal row exists. */
export interface OpPrincipal {
  readonly eid: number | null;
  readonly class: string;
  readonly sub?: string;
  readonly name?: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

/**
 * What an `op.effect` thunk receives during authoritative execution.
 */
export interface OperationEffectContext {
  /** Worker env (bindings, secrets). Opaque on the portable surface. */
  readonly env: unknown;
  readonly principal: OpPrincipal;
}

export type EffectThunk<A = unknown> = (
  ctx: OperationEffectContext,
) => Promise<A> | A;

/** Id a non-contextual handle names — unbranded so it is valid in any ref slot. */
export type OpHandleId<C extends AnySchema = AnySchema> =
  | UnbrandedId
  | Tempid
  | LookupRef<C>;

/**
 * Entity handle a body writes through. Promise-surface twin of
 * {@link TxHandle}: same field / value / entity slots, methods return
 * `void` instead of `Effect`. `Id` defaults to {@link OpHandleId};
 * contextual `self` specializes it to `Eid<N> | Tempid`.
 */
export interface OpHandle<
  C extends AnySchema = AnySchema,
  Id = OpHandleId<C>,
> {
  readonly _tag: "TxHandle";
  readonly eid: Id;
  set<const A extends OpField<C>>(field: A, value: OpValue<C, A>): void;
  remove<const A extends OpField<C>>(field: A, value?: OpValue<C, A>): void;
  delete(): void;
}

/** Any handle, including contextual `self`. */
export type AnyOpHandle<C extends AnySchema = AnySchema> = OpHandle<C, any>;

/** Entity or trait that canonically owns an operation. */
export type OperationOwner = AnyEntity | AnyTrait;

/**
 * Symbol-keyed operation metadata. A symbol preserves the long-standing right
 * to declare an ordinary schema field named `operations`.
 */
export const OwnedOperations: unique symbol = Symbol.for(
  "ramose/owned-operations",
);

declare const OwnedOperationOwnerBrand: unique symbol;
declare const OwnedOpContextBrand: unique symbol;
const OwnedOperationAuthorToken: unique symbol = Symbol(
  "ramose/owned-operation-author-token",
);

type OperationOwnerShape = {
  readonly _tag: "Entity" | "Trait";
  readonly ns: string;
  readonly fields: object;
};

type MutableField<Definition extends OperationOwnerShape> = Definition["fields"][
  keyof Definition["fields"] & string
] extends infer Field
  ? Field extends { readonly ident: string }
    ? Field extends { readonly fixed: true }
      ? never
      : Field
    : never
  : never;

type TraitComposerEntity<Target extends AnyTrait> = AnyEntity & {
  readonly [COMPOSED_TRAITS]: {
    readonly [Name in Target["ns"]]: true;
  };
};

type OwnedInvocationEntity<Owner extends OperationOwnerShape> =
  Owner extends { readonly _tag: "Entity" }
    ? Owner & AnyEntity
    : Owner extends { readonly _tag: "Trait" }
      ? TraitComposerEntity<Owner & AnyTrait>
      : never;

type OwnedHandleRef<Target extends AnyEntity> = {
  readonly _tag: "TxHandle";
  readonly eid: Eid<Target> | Tempid;
};

type OwnedFieldValue<
  Owner extends OperationOwnerShape,
  A,
> = A extends {
  readonly valueType: "ref";
  readonly schema: { readonly _target?: infer Target };
}
  ? Exclude<Target, undefined> extends infer Declared
    ? Declared extends AnyEntity
      ? EntityRef<AnySchema, Declared, OwnedHandleRef<Declared>>
      : Declared extends AnyTrait
        ? EntityRef<
            AnySchema,
            TraitComposerEntity<Declared>,
            OwnedHandleRef<TraitComposerEntity<Declared>>
          >
        : Owner extends { readonly _tag: "Entity" }
          ? EntityRef<
              AnySchema,
              OwnedInvocationEntity<Owner>,
              OwnedHandleRef<OwnedInvocationEntity<Owner>>
            >
          : Owner extends { readonly _tag: "Trait" }
            ? EntityRef<
                AnySchema,
                OwnedInvocationEntity<Owner>,
                OwnedHandleRef<OwnedInvocationEntity<Owner>>
              >
            : EntityRef<AnySchema, AnyEntity, AnyOpHandle>
    : never
  : OpValue<AnySchema, A>;

type EntityIdentity<Entity extends AnyEntity> = Pick<
  Entity,
  "_tag" | "ns" | "fields"
> &
  Pick<
    AnyEntity,
    "id" | typeof COMPOSED_TRAITS | typeof OwnedOperations
  >;

type EntityRefOf<Entity extends AnyEntity> = EntityRef<
  AnySchema,
  EntityIdentity<Entity>,
  OwnedHandleRef<EntityIdentity<Entity>>
>;

/** Entity-specialized handle returned by definition-directed writes. */
export type OwnedEntityHandle<Entity extends AnyEntity> = Omit<
  OpHandle<AnySchema>,
  "eid" | "set" | "remove"
> & {
  readonly eid: Eid<Entity> | Tempid;
  set<const A extends MutableField<Entity>>(
    field: A,
    value: OwnedFieldValue<Entity, A>,
  ): void;
  remove<const A extends MutableField<Entity>>(
    field: A,
    value?: OwnedFieldValue<Entity, A>,
  ): void;
};

/** A targeted handle only accepts fields carried by its canonical owner. */
export type OwnedTargetHandle<Owner extends OperationOwnerShape> = Omit<
  OpHandle<AnySchema>,
  "eid" | "set" | "remove"
> & {
  readonly eid: Eid<OwnedInvocationEntity<Owner>> | Tempid;
  set<const A extends MutableField<Owner>>(
    field: A,
    value: OwnedFieldValue<Owner, A>,
  ): void;
  remove<const A extends MutableField<Owner>>(
    field: A,
    value?: OwnedFieldValue<Owner, A>,
  ): void;
};

type OwnerEntity<Owner extends OperationOwnerShape> = Owner extends {
  readonly _tag: "Entity";
  readonly fields: AnyEntity["fields"];
}
  ? Owner &
      Pick<
        AnyEntity,
        "id" | typeof COMPOSED_TRAITS | typeof OwnedOperations
      >
  : never;

type DefinitionWriteEntity<
  Owner extends OperationOwnerShape,
  Writes extends readonly AnyEntity[],
> = OwnerEntity<Owner> | Writes[number];

type DecodedFieldValue<Field> = Field extends {
  readonly schema: { readonly Type: infer Value };
}
  ? Value
  : unknown;

type FieldIsOptional<Field> = Field extends { readonly cardinality: "many" }
  ? true
  : Field extends { readonly isOptional: true }
    ? true
    : Field extends { readonly default: (...args: never[]) => unknown }
      ? true
      : Field extends { readonly compositionDefault: true }
        ? true
        : undefined extends DecodedFieldValue<Field>
          ? true
          : false;

type MutableKeys<Entity extends AnyEntity> = {
  [K in keyof Entity["fields"] & string]: Entity["fields"][K] extends {
    readonly fixed: true;
  }
    ? never
    : K;
}[keyof Entity["fields"] & string];

type RequiredCreateKeys<Entity extends AnyEntity> = {
  [K in MutableKeys<Entity>]: FieldIsOptional<Entity["fields"][K]> extends true
    ? never
    : K;
}[MutableKeys<Entity>];

type OptionalCreateKeys<Entity extends AnyEntity> = Exclude<
  MutableKeys<Entity>,
  RequiredCreateKeys<Entity>
>;

type DefinitionWriteValue<
  Entity extends AnyEntity,
  K extends keyof Entity["fields"] & string,
> = Entity["fields"][K] extends infer Field
  ? Field extends { readonly cardinality: "many" }
    ? ReadonlyArray<OwnedFieldValue<Entity, Field>>
    : OwnedFieldValue<Entity, Field>
  : never;

type FixedAttrs<Entity extends AnyEntity> = {
  [K in keyof Entity["fields"] & string as Entity["fields"][K] extends {
    readonly fixed: true;
  }
    ? K
    : never]?: never;
};

type CreateAttrsForEntity<Entity extends AnyEntity> = {
  [K in RequiredCreateKeys<Entity>]: DefinitionWriteValue<Entity, K>;
} & {
  [K in OptionalCreateKeys<Entity>]?: DefinitionWriteValue<Entity, K> | undefined;
} & FixedAttrs<Entity>;

type CreateAttrsOf<Entity extends AnyEntity> = Entity extends AnyEntity
  ? CreateAttrsForEntity<Entity>
  : never;

type MutableAttrsForEntity<Entity extends AnyEntity> = {
  [K in MutableKeys<Entity>]?: DefinitionWriteValue<Entity, K> | undefined;
} & FixedAttrs<Entity>;

type MutableAttrsOf<Entity extends AnyEntity> = Entity extends AnyEntity
  ? MutableAttrsForEntity<Entity>
  : never;

type UpsertKeys<Entity extends AnyEntity> = {
  [K in MutableKeys<Entity>]: Entity["fields"][K] extends {
    readonly unique: "upsert";
  }
    ? K
    : never;
}[MutableKeys<Entity>];

type RequireAtLeastOne<T, Keys extends keyof T> = {
  [K in Keys]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[Keys];

type UpdateMapAttrsForEntity<Entity extends AnyEntity> = [
  UpsertKeys<Entity>,
] extends [never]
  ? { readonly "update map form needs a unique: \"upsert\" field": never }
  : RequireAtLeastOne<
      MutableAttrsOf<Entity>,
      UpsertKeys<Entity> & keyof MutableAttrsOf<Entity>
    >;

/** Complete create input for an entity owner, including flattened trait fields. */
type OwnerCreateAttrs<Owner extends OperationOwnerShape> = Owner extends {
  readonly _tag: "Entity";
  readonly fields: AnyEntity["fields"];
}
  ? CreateAttrsOf<OwnerEntity<Owner>>
  : never;

type OwnedEntityRef<Owner extends OperationOwnerShape> = EntityRef<
  AnySchema,
  OwnedInvocationEntity<Owner>,
  OwnedHandleRef<OwnedInvocationEntity<Owner>>
>;

/**
 * Operation body surface after an owner map binds the definition.
 * Targetless entity operations gain `create`; targeted operations gain `self`.
 */
export type OwnedOp<
  Owner extends OperationOwnerShape,
  Self extends boolean,
  Writes extends readonly AnyEntity[] = readonly [],
> = Omit<
  Op<AnySchema, undefined>,
  "self" | "entity" | "set" | "remove" | "delete" | "put" | "update"
> & {
  readonly [OwnedOpContextBrand]: {
    readonly owner: Owner;
    readonly self: Self;
    readonly writes: Writes;
  };
  readonly self: Self extends true ? OwnedTargetHandle<Owner> : undefined;
  entity(id: OwnedEntityRef<Owner>): OwnedTargetHandle<Owner>;
  entity<const Entity extends DefinitionWriteEntity<Owner, Writes>>(
    definition: Entity,
    id: EntityRefOf<NoInfer<Entity>>,
  ): OwnedEntityHandle<Entity>;
  set<
    const Entity extends DefinitionWriteEntity<Owner, Writes>,
    const A extends MutableField<NoInfer<Entity>>,
  >(
    definition: Entity,
    entity: EntityRefOf<NoInfer<Entity>>,
    field: A,
    value: OwnedFieldValue<NoInfer<Entity>, A>,
  ): void;
  remove<
    const Entity extends DefinitionWriteEntity<Owner, Writes>,
    const A extends MutableField<NoInfer<Entity>>,
  >(
    definition: Entity,
    entity: EntityRefOf<NoInfer<Entity>>,
    field: A,
    value?: OwnedFieldValue<NoInfer<Entity>, A>,
  ): void;
  delete<const Entity extends DefinitionWriteEntity<Owner, Writes>>(
    definition: Entity,
    entity: EntityRefOf<NoInfer<Entity>>,
  ): void;
  put<const Entity extends DefinitionWriteEntity<Owner, Writes>>(
    ...args: Entity extends AnyEntity
      ? [entity: Entity, attrs: CreateAttrsForEntity<NoInfer<Entity>>]
      : never
  ): OwnedEntityHandle<Entity>;
  put<const Entity extends DefinitionWriteEntity<Owner, Writes>>(
    ...args: Entity extends AnyEntity
      ? [
          entity: Entity,
          id: EntityRefOf<NoInfer<Entity>>,
          attrs: MutableAttrsForEntity<NoInfer<Entity>>,
        ]
      : never
  ): OwnedEntityHandle<Entity>;
  update<const Entity extends DefinitionWriteEntity<Owner, Writes>>(
    ...args: Entity extends AnyEntity
      ? [entity: Entity, attrs: UpdateMapAttrsForEntity<NoInfer<Entity>>]
      : never
  ): OwnedEntityHandle<Entity>;
  update<const Entity extends DefinitionWriteEntity<Owner, Writes>>(
    ...args: Entity extends AnyEntity
      ? [
          entity: Entity,
          id: EntityRefOf<NoInfer<Entity>>,
          attrs: MutableAttrsForEntity<NoInfer<Entity>>,
        ]
      : never
  ): OwnedEntityHandle<Entity>;
  readonly create: Self extends false
    ? Owner extends { readonly _tag: "Entity" }
      ? (attrs: OwnerCreateAttrs<Owner>) => OwnedEntityHandle<OwnerEntity<Owner>>
      : undefined
    : undefined;
};

/** Context available while an operation is still waiting for its owner map. */
type UnboundOwnedOp<Self extends boolean> = Omit<Op<AnySchema, undefined>, "self"> & {
  readonly self: Self extends true ? unknown : undefined;
  readonly create: Self extends false
    ? ((...args: never[]) => OpHandle<AnySchema>) | undefined
    : undefined;
};

/**
 * The handle an authoritative operation body uses. Transaction verbs
 * accumulate one commit. Write slots are {@link TxField} / {@link TxValue} / {@link TxEntity}
 * (thin aliases when the catalog is concrete).
 */
export interface Op<
  C extends AnySchema = AnySchema,
  N extends AnyEntity | undefined = undefined,
> {
  /**
   * The entity a contextual operation is bound to (`on: Entity`).
   * Absent on a non-contextual operation. `eid` is the `on` cell — an
   * {@link Eid} or a {@link Tempid} supplied by the authoritative invocation.
   */
  readonly self: [N] extends [AnyEntity]
    ? OpHandle<C, Eid<N> | Tempid>
    : undefined;
  /** The authenticated caller. */
  readonly principal: OpPrincipal;
  /** Database name this invocation is bound to. */
  readonly db: string;

  entity(): OpHandle<C>;
  entity(id: OpEntity<C>): OpHandle<C>;
  /** Brand a string as a named tempid. Not a bare `string`. */
  tempid(name: string): Tempid;
  set<const A extends OpField<C>>(
    e: OpEntity<C>,
    field: A,
    value: OpValue<C, A>,
  ): void;
  remove<const A extends OpField<C>>(
    e: OpEntity<C>,
    field: A,
    value?: OpValue<C, A>,
  ): void;
  delete(e: OpEntity<C>): void;

  /**
   * Make this row so. Lowers to map form. `undefined` fields are
   * omitted; cardinality-many takes an array. No subject allocates a
   * new record and the map must carry every required field. A numeric
   * subject names an existing record — a missing id is
   * `TxRejected` `tx/missing-entity` (same as {@link Op.update}; naming
   * never creates). A tempid / handle subject is a create.
   *
   * Including a `unique: "upsert"` field unifies with the existing row
   * — insert-or-update, still with full required data on create.
   * Partial writes to an existing row are {@link Op.update}.
   *
   * A two-element array whose first value is an ident (`":…"`) is a
   * lookup on a ref field. On a cardinality-many scalar field, that
   * shape is expanded to one value per element so `tags: [":a", "b"]`
   * writes two strings.
   */
  put<E extends OpKnownEntity<C>>(
    entity: E,
    attrs: OpPutCreateAttrs<C, E>,
  ): OpHandle<C>;
  put<E extends OpKnownEntity<C>>(
    entity: E,
    id: OpPutSubject<C, E>,
    attrs: OpPutAttrs<C, E>,
  ): OpHandle<C>;

  /**
   * Change what's there. Partial; never creates. Address by subject
   * (eid / handle / branded cell / lookup) or by a map that contains
   * at least one `unique: "upsert"` field. Missing row →
   * `TxRejected` `tx/missing-entity`. Wrong-entity subject →
   * `tx/wrong-entity`.
   */
  update<E extends OpKnownEntity<C>>(
    entity: E,
    attrs: OpUpdateMapAttrs<C, E>,
  ): OpHandle<C>;
  update<E extends OpKnownEntity<C>>(
    entity: E,
    id: OpPutSubject<C, E>,
    attrs: OpPutAttrs<C, E>,
  ): OpHandle<C>;

  query<Row, Out = readonly Row[]>(
    input: QueryObject<Row, Out>,
  ): Promise<Out>;
  query(input: AnyQueryObject): Promise<unknown>;

  pull(subject: unknown, pattern: unknown): Promise<unknown>;

  /**
   * A named authoritative side-effect step, executed with
   * {@link OperationEffectContext}.
   */
  effect<A>(name: string, run: EffectThunk<A>): Promise<A>;
}

export interface Operation<
  Name extends string = string,
  I = unknown,
  O = unknown,
  N extends AnyEntity | undefined = undefined,
  C extends AnySchema = AnySchema,
> {
  readonly _tag: "Operation";
  readonly name: Name;
  readonly input: Schema.Codec<I, unknown>;
  readonly output: Schema.Codec<O, unknown>;
  readonly on: N | undefined;
  /** Humans read this in the docs; later MCP uses it as the tool description. */
  readonly doc: string | undefined;
  readonly body: (op: Op<C, N>, input: I) => Promise<OutputDraft<O>> | OutputDraft<O>;
}

export type AnyOperation = Operation<string, any, any, any, any>;

type CodecType<S> = S extends { readonly Type: infer T } ? T : unknown;

type NormalizeOwnedSelf<Self extends boolean> = boolean extends Self
  ? boolean
  : Self extends false
    ? false
    : true;

type OwnedRun<
  Owner extends OperationOwnerShape,
  ICodec extends Schema.Top,
  OCodec extends Schema.Top,
  Self extends boolean,
  Writes extends readonly AnyEntity[],
> = (
  op: OwnedOp<Owner, Self, Writes>,
  input: CodecType<ICodec>,
) => Promise<OutputDraft<CodecType<OCodec>>> | OutputDraft<CodecType<OCodec>>;

type UnboundOwnedRun<
  ICodec extends Schema.Top,
  OCodec extends Schema.Top,
  Self extends boolean,
> = (
  op: UnboundOwnedOp<Self>,
  input: CodecType<ICodec>,
) => Promise<OutputDraft<CodecType<OCodec>>> | OutputDraft<CodecType<OCodec>>;

/** Owner-map authoring form before Entity/Trait supplies canonical ownership. */
export interface UnboundOperation<
  ICodec extends Schema.Top = Schema.Top,
  OCodec extends Schema.Top = Schema.Top,
  Self extends boolean = boolean,
  Writes extends readonly AnyEntity[] = readonly AnyEntity[],
> {
  readonly _tag: "UnboundOperation";
  readonly input: ICodec;
  readonly output: OCodec;
  /** `true` by default; `false` removes both the invocation target and `op.self`. */
  readonly self: Self;
  /** Additional entity definitions made reachable and typed for authoring. */
  readonly writes: Writes;
  /**
   * Canonically ordered client-ref allocation slots (#475). Inert data: it
   * names output positions an offline client may address before the server has
   * committed them, and carries nothing executable.
   */
  readonly allocations: AllocationSlots;
  /** Author-declared executable revision; `1` when undeclared. */
  readonly revision: number;
  /**
   * The optional pure optimistic projection (#476). Trusted client-bundle
   * code, never serialized, inferred, or interpreted; `undefined` when the
   * operation declares none, in which case it still queues normally.
   */
  readonly optimistic: AnyOptimisticProjection | undefined;
  /** Author-declared projection revision; `1` when undeclared. */
  readonly optimisticRevision: number;
  readonly doc: string | undefined;
  readonly run: UnboundOwnedRun<ICodec, OCodec, Self>;
}

export type AnyUnboundOperation = UnboundOperation<
  Schema.Top,
  Schema.Top,
  boolean,
  readonly AnyEntity[]
>;

type OwnerAuthoredOperation<
  Owner extends OperationOwnerShape,
  ICodec extends Schema.Top = Schema.Top,
  OCodec extends Schema.Top = Schema.Top,
  Self extends boolean = boolean,
  Writes extends readonly AnyEntity[] = readonly AnyEntity[],
> = UnboundOperation<ICodec, OCodec, Self, Writes> & {
  readonly [OwnedOperationOwnerBrand]: Owner;
  readonly [OwnedOperationAuthorToken]: object;
};

/** Public operation value after its enclosing owner and local map key bind it. */
export interface OwnedOperation<
  Owner extends OperationOwner = OperationOwner,
  LocalName extends string = string,
  ICodec extends Schema.Top = Schema.Top,
  OCodec extends Schema.Top = Schema.Top,
  Self extends boolean = boolean,
  Writes extends readonly AnyEntity[] = readonly AnyEntity[],
> {
  readonly _tag: "OwnedOperation";
  readonly owner: Owner;
  readonly localName: LocalName;
  readonly input: ICodec;
  readonly output: OCodec;
  readonly self: Self;
  readonly writes: Writes;
  /** Canonically ordered client-ref allocation slots (#475). */
  readonly allocations: AllocationSlots;
  /** Author-declared executable revision; `1` when undeclared. */
  readonly revision: number;
  /** The optional pure optimistic projection (#476); `undefined` when none. */
  readonly optimistic: AnyOptimisticProjection | undefined;
  /** Author-declared projection revision; `1` when undeclared. */
  readonly optimisticRevision: number;
  readonly doc: string | undefined;
  readonly run: OwnedRun<Owner, ICodec, OCodec, Self, Writes>;
}

/** Erased owned operation used by registries without losing concrete assignability. */
export type AnyOwnedOperation = {
  readonly _tag: "OwnedOperation";
  readonly owner: OperationOwner;
  readonly localName: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  readonly self: boolean;
  readonly writes: readonly AnyEntity[];
  readonly allocations: AllocationSlots;
  readonly revision: number;
  readonly optimistic: AnyOptimisticProjection | undefined;
  readonly optimisticRevision: number;
  readonly doc: string | undefined;
  readonly run: (...args: never[]) => unknown;
};

type BoundOwnedOperation<
  Owner extends OperationOwner,
  LocalName extends string,
  Spec,
> = Spec extends UnboundOperation<
  infer ICodec,
  infer OCodec,
  infer Self,
  infer Writes
>
  ? OwnedOperation<Owner, LocalName, ICodec, OCodec, Self, Writes>
  : never;

/** Owner-map values after their enclosing Entity/Trait binds them. */
export type BoundOwnerOperations<
  Owner extends OperationOwner,
  Ops extends Readonly<Record<string, AnyUnboundOperation>>,
> = {
  readonly [K in keyof Ops]: BoundOwnedOperation<Owner, K & string, Ops[K]>;
};

type InvalidOperationName<K extends string> = {
  readonly [P in `invalid operation name ${K}`]: true;
};

/** Type-level operation-key and value validation for Entity/Trait options. */
export type ValidOwnedOperationMap<
  Ops extends Readonly<Record<string, AnyUnboundOperation>>,
  Owner extends OperationOwnerShape,
> = string extends keyof Ops
  ? never
  : {
      readonly [K in keyof Ops]: K extends string
        ? K extends ValidIdentName<K>
          ? Ops[K] extends { readonly [OwnedOperationOwnerBrand]: Owner }
            ? Ops[K]
            : never
          : Ops[K] & InvalidOperationName<K>
        : never;
    };

export interface Operations<
  M extends Record<string, AnyOperation> = Record<string, AnyOperation>,
> {
  readonly _tag: "Operations";
  readonly operations: M;
  /** Catalog this registry was bound to, when built with {@link defineOperations}. */
  readonly schema?: AnySchema;
  /** Resolve by the operation's declared `name` (not the registry key). */
  get(name: string): AnyOperation | undefined;
  /** Sorted unique wire ids (`issue/move`). */
  names(): readonly string[];
  /** Id + doc + entity ns — the projection later MCP `learn` reads. */
  cards(): readonly OperationCard[];
}

export type AnyOperations = Operations<Record<string, AnyOperation>>;

/** A catalog-bound registry — {@link defineOperations}'s return. */
export interface DefinedOperations<
  C extends AnySchema,
  M extends Record<string, AnyOperation> = Record<string, AnyOperation>,
> extends Operations<M> {
  readonly schema: C;
}

/**
 * One registered operation, as discovery later reads it. Name is the
 * wire id; `doc` is the human / tool description; `on` is the entity ns
 * when the op is contextual.
 */
export interface OperationCard {
  readonly name: string;
  readonly doc?: string;
  readonly on?: string;
}

export interface OperationSchemas<
  I,
  O,
  N extends AnyEntity | undefined = undefined,
  C extends AnySchema = AnySchema,
> {
  readonly input: Schema.Codec<I, unknown>;
  readonly output?: Schema.Codec<O, unknown>;
  readonly on?: N;
  /**
   * Type-only: binds the body's write slots to this catalog, not carried
   * at runtime.
   */
  readonly schema?: C;
  /** Humans read this in the docs; later MCP uses it as the tool description. */
  readonly doc?: string;
}

/** `on` must be an entity of `C` once `schema:` is a concrete catalog. */
type OnEntity<C extends AnySchema> = [ConcreteCatalog<C>] extends [true]
  ? C["entities"][keyof C["entities"]] | undefined
  : AnyEntity | undefined;

/** Concrete entity of `C` — {@link Operation.patch}'s `on` target. */
type CatalogEntity<C extends AnySchema> = [ConcreteCatalog<C>] extends [true]
  ? C["entities"][keyof C["entities"]]
  : AnyEntity;

const emptyOutput = Schema.Struct({});

/** Revision assumed when an operation declares none. */
export const DEFAULT_OPERATION_REVISION = 1;

/**
 * A declared projection is a function and nothing else. Refusing anything else
 * here — rather than at replay, on a device that is already offline — is what
 * keeps a durable layer's binding a lookup instead of a gamble.
 */
const normalizeOptimistic = (value: unknown): AnyOptimisticProjection | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "function") {
    throw new Error(
      "ramose/schema: an operation's optimistic projection must be a function",
    );
  }
  return value as AnyOptimisticProjection;
};

/**
 * Normalize the author-declared executable revision. The operation-scoped
 * compatibility version excludes executable source, so this is the author's
 * explicit control for rotating a behavior-only change.
 */
export const normalizeOperationRevision = (value: unknown): number => {
  if (value === undefined) return DEFAULT_OPERATION_REVISION;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `ramose/schema: operation revision must be a positive integer, not ${JSON.stringify(value)}`,
    );
  }
  return value;
};

/** Define one legacy standalone named operation. */
const defineNamedOperation = <
  Name extends string,
  I,
  O = {},
  C extends AnySchema = AnySchema,
  N extends OnEntity<C> = undefined,
>(
  name: Name,
  schemas: OperationSchemas<I, O, N, C>,
  body: (op: Op<C, N>, input: I) => Promise<OutputDraft<O>> | OutputDraft<O>,
): Operation<Name, I, O, N, C> => ({
  _tag: "Operation",
  name,
  input: schemas.input,
  output: (schemas.output ?? emptyOutput) as Schema.Codec<O, unknown>,
  on: schemas.on,
  doc: normalizeDoc(schemas.doc),
  body,
});

type OwnedOperationSpec<
  ICodec extends Schema.Top,
  OCodec extends Schema.Top,
  Self extends boolean,
  Writes extends readonly AnyEntity[],
  Context,
  Run,
> = {
  readonly input: ICodec;
  readonly output: OCodec;
  readonly self?: Self;
  readonly writes?: ValidWriteDefinitions<Writes>;
  /**
   * Named client-ref allocation slots (#475), each bound to an
   * entity-reference path in this operation's own declared output. Declare one
   * for every entity an offline client must be able to address before the
   * server has committed it; only entity-reference positions type-check, so a
   * slot cannot be bound to a title or a count.
   */
  readonly allocates?: AllocationDeclaration<OCodec>;
  /**
   * Author-declared executable revision (default `1`). The operation-scoped
   * compatibility version (#487) excludes executable source, so bumping this
   * is how an author rotates an operation whose declared input/output
   * contract is unchanged but whose behavior is not.
   */
  readonly revision?: number;
  /**
   * One optional pure optimistic projection (#476). It receives the validated
   * invocation input, this invocation's own target, and a transaction builder
   * — no local-database query, no Effect, no clock, and no server capability.
   *
   * It is a separate client-side declaration, never a serialized, inferred,
   * restricted, or interpreted form of `run`: the authoritative body stays
   * deployed server code and never crosses the client boundary.
   *
   * ```ts
   * optimistic: ({ input, tx }) => tx.set(input.issue, Issue.status, input.status)
   * ```
   */
  readonly optimistic?: OptimisticProjection<CodecType<ICodec>>;
  /**
   * Author-declared projection revision (default `1`). Bump it when the
   * projection no longer means what it meant; a durable layer minted under an
   * older revision then becomes the typed update-required state instead of
   * being replayed against incompatible code.
   *
   * It is independent of `revision` and of #487's `OperationVersion`, so
   * editing a projection never revokes a queued invocation's right to submit.
   */
  readonly optimisticRevision?: number;
  readonly doc?: string;
  readonly run: [Context] extends [never]
    ? UnboundOwnedRun<ICodec, OCodec, NormalizeOwnedSelf<Self>>
    : Context extends OperationOwnerShape
      ? OwnedRun<Context, ICodec, OCodec, NormalizeOwnedSelf<Self>, Writes> &
          Run &
          ExactRunContext<
            Run,
            OwnedOp<Context, NormalizeOwnedSelf<Self>, Writes>
          >
      : never;
};

type RunContext<Run> = Run extends (...args: infer Args) => unknown
  ? Args["length"] extends 0
    ? undefined
    : Args[0]
  : never;

type ExactRunContext<Run, Expected> = [RunContext<Run>] extends [undefined]
  ? unknown
  : [RunContext<Run>] extends [Expected]
    ? [Expected] extends [RunContext<Run>]
      ? unknown
      : never
    : never;

type IsUnion<T, Whole = T> = T extends unknown
  ? [Whole] extends [T]
    ? false
    : true
  : never;

type ValidWriteDefinitions<Writes extends readonly AnyEntity[]> =
  number extends Writes["length"]
    ? never
    : true extends IsUnion<Writes>
      ? never
      : Writes;

/**
 * Owner-bound constructor supplied to an Entity/Trait `operations` authoring
 * callback. Binding before the inner call is what lets TypeScript validate
 * `op.self` fields and complete entity creates against the canonical owner.
 */
export interface OwnedOperationAuthor<Owner extends OperationOwnerShape> {
  <
    const ICodec extends Schema.Top,
    const OCodec extends Schema.Top,
    const Self extends boolean = true,
    const Writes extends readonly AnyEntity[] = readonly [],
    const Run extends OwnedRun<
      Owner,
      ICodec,
      OCodec,
      NormalizeOwnedSelf<Self>,
      Writes
    > = OwnedRun<Owner, ICodec, OCodec, NormalizeOwnedSelf<Self>, Writes>,
  >(
    spec: OwnedOperationSpec<ICodec, OCodec, Self, Writes, Owner, Run>,
  ): OwnerAuthoredOperation<
    Owner,
    ICodec,
    OCodec,
    NormalizeOwnedSelf<Self>,
    Writes
  >;
  readonly [OwnedOperationAuthorToken]: object;
}

/** Unbound form; Entity/Trait supply an owner-bound constructor when needed. */
function defineOperation<
  const ICodec extends Schema.Top,
  const OCodec extends Schema.Top,
  const Self extends boolean = true,
  const Writes extends readonly AnyEntity[] = readonly [],
  const Run extends UnboundOwnedRun<
    ICodec,
    OCodec,
    NormalizeOwnedSelf<Self>
  > = UnboundOwnedRun<ICodec, OCodec, NormalizeOwnedSelf<Self>>,
>(
  spec: OwnedOperationSpec<ICodec, OCodec, Self, Writes, never, Run>,
): UnboundOperation<ICodec, OCodec, NormalizeOwnedSelf<Self>, Writes>;
/** Standalone form retained for the pre-authoritative local peer fixtures. */
function defineOperation<
  Name extends string,
  I,
  O = {},
  C extends AnySchema = AnySchema,
  N extends OnEntity<C> = undefined,
>(
  name: Name,
  schemas: OperationSchemas<I, O, N, C>,
  body: (op: Op<C, N>, input: I) => Promise<OutputDraft<O>> | OutputDraft<O>,
): Operation<Name, I, O, N, C>;
function defineOperation(
  nameOrSpec:
    | string
    | OwnedOperationSpec<
        Schema.Top,
        Schema.Top,
        boolean,
        readonly AnyEntity[],
        never,
        UnboundOwnedRun<Schema.Top, Schema.Top, boolean>
      >,
  schemas?: OperationSchemas<unknown, unknown, AnyEntity | undefined, AnySchema>,
  body?: (op: Op<AnySchema, AnyEntity | undefined>, input: unknown) => unknown,
): AnyOperation | AnyUnboundOperation {
  if (typeof nameOrSpec === "string") {
    if (schemas === undefined || body === undefined) {
      throw new Error("ramose: Operation(name, schemas, body) needs schemas and a body");
    }
    return defineNamedOperation(
      nameOrSpec,
      schemas,
      body as (
        op: Op<AnySchema, AnyEntity | undefined>,
        input: unknown,
      ) => OutputDraft<unknown> | Promise<OutputDraft<unknown>>,
    );
  }
  const self = nameOrSpec.self !== false;
  return {
    _tag: "UnboundOperation",
    input: nameOrSpec.input,
    output: nameOrSpec.output,
    self,
    writes: Object.freeze([...(nameOrSpec.writes ?? [])]),
    allocations: allocationSlots(nameOrSpec.allocates),
    revision: normalizeOperationRevision(nameOrSpec.revision),
    optimistic: normalizeOptimistic(nameOrSpec.optimistic),
    optimisticRevision: normalizeProjectionRevision(
      nameOrSpec.optimisticRevision,
    ),
    doc: normalizeDoc(nameOrSpec.doc),
    run: nameOrSpec.run,
  } as AnyUnboundOperation;
}

type FieldSchemaType<E extends AnyEntity, K extends string> = E["fields"][K] extends {
  readonly schema: { readonly Type: infer T };
}
  ? T
  : unknown;

type PatchInput<E extends AnyEntity, Keys extends readonly string[]> = {
  readonly [K in Keys[number]]: FieldSchemaType<E, K>;
};

const structOf = (entity: AnyEntity, keys: readonly string[]): Schema.Codec<any, unknown> => {
  const fields: Record<string, Schema.Codec<unknown, unknown>> = {};
  for (const key of keys) {
    const field = entity.fields[key];
    if (field === undefined) {
      throw new Error(`ramose: ${entity.ns} has no field "${key}"`);
    }
    fields[key] = field.schema as Schema.Codec<unknown, unknown>;
  }
  return Schema.Struct(fields);
};

/**
 * A single-field (or few-field) contextual update. The low-ceremony
 * path for what used to be a three-line `transact` (`setTitle`).
 *
 * `Operation.patch("issue/set-title", Issue, ["title"])`.
 */
const definePatch = <
  Name extends string,
  E extends AnyEntity,
  const Keys extends readonly (keyof E["fields"] & string)[],
  C extends AnySchema = AnySchema,
>(
  name: Name,
  entity: E,
  keys: Keys,
  options?: { readonly doc?: string; readonly schema?: C },
): Operation<Name, PatchInput<E, Keys>, {}, E, C> => {
  const operation = defineNamedOperation(
    name,
    {
      on: entity as never,
      input: structOf(entity, keys) as Schema.Codec<PatchInput<E, Keys>, unknown>,
      output: emptyOutput,
      ...(options?.doc !== undefined && { doc: options.doc }),
      ...(options?.schema !== undefined && { schema: options.schema }),
    },
    (op, input) => {
      const self = (op as { readonly self?: unknown }).self;
      if (self === undefined) {
        throw new Error(`ramose: ${name} is contextual and needs an entity`);
      }
      (op as { update: (...args: unknown[]) => unknown }).update(entity, self, input);
      return {};
    },
  );
  return operation as unknown as Operation<Name, PatchInput<E, Keys>, {}, E, C>;
};

type OperationDefine<C extends AnySchema> = <
  Name extends string,
  I,
  O = {},
  N extends OnEntity<C> = undefined,
>(
  name: Name,
  schemas: Omit<OperationSchemas<I, O, N, C>, "schema">,
  body: (op: Op<C, N>, input: I) => Promise<OutputDraft<O>> | OutputDraft<O>,
) => Operation<Name, I, O, N, C>;

type OperationPatch<C extends AnySchema> = <
  Name extends string,
  E extends CatalogEntity<C>,
  const Keys extends readonly (keyof E["fields"] & string)[],
>(
  name: Name,
  entity: E,
  keys: Keys,
  options?: { readonly doc?: string },
) => Operation<Name, PatchInput<E, Keys>, {}, E, C>;

type OperationFor<C extends AnySchema> = OperationDefine<C> & {
  readonly patch: OperationPatch<C>;
};

/**
 * Bind `schema:` once for a catalog so every op from the helper carries
 * the membership / ident checks. `Operation.for(Reef)("issue/move", …)`.
 */
const operationFor = <C extends AnySchema>(schema: C): OperationFor<C> =>
  Object.assign(
    ((name, schemas, body) =>
      defineOperation(name, { ...schemas, schema }, body)) as OperationDefine<C>,
    {
      patch: ((name, entity, keys, options) =>
        definePatch(name, entity, keys, { ...options, schema })) as OperationPatch<C>,
    },
  );

/** Bind one owner-local map without registering anything globally. */
export const bindOwnedOperations = <
  Owner extends OperationOwner,
  const Ops extends Readonly<Record<string, AnyUnboundOperation>>,
>(
  owner: Owner,
  operations: Ops | undefined,
  author?: OwnedOperationAuthor<OperationOwnerShape>,
): BoundOwnerOperations<Owner, Ops> => {
  const out: Record<string, AnyOwnedOperation> = {};
  if (operations === undefined) {
    return out as unknown as BoundOwnerOperations<Owner, Ops>;
  }
  if (Reflect.ownKeys(operations).some((key) => typeof key !== "string")) {
    throw new Error("ramose/schema: operation map keys must be strings");
  }
  const authorToken = author?.[OwnedOperationAuthorToken];
  for (const [localName, operation] of Object.entries(operations)) {
    if (!isIdentName(localName)) throw invalidIdentName("operation", localName);
    if (
      typeof operation !== "object" ||
      operation === null ||
      operation._tag !== "UnboundOperation"
    ) {
      throw new Error(
        `ramose/schema: ${owner.ns}.${localName} must be Ramose.Operation({ input, output, run })`,
      );
    }
    if (
      !Array.isArray(operation.writes) ||
      operation.writes.some((entity) => entity?._tag !== "Entity")
    ) {
      throw new Error(
        `ramose/schema: ${owner.ns}.${localName} writes must contain entity definitions`,
      );
    }
    if (
      authorToken !== undefined &&
      (operation as Partial<OwnerAuthoredOperation<OperationOwnerShape>>)[
        OwnedOperationAuthorToken
      ] !== authorToken
    ) {
      throw new Error(
        `ramose/schema: ${owner.ns}.${localName} must use the Operation author supplied to its operations callback`,
      );
    }
    out[localName] = {
      _tag: "OwnedOperation",
      owner,
      localName,
      input: operation.input,
      output: operation.output,
      self: operation.self,
      writes: operation.writes,
      allocations: operation.allocations ?? [],
      revision: normalizeOperationRevision(operation.revision),
      optimistic: normalizeOptimistic(operation.optimistic),
      optimisticRevision: normalizeProjectionRevision(
        operation.optimisticRevision,
      ),
      doc: operation.doc,
      run: operation.run,
    } as unknown as AnyOwnedOperation;
  }
  return out as unknown as BoundOwnerOperations<Owner, Ops>;
};

export const isOwnedOperation = (value: unknown): value is AnyOwnedOperation =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "OwnedOperation";

/** @internal Build the owner-specialized constructor passed by Entity/Trait. */
export const ownedOperationAuthor = <
  Owner extends OperationOwnerShape,
>(): OwnedOperationAuthor<Owner> => {
  const token = {};
  const author = ((
    spec: OwnedOperationSpec<
      Schema.Top,
      Schema.Top,
      boolean,
      readonly AnyEntity[],
      Owner,
      OwnedRun<
        Owner,
        Schema.Top,
        Schema.Top,
        boolean,
        readonly AnyEntity[]
      >
    >,
  ) => {
    const operation = defineOperation(
      spec as unknown as OwnedOperationSpec<
        Schema.Top,
        Schema.Top,
        boolean,
        readonly AnyEntity[],
        never,
        UnboundOwnedRun<Schema.Top, Schema.Top, boolean>
      >,
    ) as AnyUnboundOperation;
    Object.defineProperty(operation, OwnedOperationAuthorToken, { value: token });
    return operation;
  }) as unknown as OwnedOperationAuthor<Owner>;
  Object.defineProperty(author, OwnedOperationAuthorToken, { value: token });
  return author;
};

/** Define one named operation. `Operation.for(catalog)` bakes `schema:` in. */
export const Operation: typeof defineOperation & {
  readonly for: typeof operationFor;
  readonly patch: typeof definePatch;
} = Object.assign(defineOperation, { for: operationFor, patch: definePatch });

const namesOfRegistry = (operations: Record<string, AnyOperation>): string[] => {
  const names = new Set<string>();
  for (const op of Object.values(operations)) {
    if (typeof op.name === "string" && op.name.length > 0) names.add(op.name);
  }
  return [...names].sort();
};

const cardsOfRegistry = (
  operations: Record<string, AnyOperation>,
  get: (name: string) => AnyOperation | undefined,
): OperationCard[] =>
  namesOfRegistry(operations).flatMap((name) => {
    const op = get(name);
    if (op === undefined) return [];
    const ns = op.on?.ns;
    return [
      {
        name,
        ...(op.doc !== undefined ? { doc: op.doc } : {}),
        ...(typeof ns === "string" && ns.length > 0 ? { on: ns } : {}),
      },
    ];
  });

const makeRegistry = <const M extends Record<string, AnyOperation>>(
  operations: M,
  schema?: AnySchema,
): Operations<M> => {
  const get = (name: string): AnyOperation | undefined => {
    for (const op of Object.values(operations)) {
      if (op.name === name) return op;
    }
    return undefined;
  };
  return {
    _tag: "Operations",
    operations,
    ...(schema !== undefined && { schema }),
    get,
    names: () => namesOfRegistry(operations),
    cards: () => cardsOfRegistry(operations, get),
  };
};

/** An inert registry of operation declarations. */
export const Operations = <const M extends Record<string, AnyOperation>>(
  operations: M,
): Operations<M> => makeRegistry(operations);

type OpsFitCatalog<C extends AnySchema, M extends Record<string, AnyOperation>> = {
  [K in keyof M]: M[K] extends Operation<any, any, any, any, infer OC>
    ? OpCatalogFitsDb<C, OC> extends true
      ? M[K]
      : OpCatalogMismatch
    : M[K];
};

/**
 * Catalog-bound registry both the app and the peer entry import — one
 * source of truth for op ids, inputs, and outputs.
 *
 * ```ts
 * const Op = Operation.for(Reef);
 * export const setTitleOp = Op.patch("issue/set-title", Issue, ["title"]);
 * export const operations = defineOperations(Reef, { setTitleOp });
 * // peer: createServer({ operations })
 * // Server: Server("Ramose", { operations, main: import.meta.resolve("./peer.ts") })
 * ```
 *
 * Wire ids are each operation's declared `name`. Renaming an id is a
 * wire-contract change — add a new id rather than reuse one with a
 * different input or output.
 */
export const defineOperations = <
  C extends AnySchema,
  const M extends Record<string, AnyOperation>,
>(
  schema: C,
  operations: OpsFitCatalog<C, M> & M,
): DefinedOperations<C, M> =>
  makeRegistry(operations, schema) as unknown as DefinedOperations<C, M>;

/** Sorted unique wire ids in a registry. */
export const operationNames = (ops: AnyOperations | undefined): string[] =>
  ops === undefined ? [] : [...ops.names()];

/** Discovery cards (name / doc / on) for a registry. */
export const operationCards = (
  ops: AnyOperations | undefined,
): readonly OperationCard[] => (ops === undefined ? [] : ops.cards());

const namesOf = (source: AnyOperations | readonly string[]): string[] => {
  if (
    typeof source === "object" &&
    source !== null &&
    "_tag" in source &&
    source._tag === "Operations"
  ) {
    return operationNames(source);
  }
  return [...new Set((source as readonly string[]).filter((n) => typeof n === "string" && n.length > 0))].sort();
};

/**
 * A runtime registry must cover every required id. Extra registered ops are
 * fine. Missing ids throw
 * {@link OperationsCoverageError}.
 */
export const checkOperationsCoverage = (
  required: AnyOperations | readonly string[],
  registered: AnyOperations | readonly string[],
): void => {
  const need = namesOf(required);
  const have = new Set(namesOf(registered));
  const missing = need.filter((n) => !have.has(n));
  if (missing.length === 0) return;
  throw new OperationsCoverageError({
    message: `ramose: runtime is missing operations: ${missing.join(", ")} — renaming an op is a wire-contract change`,
    missing,
  });
};

export { OperationsCoverageError };

export { asLookupRef, lowerEntityArg } from "./entityArg.ts";

/**
 * Replace entity handles and tempid strings with resolved eids so an
 * operation's return value can be schema-encoded.
 */
/** Decode operation input; schema failures are `InvalidRequest`. */
export const decodeInput = <I>(
  schema: Schema.Codec<I, unknown>,
  input: unknown,
): Effect.Effect<I, InvalidRequest> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      (e) =>
        new InvalidRequest({
          message: e.message || "invalid operation input",
        }),
    ),
  );

/** Encode operation output for the wire. */
export const encodeOutput = <O>(
  schema: Schema.Codec<O, unknown>,
  output: unknown,
): Effect.Effect<unknown, InvalidRequest> =>
  Schema.encodeUnknownEffect(schema)(output).pipe(
    Effect.mapError(
      (e) =>
        new InvalidRequest({
          message: e.message || "invalid operation output",
        }),
    ),
  );

/** Decode a wire output back into the operation's output type. */
export const decodeOutput = <O>(
  schema: Schema.Codec<O, unknown>,
  output: unknown,
): Effect.Effect<O, InvalidRequest> =>
  Schema.decodeUnknownEffect(schema)(output).pipe(
    Effect.mapError(
      (e) =>
        new InvalidRequest({
          message: e.message || "invalid operation output",
        }),
    ),
  );
