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
  all,
  not,
  or,
  query,
  type ReadDb,
  Ref,
  type Row,
  type Rows,
} from "../../src/db/internal.ts";

import { Movie, Movies, User } from "./fixture.ts";

declare const db: Db<typeof Movies>;

/** A second catalog whose refs are targeted, so a path can hop. */
const Author = Namespace("author", { name: Attr(Schema.String) });
/** A component target: the cover is owned by the book that refers to it. */
const Cover = Namespace("cover", { art: Attr(Schema.String) });
const Book = Namespace("book", {
  title: Attr(Schema.String),
  published: Attr(Instant),
  author: Attr(Ref(() => Author)),
  cover: Attr(Ref(() => Cover), { isComponent: true }),
});
const Library = Catalog({ author: Author, book: Book, cover: Cover });
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

// ── combinators nest, and are what `where` takes ───────────────────────────

query(User).where(
  or(User.name.eq("Ada"), User.age.gte(36)),
  not(User.name.missing()),
  or(not(User.age.lt(18)), or(User.name.startsWith("A"))),
  or(),
);
const combined = db.q(
  query(User)
    .where(or(User.name.eq("Ada"), not(User.age.exists())))
    .select({ name: User.name }),
);
type _combined = Expect<
  Equal<Effect.Success<typeof combined>, readonly { readonly name: string }[]>
>;

// @ts-expect-error `or` combines predicates, not attributes
query(User).where(or(User.name));

// @ts-expect-error `not` takes one where-node, not a list
query(User).where(not(User.name.eq("Ada"), User.age.gte(36)));

// ── some / every / none, on cardinality-many refs only ─────────────────────

query(User).where(
  User.friends.some(User.name.eq("Ada")),
  User.friends.every(User.age.gte(18)),
  User.friends.none(User.name.missing()),
  // the inner node may be a combinator, or another quantifier
  User.friends.some(or(User.age.lt(18), User.friends.none(User.age.exists()))),
);

// @ts-expect-error `:user/bestFriend` is a cardinality-one ref
query(User).where(User.bestFriend.some(User.name.eq("Ada")));

// @ts-expect-error `:user/name` is neither many nor a ref
query(User).where(User.name.every(User.name.eq("Ada")));

// @ts-expect-error `:movie/year` has no elements to quantify over
query(Movie).where(Movie.year.none(Movie.title.eq("x")));

// @ts-expect-error a quantifier takes a where-node, not an attribute
query(User).where(User.friends.some(User.name));

// ── reverse refs: the backlink is rooted at the ref's owning namespace ─────

/** `:book/author` read backwards, from an `Author` root. */
type _reverseIdent = Expect<
  Equal<typeof Book.author.reverse.title.ident, ":book/title">
>;
library.q(
  query(Author).where(
    Book.author.reverse.title.eq("Calculus"),
    Book.author.reverse.exists(),
    // a backlink is a many hop, so it quantifies
    Book.author.reverse.some(Book.published.lt(new Date())),
    Book.author.reverse.every(Book.title.startsWith("A")),
  ),
);

const backlinks = library.q(
  query(Author).select({
    name: Author.name,
    books: Book.author.reverse.select({ title: Book.title }),
  }),
);
/** a backlink shape is an array — a possibly-empty one, never a dropped row */
type _backlinks = Expect<
  Equal<
    Effect.Success<typeof backlinks>,
    readonly {
      readonly name: string;
      readonly books: readonly { readonly title: string }[];
    }[]
  >
>;

/** an untargeted ref has a backlink too — only the owning namespace matters */
query(User).where(User.bestFriend.reverse.name.eq("Ada"));

// ── the backlink of a component ref is single-valued ───────────────────────

/**
 * A `:db/isComponent` ref owns what it points at, so at most one entity
 * points *back*: the backlink is card-one, its shape is one nested object,
 * and `.optional` is how a component without an owner is spelled.
 */
const componentBacklink = library.q(
  query(Cover).select({
    art: Cover.art,
    book: Book.cover.reverse.select({ title: Book.title }),
    maybeBook: Book.cover.reverse.select({ published: Book.published }).optional,
  }),
);
type _componentBacklink = Expect<
  Equal<
    Effect.Success<typeof componentBacklink>,
    readonly {
      readonly art: string;
      readonly book: { readonly title: string };
      readonly maybeBook: { readonly published: Date } | undefined;
    }[]
  >
>;

/** the hop is card-one, so a path through it is an ordinary predicate… */
library.q(query(Cover).where(Book.cover.reverse.title.eq("Calculus")));
/** …and a legal sort key, which a many backlink never is */
library.q(query(Cover).orderBy(Book.cover.reverse.published, "desc"));

