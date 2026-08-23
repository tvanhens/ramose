/**
 * Compile-time fixtures for the literate pull map.
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Field,
  Schema as DbSchema,
  type Db,
  type Eid,
  type Equal,
  type Expect,
  type AllRow,
  Entity,
  Ref,
  again,
  all,
  pick,
} from "../../src/db/internal.ts";

import { Meta, Movie, Movies, User } from "./fixture.ts";

declare const db: Db<typeof Movies>;
declare const eid: Eid<typeof Movies>;

// ── a `:db/id` row cell is a pull subject, no cast (issue #77) ──────────────

declare const cell: Eid<typeof User>;
const byCell = db.pull(cell, { name: User.name, age: User.age.optional });
type ByCell = NonNullable<Awaited<typeof byCell>>;
type _byCellName = Expect<Equal<ByCell["name"], string>>;

const Elsewhere = Entity("elsewhere", { label: Field(Schema.String) });
declare const foreignCell: Eid<typeof Elsewhere>;
// @ts-expect-error a cell from a namespace outside this catalog is no subject here
db.pull(foreignCell, { name: User.name });


// ── renamed keys, required vs optional ─────────────────────────────────────

const required = db.pull(eid, {
  name: User.name,
  age: User.age,
});
type RequiredPull = NonNullable<Awaited<typeof required>>;
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
type MaybePull = NonNullable<Awaited<typeof maybe>>;
type _optName = Expect<Equal<MaybePull["name"], string | undefined>>;
type _optAge = Expect<Equal<MaybePull["age"], number | undefined>>;

/** `.orDefault` is required-shaped: the peer substitutes, so it always reads. */
const defaulted = db.pull(eid, {
  name: User.name,
  age: User.age.orDefault(0),
});
type DefaultedPull = NonNullable<Awaited<typeof defaulted>>;
type _defAge = Expect<Equal<DefaultedPull["age"], number>>;

// @ts-expect-error `:user/age` is a number attribute, and so is its stand-in
db.pull(eid, { age: User.age.orDefault("none") });

// ── .select nest: many → array, one → object ───────────────────────────────

const withFriends = db.pull(eid, {
  name: User.name,
  friends: User.friends.select({
    name: User.name,
    age: User.age.optional,
  }),
});
type FriendsPull = NonNullable<Awaited<typeof withFriends>>;
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
type BestPull = NonNullable<Awaited<typeof withBest>>;
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
type DeepPull = NonNullable<Awaited<typeof deep>>;
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
type Happy = NonNullable<Awaited<typeof happy>>;
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
type BagPull = NonNullable<Awaited<typeof bag>>;
type _bagName = Expect<Equal<BagPull["name"], string>>;
type _bagSource = Expect<Equal<BagPull["source"], string>>;
type _bagTitle = Expect<Equal<BagPull["title"], string>>;

// ── pick ──────────────────────────────────────────────────────────────────

const picked = db.pull(eid, pick(User, "name", "age"));
type Picked = NonNullable<Awaited<typeof picked>>;
type _picked = Expect<
  Equal<Picked, { readonly name: string; readonly age: number }>
>;

// ── ident-keyed escape still works ─────────────────────────────────────────

const soup = db.pull(eid, [User.name, User.age] as const);
type Soup = NonNullable<Awaited<typeof soup>>;
type _soupName = Expect<Equal<Soup[":user/name"], string | undefined>>;
type _soupAge = Expect<Equal<Soup[":user/age"], number | undefined>>;

/** A ref with no nested pattern reads as the entity: `{":db/id": n}`. */
const refSoup = db.pull(eid, [User.bestFriend, ":user/friends"] as const);
type RefSoup = NonNullable<Awaited<typeof refSoup>>;
type _refSoupOne = Expect<
  Equal<RefSoup[":user/bestFriend"], { readonly ":db/id": number } | undefined>
