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
  type AnyAttribute,
  type AnyNamespace,
  Attr,
  type Attribute,
  Bytes,
  Catalog,
  type CatalogIdent,
  type ClientOptions,
  type Databases,
  type DatabasesShape,
  type Db,
  type DbError,
  type DbPrincipal,
  type Eid,
  type Entity,
  type EntityRef,
  type Equal,
  type Expect,
  type Extends,
  Instant,
  Long,
  type LookupRef,
  Namespace,
  type ReadDb,
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
  Equal<(typeof User)["attributes"]["name"]["ident"], ":user/name">
>;
type _userNameRef = Expect<
  Equal<(typeof User)["name"]["ident"], ":user/name">
>;
type _attrCard = Expect<
  Equal<(typeof User)["attributes"]["name"]["cardinality"], "one">
>;
type _attrUnique = Expect<
  Equal<(typeof User)["attributes"]["name"]["unique"], "identity">
>;
type _manyCard = Expect<
  Equal<(typeof User)["attributes"]["friends"]["cardinality"], "many">
>;
type _nameType = Expect<
  Equal<Schema.Schema.Type<(typeof User)["attributes"]["name"]["schema"]>, string>
>;
type _ageType = Expect<
  Equal<Schema.Schema.Type<(typeof User)["attributes"]["age"]["schema"]>, number>
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
  Equal<(typeof User)["name"]["valueType"], ":db.type/string">
>;
type _ageVt = Expect<
  Equal<(typeof User)["age"]["valueType"], ":db.type/long">
>;
type _friendsVt = Expect<
  Equal<(typeof User)["friends"]["valueType"], ":db.type/ref">
>;

// helpers + primitives stamp valueType; explicit valueType overrides
const Typed = Namespace("typed", {
  s: Attr(Schema.String),
  n: Attr(Schema.Number),
  b: Attr(Schema.Boolean),
  l: Attr(Long),
  r: Attr(Ref),
  u: Attr(Uuid),
  us: Attr(UuidString),
  i: Attr(Instant),
  by: Attr(Bytes),
  override: Attr(Schema.String, { valueType: ":db.type/uuid" }),
});
type _sVt = Expect<Equal<(typeof Typed)["s"]["valueType"], ":db.type/string">>;
type _nVt = Expect<Equal<(typeof Typed)["n"]["valueType"], ":db.type/double">>;
type _bVt = Expect<Equal<(typeof Typed)["b"]["valueType"], ":db.type/boolean">>;
type _lVt = Expect<Equal<(typeof Typed)["l"]["valueType"], ":db.type/long">>;
type _rVt = Expect<Equal<(typeof Typed)["r"]["valueType"], ":db.type/ref">>;
type _uVt = Expect<Equal<(typeof Typed)["u"]["valueType"], ":db.type/uuid">>;
type _usVt = Expect<Equal<(typeof Typed)["us"]["valueType"], ":db.type/uuid">>;
type _iVt = Expect<Equal<(typeof Typed)["i"]["valueType"], ":db.type/instant">>;
type _byVt = Expect<Equal<(typeof Typed)["by"]["valueType"], ":db.type/bytes">>;
type _overrideVt = Expect<
  Equal<(typeof Typed)["override"]["valueType"], ":db.type/uuid">
>;

/**
 * Componenthood is inferred as a *type*, not just a flag: `attr.reverse` reads
 * it to decide whether the backlink is one entity or a collection.
 */
const Owned = Namespace("owned", {
  part: Attr(Ref, { isComponent: true }),
  peer: Attr(Ref, { cardinality: "many" }),
  plain: Attr(Ref),
  label: Attr(Schema.String),
});
type _componentTrue = Expect<Equal<(typeof Owned)["part"]["isComponent"], true>>;
type _componentFalse = Expect<Equal<(typeof Owned)["peer"]["isComponent"], false>>;
type _componentDefault = Expect<
  Equal<(typeof Owned)["plain"]["isComponent"], false>
>;
type _componentScalar = Expect<
  Equal<(typeof Owned)["label"]["isComponent"], false>
>;
/** an attribute whose componenthood is not statically known stays `boolean` */
type _componentAny = Expect<Equal<AnyAttribute["isComponent"], boolean>>;

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
type _dbCatalog = Expect<Equal<(typeof movies)["catalog"], typeof Movies>>;
type _dbName = Expect<Equal<(typeof movies)["name"], string>>;

// a different catalog is a different db type
const Other = Catalog({
  tag: Namespace("tag", { label: Attr(Schema.String) }),
});
const other = ramose.db("other", Other);
type _notSame = Expect<Equal<Equal<typeof movies, typeof other>, false>>;

// ── asOf / history preserve the catalog and drop the write half ────────────

const asOf = movies.asOf(3);
const hist = movies.history;
type _asOf = Expect<Equal<typeof asOf, ReadDb<typeof Movies>>>;
type _hist = Expect<Equal<typeof hist, ReadDb<typeof Movies>>>;
type _asOfCatalog = Expect<Equal<(typeof asOf)["catalog"], typeof Movies>>;
type _asOfNoWrite = Expect<
  Equal<"transact" extends keyof typeof asOf ? true : false, false>
>;
/** `history` is a property, not a method — a view is a value. */
type _histIsProperty = Expect<
  Equal<typeof hist extends (...args: never) => unknown ? true : false, false>
>;

// ── the transaction is the generator, and reports a TxReport ───────────────

