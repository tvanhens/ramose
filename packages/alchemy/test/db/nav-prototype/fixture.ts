/**
 * Catalog shaped like docs/QUERY.md §2, for the navigation typing gate.
 *
 * - Encoding A (`User` / `Todo` / `Comment`): inferred `Namespace` with the
 *   depth-capped `StampedMap` in `./types.ts`.
 * - Encoding B (`IfaceUser` / `IfaceTodo`): named interface for the self-ref
 *   target (explicit annotation on the cycle member).
 */

import * as Schema from "effect/Schema";
import {
  Attr,
  Namespace,
  Ref,
  type Attr as AttrT,
  type Nav,
  type RefAttr,
  type Stamped,
} from "./types.ts";

// ── Encoding A: depth-capped inference ─────────────────────────────────────

export const User = Namespace("user", {
  name: Attr(Schema.String),
  email: Attr(Schema.String),
  friends: Attr(Ref.self, { cardinality: "many" }),
});

export const Todo = Namespace("todo", {
  title: Attr(Schema.String),
  done: Attr(Schema.Boolean),
  owner: Attr(Ref(() => User)),
});

export const Comment = Namespace("comment", {
  body: Attr(Schema.String),
  author: Attr(Ref(() => User)),
  replyTo: Attr(Ref.self),
});

// ── Encoding B: interface-deferred self target ─────────────────────────────

type NameAttr = Nav<Stamped<"user", "name", AttrT<typeof Schema.String, "one">>>;
type EmailAttr = Nav<
  Stamped<"user", "email", AttrT<typeof Schema.String, "one">>
>;

export interface IfaceUserAttrs {
  readonly name: NameAttr;
  readonly email: EmailAttr;
  readonly friends: Nav<
    Stamped<"user", "friends", RefAttr<IfaceUserAttrs, "many">>
  >;
}

export const IfaceUser = Namespace("user", {
  name: Attr(Schema.String),
  email: Attr(Schema.String),
  friends: Attr(Ref.self, { cardinality: "many" }),
}) as unknown as {
  readonly _tag: "Namespace";
  readonly ns: "user";
  readonly attributes: IfaceUserAttrs;
} & IfaceUserAttrs;

export const IfaceTodo = Namespace("todo", {
  title: Attr(Schema.String),
  done: Attr(Schema.Boolean),
  owner: Attr(Ref(() => IfaceUser)),
});