// @ts-expect-error one owner is no collection: nothing to quantify over
query(Cover).where(Book.cover.reverse.some(Book.title.eq("x")));
// @ts-expect-error …nothing to filter…
Book.cover.reverse.where(Book.title.eq("x"));
// @ts-expect-error …and nothing to page
Book.cover.reverse.limit(1);
// @ts-expect-error a backlink is still a ref: no value to stand in for
Book.cover.reverse.orDefault("x");

// ── nested where / orderBy / limit on a collection ─────────────────────────

/**
 * The inner predicates are typed against the collection's **element** — the
 * ref's owning namespace for a backlink — and the row type is unchanged: a
 * filtered collection is the same array, with fewer elements in it.
 */
const filteredBacklink = library.q(
  query(Author).select({
    name: Author.name,
    books: Book.author.reverse
      .where(Book.title.startsWith("A"), Book.published.lt(new Date()))
      .orderBy(Book.published, "desc", { empty: "first" })
      .offset(1)
      .limit(5)
      .select({ title: Book.title }),
  }),
);
type _filteredBacklink = Expect<
  Equal<
    Effect.Success<typeof filteredBacklink>,
    readonly {
      readonly name: string;
      readonly books: readonly { readonly title: string }[];
    }[]
  >
>;

/** a forward card-many ref is a collection too, and `.optional` still applies */
const filteredMany = db.q(
  query(User).select({
    friends: User.friends.where(User.name.startsWith("A")).limit(3).select({
      name: User.name,
    }),
    maybeFriends: User.friends.limit(1).select({ age: User.age }).optional,
  }),
);
type _filteredMany = Expect<
  Equal<
    Effect.Success<typeof filteredMany>,
    readonly {
      readonly friends: readonly { readonly name: string }[];
      readonly maybeFriends: readonly { readonly age: number }[] | undefined;
    }[]
  >
>;

// @ts-expect-error `:book/title` is a string attribute, in a nested where too
Book.author.reverse.where(Book.title.eq(42));

query(User).select({
  // @ts-expect-error a nested orderBy key is card-one: a many attr is a set
  friends: User.friends.orderBy(User.friends).select({ name: User.name }),
});

query(User).select({
  // @ts-expect-error a card-one ref reaches one entity — nothing to filter
  best: User.bestFriend.where(User.name.eq("Ada")).select({ name: User.name }),
});

// @ts-expect-error …and nothing to page, either
query(User).select({ best: User.bestFriend.limit(1).select({ name: User.name }) });

// @ts-expect-error a scalar attribute is not a collection
query(User).select({ name: User.name.where(User.name.eq("Ada")) });

// ── `.each`: the element of a card-many scalar ─────────────────────────────

/**
 * A cardinality-many scalar has elements too — its values — and `.each` is
 * how they are named. It keeps the attribute's value type, so the predicates
 * stay typed, and it is in scope only inside that attribute's own
 * `every` / `none` / `some` / `where` / `orderBy`.
 */
const Post = Namespace("post", {
  title: Attr(Schema.String),
  tags: Attr(Schema.String, { cardinality: "many" }),
  scores: Attr(Schema.Number, { cardinality: "many" }),
});
const Blog = Catalog({ post: Post });
declare const blog: Db<typeof Blog>;

query(Post).where(
  Post.tags.every(Post.tags.each.startsWith("a")),
  Post.tags.none(Post.tags.each.eq("spam")),
  Post.tags.some(Post.tags.each.in(["a", "b"])),
  Post.scores.every(Post.scores.each.gt(3)),
  // combinators nest around them as usual
  or(
    Post.tags.some(Post.tags.each.matches(/^a/)),
    not(Post.scores.none(Post.scores.each.lte(0))),
  ),
);

/** a constrained card-many scalar is a select field of its own: the array */
const scalarCollection = blog.q(
  query(Post).select({
    title: Post.title,
    all: Post.tags,
    tags: Post.tags
      .where(Post.tags.each.startsWith("a"))
      .orderBy(Post.tags.each, "desc")
      .offset(1)
      .limit(3),
  }),
);
type _scalarCollection = Expect<
  Equal<
    Effect.Success<typeof scalarCollection>,
    readonly {
      readonly title: string;
      readonly all: readonly string[];
      readonly tags: readonly string[];
    }[]
  >
>;

// @ts-expect-error `:post/tags` holds strings, `.each` is one of them
query(Post).where(Post.tags.every(Post.tags.each.eq(42)));

