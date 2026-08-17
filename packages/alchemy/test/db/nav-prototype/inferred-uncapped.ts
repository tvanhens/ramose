/**
 * Uncapped `Ref.self` substitute (no hop budget).
 *
 * On TypeScript 5.9.3 this compiles — the circular mapped type is deferred
 * through `RefAttr`'s type parameter and property access resolves. Kept as a
 * tracked encoding alongside the depth-capped default.
 */
import * as Schema from "effect/Schema";
import type { Equal, Expect } from "../../../src/db/equal.ts";
import type { AnyAttr, Nav, RefAttr, SelfMarker, Stamped } from "./types.ts";
import { Attr, Ref } from "./types.ts";

type UncappedSubstSelf<Ns extends string, Attrs extends object, A> = [A] extends [
  RefAttr<SelfMarker, infer Card>,
]
  ? RefAttr<UncappedStampedMap<Ns, Attrs>, Card>
  : A;

type UncappedStampedMap<Ns extends string, Attrs extends object> = {
  readonly [K in keyof Attrs]: Attrs[K] extends AnyAttr
    ? Nav<Stamped<Ns, K & string, UncappedSubstSelf<Ns, Attrs, Attrs[K]>>>
    : never;
};

declare function uncappedNamespace<
  const Name extends string,
  const Attrs extends Record<string, AnyAttr>,
>(
  name: Name,
  attributes: Attrs,
): {
  readonly _tag: "Namespace";
  readonly ns: Name;
  readonly attributes: UncappedStampedMap<Name, Attrs>;
} & UncappedStampedMap<Name, Attrs>;

export const UncappedUser = uncappedNamespace("user", {
  name: Attr(Schema.String),
  email: Attr(Schema.String),
  friends: Attr(Ref.self, { cardinality: "many" }),
});

type Gate = typeof UncappedUser.friends.name.ident;
type Deep =
  typeof UncappedUser.friends.friends.friends.friends.friends.friends.friends
    .friends.name.ident;

type _gate = Expect<Equal<Gate, ":user/name">>;
type _deep = Expect<Equal<Deep, ":user/name">>;
