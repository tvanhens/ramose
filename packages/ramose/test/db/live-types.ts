/**
 * Compile-time fixtures for `db.live`. `bun run typecheck` compiles this file.
 *
 * `live` and `q` are two terminals over one query value (`Query.q` + the
 * pipeable stdlib), so the row types are the query's own; what is specific
 * here is that `live` is a `Stream` whose requirements channel is `never`
 * (no `Scope` in the type).
 */

// @effect-diagnostics floatingEffect:off
// Bare calls below are the fixtures: their *types* are under test (often
// paired with `@ts-expect-error`), so they are deliberately neither yielded
// nor assigned. This file is compiled by `bun run typecheck`, never run.

import type * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import type * as Stream from "effect/Stream";
import type {
  Db,
  DbError,
  Eid,
  Equal,
  Expect,
  NotOne,
  Subscription,
} from "../../src/db/internal.ts";
import { Q, Query } from "../../src/db/internal.ts";

import { Movies, User } from "./fixture.ts";

declare const db: Db<typeof Movies>;
declare const eid: Eid<typeof Movies>;

// ── the stream's element is the query's row type ───────────────────────────

const named = db.effect.live(
  Query.q(() =>
    pipe(
      Query.entities(User),
      Query.select({ name: User.name, age: User.age.optional }),
    ),
  ),
);
type NamedRows = readonly {
  readonly name: string;
  readonly age: number | undefined;
}[];
export type _named = Expect<Equal<typeof named, Stream.Stream<NamedRows, DbError>>>;

const publicLive = db.live(
  Query.q(() =>
    pipe(
      Query.entities(User),
      Query.select({ name: User.name, age: User.age.optional }),
    ),
  ),
);
export type _publicLive = Expect<
  Equal<typeof publicLive, Subscription<NamedRows, DbError>>
>;
export type _publicLiveErr = Expect<
  Equal<
    Parameters<NonNullable<Parameters<(typeof publicLive)["subscribe"]>[1]>>[0],
    DbError
  >
>;
/** `live` requires nothing: teardown is fiber interruption, not a `Scope`. */
export type _namedR = Expect<Equal<Stream.Services<typeof named>, never>>;
export type _namedErr = Expect<Equal<Stream.Error<typeof named>, DbError>>;

// nested selects come through the same as `db.pull`
const friends = db.effect.live(
  Query.q(() =>
    pipe(
      Query.entities(User),
      Query.select({ friends: User.friends.select({ name: User.name }) }),
    ),
  ),
);
type Friends = Stream.Success<typeof friends>;
export type _friends = Expect<
  Equal<Friends[number]["friends"], readonly { readonly name: string }[]>
>;

// ── no `select` is a stream of bare `{ id }` rows ──────────────────────────

/** the generator spelling returns the focus var, so the row is `{ id }` */
const eids = db.effect.live(
  Query.q(function* () {
    const user = yield* Query.entities(User);
    yield* Query.has(User.name)(user);
    return user;
  }),
);
export type _eids = Expect<
  Equal<Stream.Success<typeof eids>, readonly { readonly id: number }[]>
>;

// ── one() / oneOrFail() unwrap the element ─────────────────────────────────

const ada = Query.q(() =>
  pipe(
    Query.entities(User),
    Query.is(User.name, "Ada"),
    Query.select({ name: User.name }),
  ),
);

const oneLive = db.effect.live(ada.one());
export type _oneLive = Expect<
  Equal<
    typeof oneLive,
    Stream.Stream<{ readonly name: string } | null, DbError>
  >
>;

/** `oneOrFail()` adds `NotOne` to the error channel; the element is the row. */
const failLive = db.effect.live(ada.oneOrFail());
export type _failLive = Expect<
  Equal<
    typeof failLive,
    Stream.Stream<{ readonly name: string }, DbError | NotOne>
  >
>;

// ── aggregate cells group by the record's other cells ──────────────────────

