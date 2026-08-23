/**
 * Compile-time fixtures for the Effect-native schema catalog.
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused. Deliberately
 * breaking one assertion must fail tsc.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  type AnyField,
  type AnyEntity,
  Field,
  Bytes,
  Schema as DbSchema,
  type CatalogIdent,
  type ClientOptions,
  type Databases,
  type DatabasesShape,
  type Db,
  type DbError,
  type DbPrincipal,
  type Eid,
  type EntityRef,
  type Equal,
  type Expect,
  type Extends,
  Instant,
  Long,
  type LookupRef,
  Entity,
  type ReadDb,
  type TxHandle,
  Ref,
  type TokenSource,
  token,
  type TxReport,
  Uuid,
  UuidString,
  type ValueAtIdent,
  layer,
} from "../../src/db/internal.ts";

import { Meta, Movie, Movies, User } from "./fixture.ts";

// ── catalog / namespace / attr inference ───────────────────────────────────

type _nsName = Expect<Equal<(typeof User)["ns"], "user">>;
type _attrIdent = Expect<
  Equal<(typeof User)["fields"]["name"]["ident"], ":user/name">
>;
type _userNameRef = Expect<
  Equal<(typeof User)["name"]["ident"], ":user/name">
>;
type _attrCard = Expect<
  Equal<(typeof User)["fields"]["name"]["cardinality"], "one">
>;
type _attrUnique = Expect<
  Equal<(typeof User)["fields"]["name"]["unique"], "upsert">
>;
type _manyCard = Expect<
  Equal<(typeof User)["fields"]["friends"]["cardinality"], "many">
>;
type _nameType = Expect<
  Equal<Schema.Schema.Type<(typeof User)["fields"]["name"]["schema"]>, string>
>;
type _ageType = Expect<
  Equal<Schema.Schema.Type<(typeof User)["fields"]["age"]["schema"]>, number>
>;
type _idents = Expect<
  Equal<
    CatalogIdent<typeof Movies>,
    | ":user/name"
    | ":user/age"
    | ":user/friends"
    | ":user/bestFriend"
    | ":movie/title"
    | ":movie/year"
    | ":movie/released"
    | ":meta/source"
  >
>;
type _valueName = Expect<Equal<ValueAtIdent<typeof Movies, ":user/name">, string>>;
type _valueFriends = Expect<
  Equal<ValueAtIdent<typeof Movies, ":user/friends">, number>
>;
type _nameVt = Expect<
  Equal<(typeof User)["name"]["valueType"], "string">
>;
type _ageVt = Expect<
  Equal<(typeof User)["age"]["valueType"], "long">
>;
type _friendsVt = Expect<
  Equal<(typeof User)["friends"]["valueType"], "ref">
>;

// helpers + primitives stamp valueType; explicit valueType overrides
const Typed = Entity("typed", {
  s: Field(Schema.String),
  n: Field(Schema.Number),
  b: Field(Schema.Boolean),
  l: Field(Long),
  r: Field(Ref.self),
  u: Field(Uuid),
  us: Field(UuidString),
  i: Field(Instant),
  by: Field(Bytes),
  override: Field(Schema.String, { valueType: "uuid" }),
});
type _sVt = Expect<Equal<(typeof Typed)["s"]["valueType"], "string">>;
type _nVt = Expect<Equal<(typeof Typed)["n"]["valueType"], "double">>;
type _bVt = Expect<Equal<(typeof Typed)["b"]["valueType"], "boolean">>;
type _lVt = Expect<Equal<(typeof Typed)["l"]["valueType"], "long">>;
type _rVt = Expect<Equal<(typeof Typed)["r"]["valueType"], "ref">>;
type _uVt = Expect<Equal<(typeof Typed)["u"]["valueType"], "uuid">>;
type _usVt = Expect<Equal<(typeof Typed)["us"]["valueType"], "uuid">>;
type _iVt = Expect<Equal<(typeof Typed)["i"]["valueType"], "instant">>;
type _byVt = Expect<Equal<(typeof Typed)["by"]["valueType"], "bytes">>;
type _overrideVt = Expect<
  Equal<(typeof Typed)["override"]["valueType"], "uuid">
>;

/**
 * Componenthood is inferred as a *type*, not just a flag: `attr.reverse` reads
 * it to decide whether the backlink is one entity or a collection.
 */
