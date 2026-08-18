/**
 * Compile-time fixtures for `db.live`. `bun run typecheck` compiles this file.
 *
 * `live` and `q` are two terminals over one query value, so the row types are
 * the ones `nav-query-types.ts` pins; what is specific here is that `live` is a
 * `Stream` whose requirements channel is `never` (no `Scope` in the type).
 */

import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type {
  Db,
  DbError,
  Eid,
  Equal,
  Expect,
} from "../../src/db/internal.ts";
import { query } from "../../src/db/internal.ts";

import { Movies, User } from "./fixture.ts";

declare const db: Db<typeof Movies>;

// ── the stream's element is the query's row type ───────────────────────────

const named = db.live(
  query(User).select({ name: User.name, age: User.age.optional }),
);
type NamedRows = readonly {
  readonly name: string;
  readonly age: number | undefined;
}[];
type _named = Expect<Equal<typeof named, Stream.Stream<NamedRows, DbError>>>;
/** `live` requires nothing: teardown is fiber interruption, not a `Scope`. */
type _namedR = Expect<Equal<Stream.Services<typeof named>, never>>;
type _namedErr = Expect<Equal<Stream.Error<typeof named>, DbError>>;

// nested selects come through the same as `db.pull`
const friends = db.live(
  query(User).select({ friends: User.friends.select({ name: User.name }) }),
);
type Friends = Stream.Success<typeof friends>;
type _friends = Expect<
  Equal<Friends[number]["friends"], readonly { readonly name: string }[]>
>;

// ── no `.select` is a stream of entity ids ─────────────────────────────────

const eids = db.live(query(User).where(User.name.exists()));
type _eids = Expect<
  Equal<Stream.Success<typeof eids>, readonly Eid<typeof Movies>[]>
>;

// ── a pinned view still gives a Stream ─────────────────────────────────────

const past = db.asOf(3).live(query(User).select({ name: User.name }));
type Names = readonly { readonly name: string }[];
type _past = Expect<Equal<typeof past, Stream.Stream<Names, DbError>>>;
const hist = db.history.live(query(User).select({ name: User.name }));
type _hist = Expect<Equal<typeof hist, Stream.Stream<Names, DbError>>>;

// ── basis() requires nothing: `R = never`, on every view ──────────────────

const basis = db.basis();
type _basis = Expect<
  Equal<typeof basis, Effect.Effect<{ readonly t: number }, DbError>>
>;
type _basisR = Expect<Equal<Effect.Services<typeof basis>, never>>;
type _basisErr = Expect<Equal<Effect.Error<typeof basis>, DbError>>;

const pinnedBasis = db.asOf(3).basis();
type _pinnedBasis = Expect<
  Equal<typeof pinnedBasis, Effect.Effect<{ readonly t: number }, DbError>>
>;
const historyBasis = db.history.basis();
type _historyBasis = Expect<
  Equal<typeof historyBasis, Effect.Effect<{ readonly t: number }, DbError>>
>;

// ── the query is still attribute-checked ───────────────────────────────────

// @ts-expect-error `:user/name` is a string attribute
db.live(query(User).where(User.name.eq(42)));

// @ts-expect-error the legacy callback builder is gone
db.live((q) => q.find("?e"));
