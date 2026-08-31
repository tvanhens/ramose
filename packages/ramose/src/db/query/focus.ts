import type { AnyComposer } from "../Composer.ts";
import type { AnyEntity, Entity, FieldMap } from "../Entity.ts";
import type { MutationRef } from "../refs.ts";

export type EntityEq<N> = [N] extends [AnyEntity] ? MutationRef<N> : MutationRef;

export type FocusIdents<N extends AnyComposer> =
  | {
      [K in keyof N["fields"]]: N["fields"][K] extends {
        readonly ident: infer I;
      }
        ? I
        : never;
    }[keyof N["fields"]]
  | ":db/id";

export type AttrIdent<A> = A extends { readonly ident: infer I } ? I : never;

export type InFocus<A, N extends AnyComposer> = [AttrIdent<A>] extends [
  FocusIdents<N>,
]
  ? true
  : false;

export type FocusAttr<N extends AnyComposer> = N["fields"][keyof N["fields"]] | FocusId<N>;

type FocusId<N extends AnyComposer> = N extends { readonly id: infer Id } ? Id : never;

export type OwnerOf<A> = A extends {
  readonly ident: ":db/id";
}
  ? A extends { readonly _ns?: infer E }
    ? E extends AnyEntity
      ? E
      : AnyEntity
    : AnyEntity
  : A extends { readonly ident: `:${infer Ns}/${string}` }
    ? Entity<Ns, FieldMap>
    : AnyEntity;

export type FocusMismatch = {
  readonly "ramose/query: this attribute is not a field of the focus entity": never;
};

export type RefTarget<A, Enclosing extends AnyComposer> = A extends {
  readonly schema: { readonly _target?: infer T };
}
  ? Exclude<T, undefined> extends AnyComposer
    ? Exclude<T, undefined>
    : Enclosing
  : Enclosing;

type OwnerNs<A> = A extends { readonly ident: `:${infer Ns}/${string}` } ? Ns : never;

export type ReverseOk<A, N extends AnyComposer> = [RefTarget<A, AnyComposer>] extends [
  AnyComposer,
]
  ? [AnyComposer] extends [RefTarget<A, AnyComposer>]
    ? [OwnerNs<A>] extends [N["ns"]]
      ? true
      : false
    : [RefTarget<A, N>] extends [N]
      ? true
      : false
  : [RefTarget<A, N>] extends [N]
    ? true
    : false;