const Owned = Entity("owned", {
  part: Field(Ref.self, { owned: true }),
  peer: Field(Ref.self, { cardinality: "many" }),
  plain: Field(Ref.self),
  label: Field(Schema.String),
});
type _componentTrue = Expect<Equal<(typeof Owned)["part"]["owned"], true>>;
type _componentFalse = Expect<Equal<(typeof Owned)["peer"]["owned"], false>>;
type _componentDefault = Expect<
  Equal<(typeof Owned)["plain"]["owned"], false>
>;
type _componentScalar = Expect<
  Equal<(typeof Owned)["label"]["owned"], false>
>;
/** an attribute whose componenthood is not statically known stays `boolean` */
type _componentAny = Expect<Equal<AnyField["owned"], boolean>>;

// .select is callable on inferred refs; a non-ref is a type error
const _refSelect = Typed.r.select({ s: Typed.s });
void _refSelect;
// @ts-expect-error Schema.String / non-ref .select is never
Typed.s.select({ s: Typed.s });
// @ts-expect-error Schema.Number / non-ref .select is never
Typed.n.select({ s: Typed.s });

// ── layer / Databases / db(name, catalog) ──────────────────────────────────

declare const options: ClientOptions;
const built = layer(options);
/** Getting a `Databases` cannot fail, and needs nothing else provided. */
type _layer = Expect<Equal<typeof built, Layer.Layer<Databases, never, never>>>;

declare const ramose: DatabasesShape;
const movies = ramose.db("movies", Movies);
type _dbIsDb = Expect<Equal<typeof movies, Db<typeof Movies>>>;
type _dbCatalog = Expect<Equal<(typeof movies)["schema"], typeof Movies>>;
type _dbName = Expect<Equal<(typeof movies)["name"], string>>;

// a different catalog is a different db type
const Other = DbSchema({
  tag: Entity("tag", { label: Field(Schema.String) }),
});
const other = ramose.db("other", Other);
type _notSame = Expect<Equal<Equal<typeof movies, typeof other>, false>>;

// ── asOf / history preserve the catalog and drop the write half ────────────

const asOf = movies.asOf(3);
const hist = movies.history;
type _asOf = Expect<Equal<typeof asOf, ReadDb<typeof Movies>>>;
type _hist = Expect<Equal<typeof hist, ReadDb<typeof Movies>>>;
type _asOfCatalog = Expect<Equal<(typeof asOf)["schema"], typeof Movies>>;
type _asOfNoWrite = Expect<
  Equal<"transact" extends keyof typeof asOf ? true : false, false>
>;
/** `history` is a property, not a method — a view is a value. */
type _histIsProperty = Expect<
  Equal<typeof hist extends (...args: never) => unknown ? true : false, false>
>;

// ── the transaction is the generator, and reports a TxReport ───────────────

const written = movies.effect.transact(function* (tx) {
  const ada = yield* tx.entity();
  yield* ada.set(User.name, "Ada");
  yield* ada.set(User.age, 36);
  yield* ada.set(Meta.source, "import");
  yield* ada.remove(User.age, 35);
  const arrival = yield* tx.entity();
  yield* arrival.set(Movie.title, "Arrival");
  yield* tx.remove(1001, User.age, 36);
  yield* tx.delete(1001);
});
type _writtenOk = Expect<
  Equal<Effect.Success<typeof written>, TxReport<typeof Movies>>
