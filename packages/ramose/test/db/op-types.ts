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
import {
  Entity,
  Field,
  Operation,
  Query,
  Schema as DbSchema,
} from "../../src/db/internal.ts";

import { Meta, Movie, Movies, User } from "./fixture.ts";

const Tag = Entity("tag", {
  label: Field(Schema.String),
});
const Other = DbSchema({ tag: Tag });

const Issue = Entity("issue", {
  key: Field(Schema.String, { unique: "upsert" }),
});
const Comment = Entity("comment", {
  slug: Field(Schema.String, { unique: "upsert" }),
});
const Board = DbSchema({ issue: Issue, comment: Comment });

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
  // @ts-expect-error friends is a ref, not a boolean
  e.set(User.friends, true);
  // @ts-expect-error name is string, not number
  op.self.set(User.name, 42);
}

// ── ref values name a not-yet-existing entity ──────────────────────────────

{
  const a = op.entity();
  const b = op.entity();
  a.set(User.bestFriend, b);
  a.set(User.bestFriend, b.eid);
  a.set(User.friends, b);
  // @ts-expect-error name is a string, not a handle
  a.set(User.name, b);
  // @ts-expect-error age is a number, not a tempid
  a.set(User.age, "tmp-1");
}

// ── self.eid is Eid | string (queued contextual path may pass a tempid) ────

type SelfEid = (typeof op.self)["eid"];
type _selfEidHasString = Expect<Extends<string, SelfEid>>;
type _selfEidHasUser = Expect<Extends<Eid<typeof User>, SelfEid>>;
// @ts-expect-error self.eid may be a queued tempid string
const _selfEidAsNumber: number = op.self.eid;

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
db.run(setUserName, "tmp-1", { name: "Ada" });
db.run(setUserName, [User.name, "Ada"], { name: "Ada" });
db.run(setUserName, [":user/name", "Ada"] as const, { name: "Ada" });
declare const idRow: { readonly id: number };
db.run(setUserName, idRow, { name: "Ada" });
db.run(createUser, { name: "Ada" });
db.run(setMovieTitle, movieId, { title: "Arrival" });

// @ts-expect-error a branded movie cell is not a user cell
db.run(setUserName, movieId, { name: "Ada" });
// @ts-expect-error a branded user cell is not a movie cell
db.run(setMovieTitle, userId, { title: "Arrival" });

const issueOp = Operation(
  "issue/touch",
  {
    schema: Board,
    on: Issue,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (body) => {
    body.self.set(Issue.key, "i-1");
    return {};
  },
);
declare const boardDb: Db<typeof Board>;
boardDb.run(issueOp, [Issue.key, "i-1"], {});
boardDb.run(issueOp, [":issue/key", "i-1"] as const, {});
boardDb.run(issueOp, "tmp-1", {});
// @ts-expect-error a comment lookup is not an issue lookup
boardDb.run(issueOp, [Comment.slug, "c-1"], {});
// @ts-expect-error ident prefix must match the on entity
boardDb.run(issueOp, [":comment/slug", "c-1"] as const, {});

const schemaLess = Operation(
  "user/set-name-loose",
  {
    on: User,
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({}),
  },
  (body, input) => {
    const e = body.entity();
    e.set(":user/name", "Ada");
    e.set(User.name, input.name);
    return {};
  },
);
db.run(schemaLess, userId, { name: "Ada" });
declare const otherDb: Db<typeof Other>;
otherDb.run(schemaLess, userId, { name: "Ada" });

// @ts-expect-error a schema:-bound op does not run on a different catalog
otherDb.run(setUserName, userId, { name: "Ada" });

const _onNotInCatalog = Operation(
  "tag/on-movies",
  {
    schema: Movies,
    // @ts-expect-error Tag is not an entity of Movies
    on: Tag,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  () => ({}),
);

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
