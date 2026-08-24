/**
 * Compile-time fixtures for the catalog-generic operation handle.
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

import * as Schema from "effect/Schema";
import type {
  Db,
  Eid,
  Equal,
  Expect,
  Extends,
  Op,
  OpHandle,
  OpReport,
  TxHandle,
} from "../../src/db/internal.ts";
import { Entity, Field, Operation, Query } from "../../src/db/internal.ts";

import { Meta, Movie, Movies, User } from "./fixture.ts";

const Tag = Entity("tag", {
  label: Field(Schema.String),
});

declare const db: Db<typeof Movies>;
declare const op: Op<typeof Movies, typeof User>;
declare const userId: Eid<typeof User>;
declare const movieId: Eid<typeof Movie>;

// ── set / remove / entity share Tx's field / value correlation ─────────────

const writes = (async () => {
  const e = op.entity();
  e.set(User.name, "Ada");
  e.set(User.age, 36);
  e.set(Meta.source, "import");
  // bag: Movie.title on a user handle is legal — do not close the world
  e.set(Movie.title, "not a movie but types allow any ns");
  op.set(op.self, User.name, "Ada");
  op.remove(e, User.age, 35);
  op.remove(e, User.name);
  op.delete(e);
  const byLookup = op.entity([User.name, "Ada"]);
  byLookup.set(Meta.source, "lookup");
  op.set([":user/name", "Ada"], User.age, 36);
  return e;
})();
type _writesHandle = Expect<
  Extends<Awaited<typeof writes>, OpHandle<typeof Movies>>
>;

// ── unknown attr is a type error ───────────────────────────────────────────

{
  const e = op.entity();
  // @ts-expect-error unknown attr on the namespace
  e.set(User.nope, "x");
  // @ts-expect-error ident not in the catalog
  e.set({ ident: ":user/nope" } as const, "x");
  // @ts-expect-error namespace not in this catalog
  e.set(Tag.label, "x");
  // @ts-expect-error unknown ident string
  op.set(e, ":user/nope", "x");
  // @ts-expect-error unknown attr on self
  op.self.set(User.nope, "x");
}

// ── wrong value type is a type error ───────────────────────────────────────

{
  const e = op.entity();
  // @ts-expect-error name is string, not number
  e.set(User.name, 42);
  // @ts-expect-error year is number, not string
  e.set(Movie.year, "2016");
  // @ts-expect-error ident form: name is string, not number
  op.set(e, ":user/name" as const, 42);
  // @ts-expect-error friends is a ref (number), not a string
  e.set(User.friends, "Ada");
  // @ts-expect-error name is string, not number
  op.self.set(User.name, 42);
}

// ── db.run entity is the on namespace ──────────────────────────────────────

const setUserName = Operation(
  "user/set-name",
  {
    schema: Movies,
    on: User,
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({}),
  },
  (body, input) => {
    body.set(body.self, User.name, input.name);
    return {};
  },
);

const createUser = Operation(
  "user/create",
  {
    schema: Movies,
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({}),
  },
  (body, input) => {
    const e = body.entity();
    e.set(User.name, input.name);
    return {};
  },
);

const setMovieTitle = Operation(
  "movie/set-title",
  {
    schema: Movies,
    on: Movie,
    input: Schema.Struct({ title: Schema.String }),
    output: Schema.Struct({}),
  },
  (body, input) => {
    body.self.set(Movie.title, input.title);
    return {};
  },
);

const renamed = db.run(setUserName, userId, { name: "Ada" });
type _renamed = Expect<
  Equal<typeof renamed, Promise<OpReport<{}, typeof Movies>>>
>;
db.run(setUserName, 1001, { name: "Ada" });
db.run(createUser, { name: "Ada" });
db.run(setMovieTitle, movieId, { title: "Arrival" });

// @ts-expect-error a movie cell is not a user cell
db.run(setUserName, movieId, { name: "Ada" });
// @ts-expect-error a user cell is not a movie cell
db.run(setMovieTitle, userId, { title: "Arrival" });

// ── op.query / op.pull / op.effect keep their existing typing ──────────────

const names = Query.from(User).select({ name: User.name });
const queried = op.query(names);
type _queried = Expect<
  Equal<typeof queried, Promise<readonly { readonly name: string }[]>>
>;

const pulled = op.pull(userId, { name: User.name });
type _pulled = Expect<Equal<typeof pulled, Promise<unknown>>>;

const effected = op.effect("audit", async () => 1);
type _effected = Expect<Equal<typeof effected, Promise<number>>>;

// ── handle is the promise twin of TxHandle (same bag, void methods) ────────

type _handleEid = Expect<
  Equal<OpHandle<typeof Movies>["eid"], TxHandle<typeof Movies>["eid"]>
>;
type _selfIsHandle = Expect<
  Extends<typeof op.self, OpHandle<typeof Movies>>
>;