>;
type _refSoupMany = Expect<
  Equal<
    RefSoup[":user/friends"],
    readonly { readonly ":db/id": number }[] | undefined
  >
>;

// ── `all(N)`: the same wildcard, with the namespace's idents typed ──────────

const wild = db.pull(eid, ["*"] as const);
type Wild = NonNullable<Awaited<typeof wild>>;
/** the wildcard always carries `:db/id`; every catalog ident is optional */
type _wildId = Expect<Equal<Wild[":db/id"], number>>;
type _wildName = Expect<Equal<Wild[":user/name"], string | undefined>>;
type _wildTitle = Expect<Equal<Wild[":movie/title"], string | undefined>>;

const everything = db.pull(eid, all(User));
type EverythingPull = NonNullable<Awaited<typeof everything>>;
type _everythingId = Expect<Equal<EverythingPull[":db/id"], number>>;
type _everythingName = Expect<
  Equal<EverythingPull[":user/name"], string | undefined>
>;
/** `all(User)` names one namespace, so the catalog's other idents are not keys */
type _everythingNoMovie = Expect<
  Equal<":movie/title" extends keyof EverythingPull ? true : false, false>
>;
/** the two agree where they overlap — it is the one wildcard the peer answers */
type _everythingAgrees = Expect<
  Equal<EverythingPull[":user/friends"], Wild[":user/friends"]>
>;

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

const Other = Entity("tag", { label: Field(Schema.String) });
// @ts-expect-error attr from a catalog that is not on this client
db.pull(eid, { label: Other.label });

// @ts-expect-error the wildcard of a namespace that is not in this catalog
db.pull(eid, all(Other));

// ── nested `all(N)` under a ref `.select` ──────────────────────────────────

const nestedAll = db.pull(eid, {
  name: User.name,
  bestFriend: User.bestFriend.select(all(User)),
  maybeBest: User.bestFriend.select(all(User)).optional,
  friends: User.friends.select(all(User)),
});
type NestedAllPull = NonNullable<Awaited<typeof nestedAll>>;
type _nestedAllName = Expect<Equal<NestedAllPull["name"], string>>;
type _nestedAllBest = Expect<
  Equal<NestedAllPull["bestFriend"], AllRow<typeof User>>
>;
type _nestedAllMaybe = Expect<
  Equal<NestedAllPull["maybeBest"], AllRow<typeof User> | undefined>
>;
type _nestedAllFriends = Expect<
  Equal<NestedAllPull["friends"], readonly AllRow<typeof User>[]>
>;
type _nestedAllBestName = Expect<
  Equal<NestedAllPull["bestFriend"][":user/name"], string | undefined>
>;

// ── `again(n)` on db.pull: same unroll as the nav builder ──────────────────

const Node = Entity("node", {
  label: Field(Schema.String),
  next: Field(Ref.self),
  kids: Field(Ref.self, { cardinality: "many" }),
});
const Graph = DbSchema({ node: Node });
declare const graph: Db<typeof Graph>;
declare const nodeEid: Eid<typeof Graph>;

const pulledTree = graph.pull(nodeEid, {
  id: Node.id,
  label: Node.label,
  kids: Node.kids.select(again(1), { limit: 8 }),
});
type PulledTree = NonNullable<Awaited<typeof pulledTree>>;
type _pulledKidLabel = Expect<Equal<PulledTree["kids"][number]["label"], string>>;
type _pulledStub = Expect<
  Equal<PulledTree["kids"][number]["kids"][number], { readonly id: Eid<typeof Node> }>
>;
// @ts-expect-error again(1): the next kids hop is a stub
type _pulledPast = PulledTree["kids"][number]["kids"][number]["label"];

// @ts-expect-error again is not a top-level pull
graph.pull(nodeEid, again(2));

graph.pull(nodeEid, {
  id: Node.id,
  // @ts-expect-error again is a shape, not a field
  kids: again(2),
});