// @ts-expect-error a cardinality-one attribute is its value already
query(Post).where(Post.title.each.eq("x"));

// @ts-expect-error the element of another collection is not in scope here
query(Post).where(Post.tags.every(Post.scores.each.gt(3)));

// @ts-expect-error … nor inside another collection's nested where
Post.tags.where(Post.scores.each.gt(3));

// @ts-expect-error … nor as another collection's sort key
Post.tags.orderBy(Post.scores.each);

// @ts-expect-error an element cursor means nothing in the query's own where
query(Post).where(Post.tags.each.eq("a"));

// @ts-expect-error … or in its orderBy: a row has the collection, not a value
query(Post).orderBy(Post.tags.each);

// @ts-expect-error … or as a select field: the field is the attribute
query(Post).select({ tags: Post.tags.each });

/** a card-many *ref* still needs its shape — a scalar one has none to ask for */
query(User).select({
  // @ts-expect-error a filtered ref collection is not a field until it is shaped
  friends: User.friends.where(User.name.eq("Ada")),
});

// @ts-expect-error `:author/name` is not a ref, so it has no backlink
query(Author).where(Book.title.reverse.eq("x"));

// @ts-expect-error a backlink exposes the *owning* namespace's attributes
query(Author).where(Book.author.reverse.name.eq("Ada"));

// ── `.orDefault`: a missing card-one scalar reads as a value ───────────────

/**
 * `.orDefault(v)` is the pull's `:default`, not a client-side `??`: the peer
 * substitutes `v` for the entity that has no such datom, so the row is kept
 * and the field reads as the attribute's own type — never `| undefined`.
 */
const defaulted = db.q(
  query(User).select({ name: User.name, age: User.age.orDefault(0) }),
);
type _defaulted = Expect<
  Equal<
    Effect.Success<typeof defaulted>,
    readonly { readonly name: string; readonly age: number }[]
  >
>;
/** …which is exactly the difference from `.optional` */
type _defaultedIsNotMaybe = Expect<
  Equal<
    Equal<Effect.Success<typeof defaulted>, Effect.Success<typeof maybeAge>>,
    false
  >
>;
library.q(query(Book).select({ title: Book.title.orDefault("untitled") }));
blog.q(query(Post).select({ title: Post.title.orDefault("") }));

// @ts-expect-error `:user/age` is a number attribute, and so is its stand-in
query(User).select({ age: User.age.orDefault("none") });

// @ts-expect-error `:book/published` is an Instant, not a string
query(Book).select({ published: Book.published.orDefault("2026-01-01") });

// @ts-expect-error a card-many scalar is `[]` when it has no values
query(Post).select({ tags: Post.tags.orDefault(["a"]) });

// @ts-expect-error a card-many ref is `[]` too — and an entity is not a value
query(User).select({ friends: User.friends.orDefault([]) });

// @ts-expect-error a card-one ref reaches an entity, whose stand-in is a shape
query(User).select({ best: User.bestFriend.orDefault(1) });

// @ts-expect-error `:db/id` is the entity itself, and is never missing
query(Movie).select({ id: Movie.id.orDefault(0) });

// @ts-expect-error `.orDefault` does not make a hop a direct attribute
query(Book).select({ authorName: Book.author.name.orDefault("") });

// @ts-expect-error … nor is an element cursor a select field
query(Post).select({ tags: Post.tags.each.orDefault("") });

// @ts-expect-error a defaulted field always reads, so there is no `.optional`
query(User).select({ age: User.age.orDefault(0).optional });

// @ts-expect-error … and a maybe field has no value to default
query(User).select({ age: User.age.optional.orDefault(0) });

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

/** a self-ref's backlink is the same namespace, walked the other way */
query(Person).where(
  Person.boss.reverse.name.startsWith("A"),
  Person.friends.some(Person.boss.reverse.name.eq("Ada")),
);

// @ts-expect-error `:person/name` is a string attribute, two hops in too
query(Person).where(Person.boss.boss.name.eq(3));

// @ts-expect-error a self-ref exposes only the namespace's attributes
Person.boss.nope;

// ── a select field is a direct attribute, not a flattened path ─────────────

/**
 * A path is what a predicate and a sort key take; a *select field* names one
 * attribute of the entity being pulled, so the shape of a hop is the nested
 * select — `{ author: Book.author.select({ name: Author.name }) }`, never
 * `{ authorName: Book.author.name }`, which would ask the book for
 * `:author/name`.
 */
library.q(
  query(Book).select({
    title: Book.title,
    author: Book.author.select({ name: Author.name }),
  }),
);
query(Person).select({ boss: Person.boss.select({ name: Person.name }) });

