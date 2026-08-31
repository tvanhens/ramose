import type { AnyComposer } from "../db/Composer.ts";
import type { AnyEntity } from "../db/Entity.ts";
import { OwnedOperations } from "../db/Operation.ts";
import type { MutationRef } from "../db/refs.ts";
import type { AnySchema } from "../db/Schema.ts";
import type { RamoseVt } from "../db/valueTypes.ts";
import type { Receipt } from "./receipt.ts";

type CodecType<S> = S extends { readonly Type: infer T } ? T : unknown;

type Simplify<A> = { readonly [K in keyof A]: A[K] };

type UnionToIntersection<U> =
  (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void
    ? I
    : never;

/**
 * One operation's input, as the application supplies it.
 *
 * The declared schema decides every position except entity references: those
 * are numeric in the deployed operation body and opaque here, because a client
 * is never handed a numeric eid. A reference position accepts the `EntityId`
 * the server issued or the `ClientRef` this device minted for an entity it
 * created offline.
 */
export type MutationInput<S> = S extends RamoseVt<"ref"> ? RefInput<S>
  : S extends { readonly fields: infer Fields } ? StructInput<S, Fields>
  : S extends { readonly value: infer Item }
    ? CodecType<S> extends readonly unknown[] ? readonly MutationInput<Item>[]
    : CodecType<S>
  : S extends { readonly schema: infer Inner } ? MutationInput<Inner>
  : S extends { readonly to: infer Decoded } ? MutationInput<Decoded>
  : CodecType<S>;

/** A declared reference position keeps the entity its schema names. */
type RefInput<S> = S extends { readonly _target?: infer Target }
  ? [NonNullable<Target>] extends [AnyEntity] ? MutationRef<NonNullable<Target>>
  : MutationRef
  : MutationRef;

type StructInput<S, Fields> = {
  readonly [K in keyof CodecType<S>]: K extends keyof Fields
    ? MutationInput<Fields[K]>
    : CodecType<S>[K];
};

/**
 * One callable mutation method whose declared input is not statically known.
 *
 * A database reached through a deployed `Graph` is bound to a child catalog the
 * parent's types do not name, so nothing here can be said about its inputs.
 */
export type MutationMethod = (input?: any) => Receipt;

/** Every operation a surface reaches, when the catalog is not statically known. */
export type MutationNamespace = Readonly<Record<string, MutationMethod>>;

/** A mutation whose whole input is optional is callable with no argument. */
type MutationCall<In> = {} extends In ? (input?: In) => Receipt
  : (input: In) => Receipt;

type MethodFor<Op> = Op extends { readonly input: infer In }
  ? MutationCall<MutationInput<In>>
  : MutationMethod;

type OperationsOf<Owner> = Owner extends
  { readonly [OwnedOperations]: infer Ops extends object } ? Ops : never;

type SelfFlag<Op> = Op extends { readonly self: infer Flag } ? Flag : never;

/**
 * Whether an operation's placement is decided when it is authored.
 *
 * An operation whose `self` is computed carries `boolean`, and which namespace
 * the deployment installs it under is not knowable here. It appears under both
 * rather than under neither, and takes the method type of an operation whose
 * input is not statically known.
 */
type PlacementKnown<Op> = boolean extends SelfFlag<Op> ? false : true;

type MethodsWhereSelf<Owner, Self extends boolean> = {
  readonly [
    K in keyof OperationsOf<Owner> as
      PlacementKnown<OperationsOf<Owner>[K]> extends false ? K
        : OperationsOf<Owner>[K] extends { readonly self: Self } ? K
        : never
  ]: PlacementKnown<OperationsOf<Owner>[K]> extends false ? MutationMethod
    : MethodFor<OperationsOf<Owner>[K]>;
};

type TraitsOf<Owner> = Owner extends
  { readonly traits: infer Traits extends readonly unknown[] } ? Traits[number]
  : never;

type TraitClosure<T> = T extends { readonly _tag: "Trait" }
  ? T | TraitClosure<TraitsOf<T>>
  : never;

type Namespace<Owners, Self extends boolean> = Simplify<
  UnionToIntersection<
    Owners extends unknown ? MethodsWhereSelf<Owners, Self> : never
  >
>;

type SchemaOwners<S extends AnySchema> =
  | S["entities"][keyof S["entities"]]
  | TraitClosure<TraitsOf<S["entities"][keyof S["entities"]]>>;

type NamesEntities<S extends AnySchema> = string extends keyof S["entities"]
  ? false
  : true;

type NamesFields<N extends AnyComposer> = string extends keyof N["fields"]
  ? false
  : true;

/** The targetless operations one catalog declares. */
export type DatabaseMutations<S extends AnySchema> = NamesEntities<S> extends
  true ? Namespace<SchemaOwners<S>, false>
  : MutationNamespace;

/**
 * The self and trait operations one declared focus reaches.
 *
 * An entity reaches the operations its composed traits declare, transitively.
 * A trait focus reaches only its own: a polymorphic read over a trait is not a
 * claim about which composers answer it.
 *
 * A focus chosen at runtime is several alternatives, and each handle is built
 * for the one that was chosen — so this distributes, and what stays callable
 * across the alternatives is what all of them answer.
 */
export type EntityMutations<N extends AnyComposer> = N extends AnyComposer
  ? NamesFields<N> extends true ? Namespace<N | ComposedTraits<N>, true>
  : MutationNamespace
  : never;

type ComposedTraits<N> = N extends { readonly _tag: "Entity" }
  ? TraitClosure<TraitsOf<N>>
  : never;