>;
type _writtenErr = Expect<Equal<Effect.Error<typeof written>, DbError>>;
/** Every signature's `R` is `never`. */
type _writtenR = Expect<Equal<Effect.Services<typeof written>, never>>;

// `dbAfter` is the same `Db`, so it composes without a cast
declare const report: TxReport<typeof Movies>;
type _dbAfter = Expect<Equal<typeof report.dbAfter, Db<typeof Movies>>>;
type _txEid = Expect<Equal<typeof report.txEid, Eid<typeof Movies>>>;

// ── eids are data ──────────────────────────────────────────────────────────

declare const eid: Eid<typeof Movies>;
type _eidId = Expect<Equal<typeof eid.id, number>>;
// no methods and no I/O: `Eid` is `{ id }`
type _eidNoPull = Expect<Equal<"pull" extends keyof typeof eid ? true : false, false>>;

// ── tagged errors remain on the Effect (catchTags still typechecks) ────────

const caught = movies
  .effect.transact(function* (tx) {
    const e = yield* tx.entity();
    yield* e.set(User.name, "Ada");
  })
  .pipe(
    Effect.catchTags({
      TxRejected: (e) => Effect.succeed(e.code),
      Unavailable: (e) => Effect.succeed(e.message),
      InvalidRequest: (e) => Effect.succeed(e.message),
      DatabaseNotFound: (e) => Effect.succeed(e.message),
      Unauthorized: (e) => Effect.succeed(e.message),
      QueryBudgetExceeded: (e) => Effect.succeed(e.clause),
      InternalError: (e) => Effect.succeed(e.message),
      NetworkError: (e) => Effect.succeed(e.message),
      OperationRejected: (e) => Effect.succeed(e.message),
    }),
  );
type _caught = Expect<
  Equal<Effect.Success<typeof caught>, TxReport<typeof Movies> | string>
>;
type _caughtErr = Expect<Equal<Effect.Error<typeof caught>, never>>;

// ── the public surface (ramose.ai/reference/client-api), name by name ──────
//
// `db-portable.test.ts` pins that the barrel exports *these names and no
// others*; `surface.test.ts` does the same for `ramose`. What is left
// is the signature each table row promises, which is a compile-time claim.

/** `ClientOptions` — url, a token in either form, and the two injection seams. */
type _optUrl = Expect<Equal<ClientOptions["url"], string>>;
type _optToken = Expect<
  Equal<
    ClientOptions["token"],
    string | TokenSource | (() => string | Promise<string>) | undefined
  >
>;
type _optFetch = Expect<Equal<ClientOptions["fetch"], typeof fetch | undefined>>;
type _optWs = Expect<
  Equal<ClientOptions["webSocket"], typeof WebSocket | undefined>
>;
/** A static token is one expression, with nothing else to supply. */
const _staticToken: ClientOptions["token"] = "t";
void _staticToken;
/** `token.jwt(mint)` is a `TokenSource`, and the layer takes both forms. */
const _jwtToken: ClientOptions["token"] = token.jwt(async () => "jwt");
void _jwtToken;
const _viaSource = layer({ url: "https://x", token: token.jwt(async () => "t") });
const _viaEffect = layer({
  url: "https://x",
  token: Effect.succeed(Redacted.make("t")),
});
void _viaSource;
void _viaEffect;

/** `Databases` — the key *is* the client, and it has exactly one method. */
type _databasesShape = Expect<Equal<keyof DatabasesShape, "db">>;

/** `Db<C>` is `ReadDb<C>` plus `principal`, `install`, `run` and the hatch. */
type _readDbKeys = Expect<
  Equal<keyof ReadDb<typeof Movies>, "name" | "schema" | "query" | "pull" | "livePull" | "live" | "basis" | "asOf" | "history" | "effect">
>;
type _dbKeys = Expect<
  Equal<Exclude<keyof Db<typeof Movies>, keyof ReadDb<typeof Movies>>, "principal" | "install" | "run">