const written = movies.transact(function* (tx) {
  const ada = yield* tx.entity();
  yield* ada.add(User.name, "Ada");
  yield* ada.add(User.age, 36);
  yield* ada.add(Meta.source, "import");
  yield* ada.retract(User.age, 35);
  const arrival = yield* tx.entity();
  yield* arrival.add(Movie.title, "Arrival");
  yield* tx.retract(1001, User.age, 36);
  yield* tx.retractEntity(1001);
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
  .transact(function* (tx) {
    const e = yield* tx.entity();
    yield* e.add(User.name, "Ada");
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
    }),
  );
type _caught = Expect<
  Equal<Effect.Success<typeof caught>, TxReport<typeof Movies> | string>
>;
type _caughtErr = Expect<Equal<Effect.Error<typeof caught>, never>>;

// ── §2 of docs/API.md, name by name ────────────────────────────────────────
//
// `db-portable.test.ts` pins that the barrel exports *these names and no
// others*; `surface.test.ts` does the same for `ramose`. What is left
// is the signature each table row promises, which is a compile-time claim.

/** `ClientOptions` — url, a token in either form, and the two injection seams. */
type _optUrl = Expect<Equal<ClientOptions["url"], string>>;
type _optToken = Expect<
  Equal<
    ClientOptions["token"],
    | Effect.Effect<Redacted.Redacted<string>, DbError>
    | TokenSource
    | undefined
  >
>;
type _optFetch = Expect<Equal<ClientOptions["fetch"], typeof fetch | undefined>>;
type _optWs = Expect<
  Equal<ClientOptions["webSocket"], typeof WebSocket | undefined>
>;
/** A static token is one expression, with nothing else to supply. */
const _staticToken: ClientOptions["token"] = Effect.succeed(
  Redacted.make("t"),
);
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

/** `Db<C>` is `ReadDb<C>` plus `principal`, `transact` and `install`, and nothing else. */
type _readDbKeys = Expect<
  Equal<keyof ReadDb<typeof Movies>, "name" | "catalog" | "q" | "pull" | "livePull" | "live" | "basis" | "asOf" | "history">
>;
type _dbKeys = Expect<
  Equal<Exclude<keyof Db<typeof Movies>, keyof ReadDb<typeof Movies>>, "principal" | "transact" | "install">
>;
type _dbExtendsRead = Expect<Extends<Db<typeof Movies>, ReadDb<typeof Movies>>>;

/** `db.install()` — an idempotent catalog upsert, reported like any tx. */
const installed = movies.install();
type _install = Expect<
  Equal<typeof installed, Effect.Effect<TxReport<typeof Movies>, DbError>>
>;

/** `db.principal()` — who am I; the eid is typed against this db's catalog. */
const me = movies.principal();
type _principal = Expect<
  Equal<typeof me, Effect.Effect<DbPrincipal<typeof Movies>, DbError>>
>;
type _principalEid = Expect<
  Equal<DbPrincipal<typeof Movies>["eid"], Eid<typeof Movies> | null>
>;

/** `db.pull` — `null` when a required field is missing, never `undefined`. */
const pulled = movies.pull(eid, { name: User.name });
type _pullOk = Expect<
  Equal<Effect.Success<typeof pulled>, { readonly name: string } | null>
>;
type _pullErr = Expect<Equal<Effect.Error<typeof pulled>, DbError>>;
type _pullR = Expect<Equal<Effect.Services<typeof pulled>, never>>;

/** …and a `LookupRef` on a unique attribute is the other subject form. */
const byLookup = movies.pull([User.name, "Ada"], { name: User.name });
type _lookupIsSubject = Expect<
  Equal<Effect.Success<typeof byLookup>, Effect.Success<typeof pulled>>
>;
declare const lookup: LookupRef<typeof Movies>;
type _lookupPair = Expect<Extends<typeof lookup, readonly [unknown, unknown]>>;
/** …and only on a unique attribute: `:user/age` resolves nothing. */
// @ts-expect-error :user/age is not unique, so it is not a lookup ref
movies.pull([User.age, 30], { name: User.name });
// @ts-expect-error same, spelled as the ident
movies.pull([":user/age", 30], { name: User.name });

/** `Entity<C>` — the handle `tx.entity()` returns: `eid`, `add`, `retract`. */
type _entityKeys = Expect<
  Equal<
    Exclude<keyof Entity<typeof Movies>, "_tag">,
    "eid" | "add" | "retract" | "retractEntity"
  >
>;
type _entityEid = Expect<Extends<Entity<typeof Movies>["eid"], EntityRef<typeof Movies>>>;

/** `TxReport<C>` — exactly the four fields the table lists. */
type _reportKeys = Expect<
  Equal<keyof TxReport<typeof Movies>, "t" | "txEid" | "datomCount" | "dbAfter">
>;
type _reportT = Expect<Equal<TxReport<typeof Movies>["t"], number>>;
type _reportCount = Expect<
  Equal<TxReport<typeof Movies>["datomCount"], number>
>;

/** `Catalog.Any` is the bound catalog-generic helpers are written against. */
const anyCatalog = <C extends Catalog.Any>(db: Db<C>): C => db.catalog;
type _anyCatalog = Expect<
  Equal<ReturnType<typeof anyCatalog<typeof Movies>>, typeof Movies>
>;
type _moviesIsAny = Expect<Extends<typeof Movies, Catalog.Any>>;

/** `Attribute` / `Namespace` / `Catalog` are types as well as constructors. */
type _attributeTag = Expect<Equal<Attribute["_tag"], "Attribute">>;
type _attributeIsAttribute = Expect<Extends<(typeof User)["name"], AnyAttribute>>;
type _namespaceTag = Expect<Equal<Namespace["_tag"], "Namespace">>;
type _namespaceIsNamespace = Expect<Extends<typeof User, AnyNamespace>>;
type _catalogTag = Expect<Equal<Catalog["_tag"], "Catalog">>;
type _catalogIsCatalog = Expect<Extends<typeof Movies, Catalog>>;

/** `DbError` is the union of exactly the eight tagged errors. */
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
  >
>;
