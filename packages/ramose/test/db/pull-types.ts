/**
 * Compile-time fixtures for the literate pull map.
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Attr,
  type Db,
  type Eid,
  type Equal,
  type Expect,
  Namespace,
  pick,
} from "../../src/db/internal.ts";

import { Meta, Movie, Movies, User } from "./fixture.ts";

declare const db: Db<typeof Movies>;
declare const eid: Eid<typeof Movies>;


// ── renamed keys, required vs optional ─────────────────────────────────────

const required = db.pull(eid, {
  name: User.name,
  age: User.age,
});
type RequiredPull = NonNullable<Effect.Success<typeof required>>;
type _reqName = Expect<Equal<RequiredPull["name"], string>>;
type _reqAge = Expect<Equal<RequiredPull["age"], number>>;
// ident keys are not on the result
type _noIdent = Expect<
  Equal<":user/name" extends keyof RequiredPull ? true : false, false>
>;

const maybe = db.pull(eid, {
  name: User.name.optional,
  age: User.age.optional,
});
type MaybePull = NonNullable<Effect.Success<typeof maybe>>;
type _optName = Expect<Equal<MaybePull["name"], string | undefined>>;
type _optAge = Expect<Equal<MaybePull["age"], number | undefined>>;

// ── .select nest: many → array, one → object ───────────────────────────────

const withFriends = db.pull(eid, {
  name: User.name,
  friends: User.friends.select({
    name: User.name,
    age: User.age.optional,
  }),
});
type FriendsPull = NonNullable<Effect.Success<typeof withFriends>>;
type _friends = Expect<
  Equal<
    FriendsPull["friends"],
    readonly { readonly name: string; readonly age: number | undefined }[]
  >
>;
type _selfName = Expect<Equal<FriendsPull["name"], string>>;

const withBest = db.pull(eid, {
  bestFriend: User.bestFriend.select({ name: User.name }),
  maybeBest: User.bestFriend.optional.select({ name: User.name }),
});
type BestPull = NonNullable<Effect.Success<typeof withBest>>;
type _best = Expect<
  Equal<BestPull["bestFriend"], { readonly name: string }>
>;
type _maybeBest = Expect<
  Equal<BestPull["maybeBest"], { readonly name: string } | undefined>
>;

// two levels — same syntax inside .select
const deep = db.pull(eid, {
  friends: User.friends.select({
    name: User.name,
    friends: User.friends.select({ name: User.name }),
  }),
});
type DeepPull = NonNullable<Effect.Success<typeof deep>>;
type _deep = Expect<
  Equal<
    DeepPull["friends"],
    readonly {
      readonly name: string;
      readonly friends: readonly { readonly name: string }[];
    }[]
  >
>;

// ── the target happy path ──────────────────────────────────────────────────

const happy = db.pull(eid, {
  name: User.name,
  age: User.age.optional,
  source: Meta.source,
  bestFriend: User.bestFriend.optional.select({
    name: User.name,
    age: User.age.optional,
  }),
  friends: User.friends.select({
    name: User.name,
    age: User.age.optional,
  }),
});
type Happy = NonNullable<Effect.Success<typeof happy>>;
type _happyName = Expect<Equal<Happy["name"], string>>;
type _happyAge = Expect<Equal<Happy["age"], number | undefined>>;
type _happySource = Expect<Equal<Happy["source"], string>>;
type _happyBest = Expect<
  Equal<
    Happy["bestFriend"],
    | { readonly name: string; readonly age: number | undefined }
    | undefined
  >
>;
type _happyFriends = Expect<
  Equal<
    Happy["friends"],
    readonly { readonly name: string; readonly age: number | undefined }[]
  >
>;

// ── cross-namespace fields on one pull ─────────────────────────────────────

const bag = db.pull(eid, {
  name: User.name,
  source: Meta.source,
  title: Movie.title,
});
type BagPull = NonNullable<Effect.Success<typeof bag>>;
type _bagName = Expect<Equal<BagPull["name"], string>>;
type _bagSource = Expect<Equal<BagPull["source"], string>>;
type _bagTitle = Expect<Equal<BagPull["title"], string>>;

// ── pick ──────────────────────────────────────────────────────────────────

const picked = db.pull(eid, pick(User, "name", "age"));
type Picked = NonNullable<Effect.Success<typeof picked>>;
type _picked = Expect<
  Equal<Picked, { readonly name: string; readonly age: number }>
>;

// ── ident-keyed escape still works ─────────────────────────────────────────

const soup = db.pull(eid, [User.name, User.age] as const);
type Soup = NonNullable<Effect.Success<typeof soup>>;
type _soupName = Expect<Equal<Soup[":user/name"], string | undefined>>;
type _soupAge = Expect<Equal<Soup[":user/age"], number | undefined>>;

// ── unknown attr is a type error ───────────────────────────────────────────

// @ts-expect-error unknown attr on the namespace
db.pull(eid, { name: User.nope });

// @ts-expect-error ident not in the catalog
db.pull(eid, [":user/nope"]);

// ── wrong nested attr is a type error ──────────────────────────────────────

db.pull(eid, {
  // @ts-expect-error cannot nest a non-ref attr
  friends: User.name.select({ name: User.name }),
});

db.pull(eid, {
  // @ts-expect-error unknown attr inside the nested pattern
  friends: User.friends.select({ nope: User.nope }),
});

const Other = Namespace("tag", { label: Attr(Schema.String) });
// @ts-expect-error attr from a catalog that is not on this client
db.pull(eid, { label: Other.label });