>;
type _dbExtendsRead = Expect<Extends<Db<typeof Movies>, ReadDb<typeof Movies>>>;

/** `db.install()` — an idempotent catalog upsert, reported like any tx. */
const installed = movies.install();
type _install = Expect<
  Equal<typeof installed, Promise<TxReport<typeof Movies>>>
>;

/** `db.principal()` — who am I; the eid is typed against this db's catalog. */
const me = movies.principal();
type _principal = Expect<
  Equal<typeof me, Promise<DbPrincipal<typeof Movies>>>
>;
type _principalEid = Expect<
  Equal<DbPrincipal<typeof Movies>["eid"], Eid<typeof Movies> | null>
>;

/** `db.pull` — `null` when a required field is missing, never `undefined`. */
const pulled = movies.pull(eid, { name: User.name });
type _pullOk = Expect<
  Equal<Awaited<typeof pulled>, { readonly name: string } | null>
>;

/** …and a `LookupRef` on a unique attribute is the other subject form. */
const byLookup = movies.pull([User.name, "Ada"], { name: User.name });
type _lookupIsSubject = Expect<
  Equal<Awaited<typeof byLookup>, Awaited<typeof pulled>>
>;
declare const lookup: LookupRef<typeof Movies>;
type _lookupPair = Expect<Extends<typeof lookup, readonly [unknown, unknown]>>;
/** …and only on a unique attribute: `:user/age` resolves nothing. */
// @ts-expect-error :user/age is not unique, so it is not a lookup ref
movies.pull([User.age, 30], { name: User.name });
// @ts-expect-error same, spelled as the ident
movies.pull([":user/age", 30], { name: User.name });

/** `TxHandle<C>` — the handle `tx.entity()` returns: `eid`, `set`, `remove`. */
type _entityKeys = Expect<
  Equal<
    Exclude<keyof TxHandle<typeof Movies>, "_tag">,
    "eid" | "set" | "remove" | "delete"
  >
>;
type _entityEid = Expect<Extends<TxHandle<typeof Movies>["eid"], EntityRef<typeof Movies>>>;

/** `TxReport<C>` — exactly the four fields the table lists. */
type _reportKeys = Expect<
  Equal<keyof TxReport<typeof Movies>, "t" | "txEid" | "datomCount" | "dbAfter">
>;
type _reportT = Expect<Equal<TxReport<typeof Movies>["t"], number>>;
type _reportCount = Expect<
  Equal<TxReport<typeof Movies>["datomCount"], number>
>;

/** `DbSchema.Any` is the bound catalog-generic helpers are written against. */
const anyCatalog = <C extends DbSchema.Any>(db: Db<C>): C => db.schema;
type _anyCatalog = Expect<
  Equal<ReturnType<typeof anyCatalog<typeof Movies>>, typeof Movies>
>;
type _moviesIsAny = Expect<Extends<typeof Movies, DbSchema.Any>>;

/** `Field` / `Entity` / `Schema` are types as well as constructors. */
type _attributeTag = Expect<Equal<Field["_tag"], "Field">>;
type _attributeIsAttribute = Expect<Extends<(typeof User)["name"], AnyField>>;
type _namespaceTag = Expect<Equal<Entity["_tag"], "Entity">>;
type _namespaceIsNamespace = Expect<Extends<typeof User, AnyEntity>>;
type _catalogTag = Expect<Equal<(typeof Movies)["_tag"], "Schema">>;
type _catalogIsCatalog = Expect<Extends<typeof Movies, DbSchema.Any>>;

/** `DbError` is the union of the tagged errors a write or read can raise. */
type _dbErrorUnion = Expect<
  Equal<
    DbError["_tag"],
    | "TxRejected"
    | "Unavailable"
    | "InvalidRequest"
    | "DatabaseNotFound"
    | "Unauthorized"
    | "QueryBudgetExceeded"
    | "InternalError"
    | "NetworkError"
    | "OperationRejected"
  >
>;
