/**
 * Compile-time fixtures for the navigational query surface.
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Attr,
  Catalog,
  type Db,
  type DbError,
  type Eid,
  type Equal,
  type Expect,
  Instant,
  Namespace,
  query,
  type ReadDb,
  Ref,
} from "../../src/db/internal.ts";

import { Movie, Movies, User } from "./fixture.ts";

declare const db: Db<typeof Movies>;

/** A second catalog whose refs are targeted, so a path can hop. */
const Author = Namespace("author", { name: Attr(Schema.String) });
const Book = Namespace("book", {
  title: Attr(Schema.String),
  published: Attr(Instant),
  author: Attr(Ref(() => Author)),
});
const Library = Catalog({ author: Author, book: Book });
declare const library: Db<typeof Library>;

// ── no `.select` yields the matched entity ids ─────────────────────────────

const eids = db.q(query(User));
type _eids = Expect<
  Equal<Effect.Success<typeof eids>, readonly Eid<typeof Movies>[]>
>;
type _eidsErr = Expect<Equal<Effect.Error<typeof eids>, DbError>>;
/** Every signature's `R` is `never` — nothing is left for a caller to provide. */
type _eidsR = Expect<Equal<Effect.Services<typeof eids>, never>>;

/** `where` / `orderBy` / `limit` / `offset` keep the row type. */
const someEids = db.q(
  query(User).where(User.name.startsWith("A")).orderBy(User.age).limit(10).offset(2),
);
type _someEids = Expect<
  Equal<Effect.Success<typeof someEids>, readonly Eid<typeof Movies>[]>
>;
type _eidIsWrapper = Expect<
  Equal<Effect.Success<typeof eids>[number] extends number ? true : false, false>
>;

// ── `.select` infers the row from the shape ────────────────────────────────

const scalars = db.q(query(User).select({ name: User.name, age: User.age }));
type Scalars = Effect.Success<typeof scalars>;
type _scalars = Expect<
  Equal<Scalars, readonly { readonly name: string; readonly age: number }[]>
>;

const maybeAge = db.q(query(User).select({ age: User.age.optional }));
type _maybeAge = Expect<
  Equal<
    Effect.Success<typeof maybeAge>,
    readonly { readonly age: number | undefined }[]
  >
>;

/** `:db/id` is a number in the row, not an `Eid`. */
const withId = db.q(query(Movie).select({ id: Movie.id, title: Movie.title }));
type _withId = Expect<
  Equal<
    Effect.Success<typeof withId>,
    readonly { readonly id: number; readonly title: string }[]
  >
>;

// ── nested `.select` follows cardinality ───────────────────────────────────

const nested = db.q(
  query(User).select({
    friends: User.friends.select({ name: User.name }),
    best: User.bestFriend.select({ name: User.name }),
    maybeBest: User.bestFriend.select({ age: User.age }).optional,
  }),
);
type Nested = Effect.Success<typeof nested>[number];
/** cardinality-many is an array, cardinality-one is the object itself */
type _many = Expect<
  Equal<Nested["friends"], readonly { readonly name: string }[]>
>;
type _one = Expect<Equal<Nested["best"], { readonly name: string }>>;
type _maybeNested = Expect<
  Equal<Nested["maybeBest"], { readonly age: number } | undefined>
>;

// ── predicates are typed by the attribute's value ──────────────────────────

query(User).where(User.name.eq("Ada"), User.age.gte(36), User.age.missing());
library.q(
  query(Book).where(
    Book.author.name.eq("Ada"),
    Book.published.lt(new Date()),
    Book.title.includes("Calculus"),
  ),
);

// @ts-expect-error `:user/name` is a string attribute
query(User).where(User.name.eq(42));

// @ts-expect-error `:movie/year` is a number attribute
query(Movie).where(Movie.year.eq("2016"));

// @ts-expect-error `:book/published` is an Instant, not a string
query(Book).where(Book.published.gt("2026-01-01"));

// @ts-expect-error a predicate is the only thing `where` takes
query(User).where(User.name);

// ── in / endsWith / matches ────────────────────────────────────────────────

