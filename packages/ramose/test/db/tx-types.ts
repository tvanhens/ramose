/**
 * Compile-time fixtures for the catalog-generic transaction builder.
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  Db,
  DbError,
  Equal,
  Expect,
  Extends,
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

// ── generator transact is the only write ───────────────────────────────────

const crossNs = db.effect.transact(function* (tx) {
  const ada = yield* tx.entity();
  yield* ada.set(User.name, "Ada");
  yield* ada.set(User.age, 36);
  yield* ada.set(Meta.source, "import");
  // bag: Movie.title on a user handle is legal — do not close the world
  yield* ada.set(Movie.title, "not a movie but types allow any ns");
});
type _crossNsReport = Expect<
  Equal<Effect.Success<typeof crossNs>, TxReport<typeof Movies>>
>;
type _crossNsErr = Expect<Extends<DbError, Effect.Error<typeof crossNs>>>;
type _crossNsR = Expect<Equal<Effect.Services<typeof crossNs>, never>>;

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

// ── unknown attr is a type error ───────────────────────────────────────────

db.effect.transact(function* (tx) {
  const e = yield* tx.entity();
  // @ts-expect-error unknown attr on the namespace
  yield* e.set(User.nope, "x");
  // @ts-expect-error ident not in the catalog
  yield* e.set({ ident: ":user/nope" } as const, "x");
  // @ts-expect-error namespace not in this catalog
  yield* e.set(Tag.label, "x");
  // @ts-expect-error unknown ident string
  yield* tx.set(e, ":user/nope", "x");
});

// ── wrong value type is a type error ───────────────────────────────────────

db.effect.transact(function* (tx) {
  const e = yield* tx.entity();
  // @ts-expect-error name is string, not number
  yield* e.set(User.name, 42);
  // @ts-expect-error year is number, not string
  yield* e.set(Movie.year, "2016");
  // @ts-expect-error ident form: name is string, not number
  yield* tx.set(e, ":user/name" as const, 42);
  // @ts-expect-error friends is a ref (number), not a string
  yield* e.set(User.friends, "Ada");
});

// ── retract / retractEntity typecheck ──────────────────────────────────────

const retracts = db.effect.transact(function* (tx) {
  const e = yield* tx.entity(1001);
  yield* e.remove(User.age, 35);
  yield* e.remove(User.name);
  yield* e.delete();
  yield* tx.remove(e, User.friends, 1002);
  yield* tx.delete(e);
  const byLookup = yield* tx.entity([User.name, "Ada"]);
  yield* byLookup.set(Meta.source, "lookup");
  yield* tx.set([":user/name", "Ada"], User.age, 36);
});
type _retractReport = Expect<
  Equal<Effect.Success<typeof retracts>, TxReport<typeof Movies>>
>;

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
type _hatchHasTransact = Expect<
  Equal<"transact" extends keyof (typeof db)["effect"] ? true : false, true>
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
type _installErr = Expect<Equal<Effect.Error<typeof installed>, DbError>>;

// ── callback errors union into transact ────────────────────────────────────

class ExtraLoad extends Data.TaggedError("ExtraLoad")<{}> {}

const withExtra = db.effect.transact(function* (tx) {
  const e = yield* tx.entity();
  yield* e.set(User.name, "Ada");
  return yield* Effect.fail(new ExtraLoad());
});
type _extraErr = Expect<Extends<ExtraLoad, Effect.Error<typeof withExtra>>>;
type _stillDb = Expect<Extends<DbError, Effect.Error<typeof withExtra>>>;

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
const putH = tx.put(User, { name: "Ada", friends: [1002] });
type _putH = Expect<Extends<Effect.Success<typeof putH>, TxHandle<typeof Movies>>>;
tx.put(User, 1001, { age: 36 });
tx.put(User, { bestFriend: { id: 1002 } });
tx.put(User, { bestFriend: userId });
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
}