// @ts-expect-error `:author/name` is a hop away — use a nested select
query(Book).select({ authorName: Book.author.name });

// @ts-expect-error `.optional` does not make a hop a direct attribute
query(Book).select({ authorName: Book.author.name.optional });

// @ts-expect-error a nested select rooted two hops in is a path too
query(Org).select({ friends: Org.lead.friends.select({ name: Person.name }) });

// @ts-expect-error a backlink walked one hop further is a path as well
query(Author).select({ authorName: Book.author.reverse.author.name });

// ── `Row` / `Rows` name the inferred row type ───────────────────────────────

const boardQuery = query(User).select({
  name: User.name,
  age: User.age.optional,
  best: User.bestFriend.select({ name: User.name }),
  friends: User.friends.select({ name: User.name }),
  maybeBest: User.bestFriend.select({ age: User.age }).optional,
});

type BoardRow = Row<typeof boardQuery>;
type _boardRow = Expect<
  Equal<
    BoardRow,
    {
      readonly name: string;
      readonly age: number | undefined;
      readonly best: { readonly name: string };
      readonly friends: readonly { readonly name: string }[];
      readonly maybeBest: { readonly age: number } | undefined;
    }
  >
>;

/** `Rows` is the readonly array of `Row` — exactly what `db.q` resolves to. */
type _boardRows = Expect<Equal<Rows<typeof boardQuery>, readonly BoardRow[]>>;
const boardRows = db.q(boardQuery);
type _boardRowsMatchQ = Expect<
  Equal<Effect.Success<typeof boardRows>, Rows<typeof boardQuery>>
>;

/** the builder and the frozen query value name the same row */
const builtBoard = boardQuery.build();
type _builtRow = Expect<Equal<Row<typeof builtBoard>, BoardRow>>;

/** a hoisted query factory names its row through `ReturnType` */
const byName = (name: string) =>
  query(User).where(User.name.eq(name)).select({ age: User.age });
type _factoryRow = Expect<
  Equal<Row<ReturnType<typeof byName>>, { readonly age: number }>
>;

/** with no `.select`, the row is the matched entity id */
const bare = query(User);
type _bareRow = Expect<Equal<Row<typeof bare>, Eid>>;
type _bareRows = Expect<Equal<Rows<typeof bare>, readonly Eid[]>>;
/**
 * …which is looser than `db.q` there: the db re-brands ids to its catalog
 * (`Eid<typeof Movies>`), a query — scoped to a namespace — cannot.
 */
type _bareRowsUnbranded = Expect<
  Equal<Equal<Rows<typeof bare>, Effect.Success<typeof eids>>, false>
>;

/** not a query — no row */
type _notAQuery = Expect<Equal<Row<{ rows: readonly string[] }>, never>>;

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

// ── `all(N)`: the wildcard row, keyed by the namespace's idents ────────────

const everything = db.q(query(User).select(all(User)));
type Everything = Effect.Success<typeof everything>[number];

/** the wildcard always carries `:db/id` — it is the entity, not a datom */
type _allId = Expect<Equal<Everything[":db/id"], number>>;
/**
 * Every attribute is optional: a datom the entity does not have is a key the
 * map does not have. (The runtime map is a *superset* of these keys — the
 * entity may carry other namespaces' datoms too — so this is a lower bound.)
 */
type _allName = Expect<Equal<Everything[":user/name"], string | undefined>>;
type _allAge = Expect<Equal<Everything[":user/age"], number | undefined>>;
/** a ref reads as the entity the peer answers with, not as its id */
type _allBest = Expect<
  Equal<Everything[":user/bestFriend"], { readonly ":db/id": number } | undefined>
>;
/** cardinality-many is an array of those */
type _allFriends = Expect<
  Equal<
    Everything[":user/friends"],
    readonly { readonly ":db/id": number }[] | undefined
  >
>;
/** the row is selected, so `db.q` does not re-brand it as `readonly Eid[]` */
type _allNotEids = Expect<
  Equal<
    Effect.Success<typeof everything> extends readonly Eid<typeof Movies>[]
      ? true
      : false,
    false
  >
>;
/** `Row` / `Rows` name it like any other selected row */
const allQuery = query(User).select(all(User));
type _allRow = Expect<Equal<Row<typeof allQuery>, Everything>>;
type _allRows = Expect<Equal<Rows<typeof allQuery>, readonly Everything[]>>;

// @ts-expect-error a wildcard of another namespace is not this query's row
query(User).select(all(Movie));

query(User).select({
  // @ts-expect-error `all(N)` is the whole shape of a query, never one field
  everything: all(User),
});
