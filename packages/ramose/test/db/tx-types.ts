/**
 * Compile-time fixtures for the catalog-generic transaction builder.
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  Db,
  DbError,
  Equal,
  Expect,
  Extends,
  IncompatibleSchema,
  ReadDb,
  Tx,
  Eid,
  TxHandle,
  TxReport,
} from "../../src/db/internal.ts";
import { Field, Entity } from "../../src/db/internal.ts";

import { Meta, Movie, Movies, User } from "./fixture.ts";

const Tag = Entity("tag", {
  label: Field(Schema.String),
});
declare const db: Db<typeof Movies>;

// ── transact is gone; writes are db.run / the internal builder ─────────────

type _dbHasRun = Expect<Equal<"run" extends keyof typeof db ? true : false, true>>;
type _hatchHasRun = Expect<
  Equal<"run" extends keyof (typeof db)["effect"] ? true : false, true>
>;

// ── the report is `{ t, txEid, datomCount, dbAfter }` ──────────────────────

type Report = TxReport<typeof Movies>;
type _reportKeys = Expect<
  Equal<keyof Report, "t" | "txEid" | "datomCount" | "dbAfter">
>;
type _reportT = Expect<Equal<Report["t"], number>>;
type _reportCount = Expect<Equal<Report["datomCount"], number>>;
type _dbAfterIsDb = Expect<Equal<Report["dbAfter"], Db<typeof Movies>>>;
/** No public `minT`: the floor is a property of the db, not an option. */
type _noMinT = Expect<Equal<"minT" extends keyof Report ? true : false, false>>;

// ── a read view has no write half ──────────────────────────────────────────

type ReadK = keyof ReadDb<typeof Movies>;
type DbK = keyof Db<typeof Movies>;

type _readNoTx = Expect<Equal<"transact" extends ReadK ? true : false, false>>;
type _readNoInstall = Expect<
  Equal<"install" extends ReadK ? true : false, false>
>;
type _dbHasInstall = Expect<
  Equal<"install" extends DbK ? true : false, true>
>;
type _dbNoTransact = Expect<
  Equal<"transact" extends DbK ? true : false, false>
>;
type _hatchNoTransact = Expect<
  Equal<"transact" extends keyof (typeof db)["effect"] ? true : false, false>
>;
type _dbStillReads = Expect<Equal<"query" extends DbK ? true : false, true>>;

declare const view: ReadDb<typeof Movies>;
void view.query;
// @ts-expect-error a read view has no transact
view.transact;
// @ts-expect-error a read view has no install
view.install;

// ── install is an ordinary transaction that reports the same way ───────────

const installed = db.effect.install();
type _installReport = Expect<
  Equal<Effect.Success<typeof installed>, TxReport<typeof Movies>>
>;
type _installErr = Expect<
  Equal<Effect.Error<typeof installed>, DbError | IncompatibleSchema>
>;

// ── builder types are catalog-generic ──────────────────────────────────────

type _handle = Expect<
  Extends<
    Effect.Success<ReturnType<Tx<typeof Movies>["entity"]>>,
    TxHandle<typeof Movies>
  >
>;

// ── put on the builder ─────────────────────────────────────────────────────

declare const tx: Tx<typeof Movies>;
declare const movieId: Eid<typeof Movie>;
declare const userId: Eid<typeof User>;
declare const handle: TxHandle<typeof Movies>;

// ── field / value slots on the builder ─────────────────────────────────────

tx.set(handle, User.name, "Ada");
tx.set(handle, User.age, 36);
tx.set(handle, Meta.source, "import");
// bag: Movie.title on a user handle is legal — do not close the world
tx.set(handle, Movie.title, "not a movie but types allow any ns");
{
  // @ts-expect-error unknown attr on the namespace
  handle.set(User.nope, "x");
  // @ts-expect-error ident not in the catalog
  handle.set({ ident: ":user/nope" } as const, "x");
  // @ts-expect-error namespace not in this catalog
  handle.set(Tag.label, "x");
  // @ts-expect-error unknown ident string
  tx.set(handle, ":user/nope", "x");
  // @ts-expect-error name is string, not number
  handle.set(User.name, 42);
  // @ts-expect-error year is number, not string
  handle.set(Movie.year, "2016");
  // @ts-expect-error ident form: name is string, not number
  tx.set(handle, ":user/name" as const, 42);
  // @ts-expect-error friends is a ref (number), not a string
  handle.set(User.friends, "Ada");
}
handle.remove(User.age, 35);
handle.remove(User.name);
handle.delete();
tx.remove(handle, User.friends, 1002);
tx.delete(handle);
tx.entity([User.name, "Ada"]);
tx.set([":user/name", "Ada"], User.age, 36);

const putH = tx.put(User, { name: "Ada", friends: [1002] });
type _putH = Expect<Extends<Effect.Success<typeof putH>, TxHandle<typeof Movies>>>;
tx.put(User, 1001, { age: 36 });
tx.put(User, { name: "Ada", bestFriend: 1002 });
tx.put(User, { name: "Ada", bestFriend: userId });
tx.put(User, userId, { age: 36 });
declare const userRow: { readonly id: Eid<typeof User> };
// `{ id: row.id }` re-wrap is no longer required — the branded cell is enough
tx.put(User, userRow.id, { age: 36 });
tx.set(userRow.id, User.age, 36);
tx.put(User, { name: "Ada", bestFriend: tx.tempid("ada") });
const updH = tx.update(User, userId, { age: 37 });
type _updH = Expect<Extends<Effect.Success<typeof updH>, TxHandle<typeof Movies>>>;
tx.update(User, { name: "Ada", age: 38 });
{
  // @ts-expect-error name is string, not number
  tx.put(User, { name: 42 });
  // @ts-expect-error friends is many
  tx.put(User, { friends: 1002 });
  // @ts-expect-error a string in a ref slot would mint a dangling record
  tx.put(User, { bestFriend: "typo-not-an-entity" });
  // @ts-expect-error a branded movie cell is not a user subject
  tx.put(User, movieId, { name: "Ada" });
  // @ts-expect-error a movie eid is not a user ref
  tx.put(User, { bestFriend: movieId });
  // @ts-expect-error a bare string is not a tempid
  tx.put(User, { bestFriend: "typo" });
  // @ts-expect-error create form requires the required keys — key-only is update
  tx.put(User, { age: 36 });
  // @ts-expect-error update map form needs a unique: "upsert" field
  tx.update(User, { age: 36 });
}