query(User).where(User.name.in(["Ada", "Grace"]), User.age.in([36, 37]));
query(User).where(User.name.in([]));
library.q(query(Book).where(Book.author.name.in(["Ada"])));
query(Movie).where(
  Movie.title.endsWith("Calculus"),
  Movie.title.matches(/^The /),
  Movie.title.matches("^The "),
);

// @ts-expect-error `:user/name` is a string attribute, so is every element
query(User).where(User.name.in([1, 2]));

// @ts-expect-error `:movie/year` is a number attribute
query(Movie).where(Movie.year.in(["2016"]));

// @ts-expect-error `in` takes an array, not a value
query(User).where(User.name.in("Ada"));

// @ts-expect-error `matches` takes a pattern, not a number
query(Movie).where(Movie.title.matches(42));

// ── ref `is` takes an entity, and only a ref has it ────────────────────────

declare const someEid: Eid<typeof Movies>;
query(User).where(User.bestFriend.is(someEid), User.friends.is(1001));
query(User).where(User.id.is(someEid), User.id.is(1001));
library.q(query(Book).where(Book.author.is(1001)));
/** a ref's `in` takes entities too */
query(User).where(User.bestFriend.in([someEid, 1001]));

// @ts-expect-error `:user/name` is not a ref
query(User).where(User.name.is(1001));

// @ts-expect-error `:movie/year` is not a ref
query(Movie).where(Movie.year.is(1001));

// @ts-expect-error an entity is an eid or an `Eid`, not a name
query(User).where(User.bestFriend.is("Ada"));

// ── `.orderBy` takes an attribute, including one across a ref ──────────────

const ordered = library.q(
  query(Book)
    .orderBy(Book.author.name, "desc", { empty: "first" })
    .select({ title: Book.title }),
);
type _ordered = Expect<
  Equal<Effect.Success<typeof ordered>, readonly { readonly title: string }[]>
>;

// @ts-expect-error a predicate is not a sort key
query(Book).orderBy(Book.title.eq("Calculus"));

// ── self-refs navigate like any targeted ref, to a finite depth ────────────

const Person = Namespace("person", {
  name: Attr(Schema.String),
  boss: Attr(Ref.self),
  friends: Attr(Ref.self, { cardinality: "many" }),
});
const Org = Namespace("org", { lead: Attr(Ref(() => Person)) });

/** each hop keeps the leaf's ident and value type */
type _selfHop = Expect<Equal<typeof Person.boss.name.ident, ":person/name">>;
type _selfHops = Expect<
  Equal<typeof Org.lead.boss.boss.name.ident, ":person/name">
>;
type _selfMany = Expect<Equal<typeof Person.friends.name.ident, ":person/name">>;
query(Person).where(Person.boss.name.startsWith("A"));
query(Org).orderBy(Org.lead.boss.name);

// @ts-expect-error `:person/name` is a string attribute, two hops in too
query(Person).where(Person.boss.boss.name.eq(3));

// @ts-expect-error a self-ref exposes only the namespace's attributes
Person.boss.nope;

// ── the query value and its builder are the same input ─────────────────────

const built = db.q(query(User).select({ name: User.name }).build());
type _built = Expect<
  Equal<Effect.Success<typeof built>, readonly { readonly name: string }[]>
>;

// @ts-expect-error the legacy callback builder is gone
db.q((q) => q.find("?e"));

// ── asOf / history compose, and have no write half ─────────────────────────

const asOf = db.asOf(3);
const hist = db.history;
type _asOfIsRead = Expect<Equal<typeof asOf, ReadDb<typeof Movies>>>;
type _histIsRead = Expect<Equal<typeof hist, ReadDb<typeof Movies>>>;
type _asOfNoWrite = Expect<
  Equal<"transact" extends keyof typeof asOf ? true : false, false>
>;

const asOfRows = asOf.q(query(User).select({ name: User.name }));
type _asOfRows = Expect<
  Equal<Effect.Success<typeof asOfRows>, readonly { readonly name: string }[]>
>;
const histEids = hist.q(query(User));
type _histEids = Expect<
  Equal<Effect.Success<typeof histEids>, readonly Eid<typeof Movies>[]>
>;
