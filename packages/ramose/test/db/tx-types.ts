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
  Entity,
  Equal,
  Expect,
  Extends,
  ReadDb,
  Tx,
  TxReport,
} from "../../src/db/internal.ts";
import { Attr, Namespace } from "../../src/db/internal.ts";

import { Meta, Movie, Movies, User } from "./fixture.ts";

const Tag = Namespace("tag", {
  label: Attr(Schema.String),
});
declare const db: Db<typeof Movies>;

// ── generator transact is the only write ───────────────────────────────────

const crossNs = db.transact(function* (tx) {
  const ada = yield* tx.entity();
  yield* ada.add(User.name, "Ada");
  yield* ada.add(User.age, 36);
  yield* ada.add(Meta.source, "import");
  // bag: Movie.title on a user handle is legal — do not close the world
  yield* ada.add(Movie.title, "not a movie but types allow any ns");
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

db.transact(function* (tx) {
  const e = yield* tx.entity();
  // @ts-expect-error unknown attr on the namespace
  yield* e.add(User.nope, "x");
  // @ts-expect-error ident not in the catalog
  yield* e.add({ ident: ":user/nope" } as const, "x");
  // @ts-expect-error namespace not in this catalog
  yield* e.add(Tag.label, "x");
  // @ts-expect-error unknown ident string
  yield* tx.add(e, ":user/nope", "x");
});

// ── wrong value type is a type error ───────────────────────────────────────

db.transact(function* (tx) {
  const e = yield* tx.entity();
  // @ts-expect-error name is string, not number
  yield* e.add(User.name, 42);
  // @ts-expect-error year is number, not string
  yield* e.add(Movie.year, "2016");
  // @ts-expect-error ident form: name is string, not number
  yield* tx.add(e, ":user/name", 42);
  // @ts-expect-error friends is a ref (number), not a string
  yield* e.add(User.friends, "Ada");
});

// ── retract / retractEntity typecheck ──────────────────────────────────────

const retracts = db.transact(function* (tx) {
  const e = yield* tx.entity(1001);
  yield* e.retract(User.age, 35);
  yield* e.retract(User.name);
  yield* e.retractEntity();
  yield* tx.retract(e, User.friends, 1002);
  yield* tx.retractEntity(e);
  const byLookup = yield* tx.entity([User.name, "Ada"]);
  yield* byLookup.add(Meta.source, "lookup");
  yield* tx.add([":user/name", "Ada"], User.age, 36);
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
type _dbHasBoth = Expect<
  Equal<
    "transact" extends DbK ? ("install" extends DbK ? true : false) : false,
    true
  >
>;
type _dbStillReads = Expect<Equal<"q" extends DbK ? true : false, true>>;

declare const view: ReadDb<typeof Movies>;
void view.q;
// @ts-expect-error a read view has no transact
view.transact;
// @ts-expect-error a read view has no install
view.install;

// ── install is an ordinary transaction that reports the same way ───────────

const installed = db.install();
type _installReport = Expect<
  Equal<Effect.Success<typeof installed>, TxReport<typeof Movies>>
>;
type _installErr = Expect<Equal<Effect.Error<typeof installed>, DbError>>;

// ── callback errors union into transact ────────────────────────────────────

class ExtraLoad extends Data.TaggedError("ExtraLoad")<{}> {}

const withExtra = db.transact(function* (tx) {
  const e = yield* tx.entity();
  yield* e.add(User.name, "Ada");
  return yield* Effect.fail(new ExtraLoad());
});
type _extraErr = Expect<Extends<ExtraLoad, Effect.Error<typeof withExtra>>>;
type _stillDb = Expect<Extends<DbError, Effect.Error<typeof withExtra>>>;

// ── builder types are catalog-generic ──────────────────────────────────────

type _handle = Expect<
  Extends<
    Effect.Success<ReturnType<Tx<typeof Movies>["entity"]>>,
    Entity<typeof Movies>
  >
>;
