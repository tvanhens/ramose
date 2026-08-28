/**
 * Focus-namespace membership for query stages.
 *
 * The constraint is membership in the focus's stamped field map — the
 * idents of `N.fields` (plus `:db/id`) — not ident-namespace-prefix
 * equality. A future traits layer can stamp `Issue.tags` with ident
 * `:taggable/tags` and still belong to `Issue`.
 */

import type { AnyComposer } from "../Composer.ts";
import type { AnyEntity, Entity, FieldMap } from "../Entity.ts";

/** `:db/id` plus every ident in `N.fields`. */
export type FocusIdents<N extends AnyComposer> =
  | {
      [K in keyof N["fields"]]: N["fields"][K] extends {
        readonly ident: infer I;
      }
        ? I
        : never;
    }[keyof N["fields"]]
  | ":db/id";

/** The ident a path carrier / attr-like value names. */
export type AttrIdent<A> = A extends { readonly ident: infer I } ? I : never;

/** `A` is a member of `N`'s stamped field map. */
export type InFocus<A, N extends AnyComposer> = [AttrIdent<A>] extends [
  FocusIdents<N>,
]
  ? true
  : false;

/**
 * Attributes of the current focus: its stamped fields, and `:db/id` when
 * the entity exposes one. Used as the PathCarrier union for fluent
 * `orderBy`; membership checks go through {@link InFocus} / {@link FocusIdents}.
 */
export type FocusAttr<N extends AnyComposer> = N["fields"][keyof N["fields"]] | FocusId<N>;

type FocusId<N extends AnyComposer> = N extends { readonly id: infer Id } ? Id : never;

/**
 * The entity a stamped field was filed under, recovered from its ident
 * (`:comment/text` → `Entity<"comment">`). Used to re-target after
 * `backlink` — not to decide membership (that is {@link FocusIdents}).
 */
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

/** Argument-position error when a stage names a foreign entity's field. */
export type FocusMismatch = {
  readonly "ramose/query: this attribute is not a field of the focus entity": never;
};

/**
 * The entity a `Ref(User)` field points at. Self-refs / untargeted refs
 * resolve to `Enclosing`. Optional `_target` infers `T | undefined`.
 */
export type RefTarget<A, Enclosing extends AnyComposer> = A extends {
  readonly schema: { readonly _target?: infer T };
}
  ? Exclude<T, undefined> extends AnyComposer
    ? Exclude<T, undefined>
    : Enclosing
  : Enclosing;

type OwnerNs<A> = A extends { readonly ident: `:${infer Ns}/${string}` } ? Ns : never;

/**
 * A reverse-ref is legal on `N` when it points at `N`. A targeted
 * `Ref(Issue)` must land on `N`; a self-ref / untargeted ref is owned
 * by `N` (its ident namespace matches `N.ns`).
 */
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