/** a record projection with an aggregate cell: one row per group */
const grouped = db.effect.live(
  Query.q(function* () {
    const user = yield* Query.entities(User);
    const name = yield* Q.fact(user, User.name);
    return { name: name.v, n: Q.count(user) };
  }),
);
export type _grouped = Expect<
  Equal<
    Stream.Success<typeof grouped>,
    readonly { readonly name: string; readonly n: number }[]
  >
>;

const scalarCount = db.effect.live(
  Query.q(function* () {
    const user = yield* Query.entities(User);
    return Q.value(Q.count(user));
  }),
);
export type _scalar = Expect<Equal<Stream.Success<typeof scalarCount>, number>>;

// ── inline values: the query carries its own literals ──────────────────────

const byName = Query.q(() =>
  pipe(
    Query.entities(User),
    Query.is(User.name, "Ada"),
    Query.select({ age: User.age }),
  ),
);
const bound = db.effect.live(byName);
export type _bound = Expect<
  Equal<typeof bound, Stream.Stream<readonly { readonly age: number }[], DbError>>
>;

// ── a pinned view still gives a Stream ─────────────────────────────────────

const namesQ = Query.q(() =>
  pipe(Query.entities(User), Query.select({ name: User.name })),
);
const past = db.asOf(3).effect.live(namesQ);
type Names = readonly { readonly name: string }[];
export type _past = Expect<Equal<typeof past, Stream.Stream<Names, DbError>>>;
const hist = db.history.effect.live(namesQ);
export type _hist = Expect<Equal<typeof hist, Stream.Stream<Names, DbError>>>;

// ── basis() requires nothing: `R = never`, on every view ──────────────────

const basis = db.effect.basis();
export type _basis = Expect<
  Equal<typeof basis, Effect.Effect<{ readonly t: number }, DbError>>
>;
export type _basisR = Expect<Equal<Effect.Services<typeof basis>, never>>;
export type _basisErr = Expect<Equal<Effect.Error<typeof basis>, DbError>>;

const pinnedBasis = db.asOf(3).effect.basis();
export type _pinnedBasis = Expect<
  Equal<typeof pinnedBasis, Effect.Effect<{ readonly t: number }, DbError>>
>;
const historyBasis = db.history.effect.basis();
export type _historyBasis = Expect<
  Equal<typeof historyBasis, Effect.Effect<{ readonly t: number }, DbError>>
>;

// ── livePull: the live terminal for pull ───────────────────────────────────

const projected = db.effect.livePull(eid, {
  name: User.name,
  age: User.age.optional,
});
type Projection = {
  readonly name: string;
  readonly age: number | undefined;
};
export type _projected = Expect<
  Equal<typeof projected, Stream.Stream<Projection | null, DbError>>
>;

const publicPull = db.livePull(eid, {
  name: User.name,
  age: User.age.optional,
});
export type _publicPull = Expect<
  Equal<typeof publicPull, Subscription<Projection | null, DbError>>
>;
/** `livePull` requires nothing either: teardown is fiber interruption. */
export type _projectedR = Expect<Equal<Stream.Services<typeof projected>, never>>;
export type _projectedErr = Expect<Equal<Stream.Error<typeof projected>, DbError>>;

// nested `.select` and a lookup-ref subject come through as in `db.pull`
const bestOf = db.effect.livePull([User.name, "Ada"], {
  bestFriend: User.bestFriend.optional.select({ name: User.name }),
});
type BestOf = NonNullable<Stream.Success<typeof bestOf>>;
export type _bestOf = Expect<
  Equal<BestOf["bestFriend"], { readonly name: string } | undefined>
>;

// a pinned view still gives a Stream
const pastPull = db.asOf(3).effect.livePull(eid, { name: User.name });
export type _pastPull = Expect<
  Equal<
    typeof pastPull,
    Stream.Stream<{ readonly name: string } | null, DbError>
  >
>;

// @ts-expect-error unknown attr on the namespace
db.effect.livePull(eid, { name: User.nope });

// ── only a query value stands up ───────────────────────────────────────────

// @ts-expect-error the legacy callback builder is gone
db.effect.live((q) => q.find("?e"));
