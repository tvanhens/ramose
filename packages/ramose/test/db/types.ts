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
  type FieldOptions,
  Bytes,
  Schema as DbSchema,
  type CatalogIdent,
  type ClientOptions,
  type Databases,
  type DatabasesShape,
  type Db,
  type DbError,
  type DbPrincipal,
  type IncompatibleSchema,
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
  type TxCasField,
  type TxField,
  Ref,
  type TokenSource,
  token,
  type TxReport,
  Uuid,
  stored,
  type InferDbValueType,
  type ValueAtIdent,
  Enum,
  boolean,
  bytes,
  float,
  int,
  string,
  timestamp,
  uuid,
  layer,
} from "../../src/db/internal.ts";

import { Movies, User } from "./fixture.ts";

// ── catalog / namespace / attr inference ───────────────────────────────────

export type _nsName = Expect<Equal<(typeof User)["ns"], "user">>;
export type _attrIdent = Expect<
  Equal<(typeof User)["fields"]["name"]["ident"], ":user/name">
>;
export type _userNameRef = Expect<
  Equal<(typeof User)["name"]["ident"], ":user/name">
>;
export type _attrCard = Expect<
  Equal<(typeof User)["fields"]["name"]["cardinality"], "one">
>;
export type _attrUnique = Expect<
  Equal<(typeof User)["fields"]["name"]["unique"], "upsert">
>;
export type _manyCard = Expect<
  Equal<(typeof User)["fields"]["friends"]["cardinality"], "many">
>;
export type _nameType = Expect<
  Equal<Schema.Schema.Type<(typeof User)["fields"]["name"]["schema"]>, string>
>;
export type _ageType = Expect<
  Equal<Schema.Schema.Type<(typeof User)["fields"]["age"]["schema"]>, number>
>;
export type _idents = Expect<
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
export type _valueName = Expect<Equal<ValueAtIdent<typeof Movies, ":user/name">, string>>;
export type _valueFriends = Expect<
  Equal<ValueAtIdent<typeof Movies, ":user/friends">, number>
>;
export type _nameVt = Expect<
  Equal<(typeof User)["name"]["valueType"], "string">
>;
export type _ageVt = Expect<
  Equal<(typeof User)["age"]["valueType"], "long">
>;
export type _friendsVt = Expect<
  Equal<(typeof User)["friends"]["valueType"], "ref">
>;

// helpers + primitives stamp valueType; stored() brands a custom pair
const Typed = Entity("typed", {
  s: Field(Schema.String),
  n: Field(Schema.Finite),
  b: Field(Schema.Boolean),
  l: Field(Long),
  r: Field(Ref.self),
  u: Field(Uuid),
  i: Field(Instant),
  by: Field(Bytes),
  override: Field(stored(Schema.String, "uuid")),
});
export type _sVt = Expect<Equal<(typeof Typed)["s"]["valueType"], "string">>;
export type _nVt = Expect<Equal<(typeof Typed)["n"]["valueType"], "double">>;
export type _bVt = Expect<Equal<(typeof Typed)["b"]["valueType"], "boolean">>;
export type _lVt = Expect<Equal<(typeof Typed)["l"]["valueType"], "long">>;
export type _rVt = Expect<Equal<(typeof Typed)["r"]["valueType"], "ref">>;
export type _uVt = Expect<Equal<(typeof Typed)["u"]["valueType"], "uuid">>;
export type _iVt = Expect<Equal<(typeof Typed)["i"]["valueType"], "instant">>;
export type _byVt = Expect<Equal<(typeof Typed)["by"]["valueType"], "bytes">>;
export type _overrideVt = Expect<
  Equal<(typeof Typed)["override"]["valueType"], "uuid">
>;
export type _uuidIsString = Expect<
  Equal<Schema.Schema.Type<(typeof Typed)["u"]["schema"]>, string>
>;

// fail-closed: a literal union does not silently become "string"
const literalUnion = Schema.Literals(["todo", "done"]);
export type _literalUnionVt = Expect<Equal<InferDbValueType<typeof literalUnion>, undefined>>;
// @ts-expect-error Schema.Literals is not a String AST — wrap with stored
Field(literalUnion);
const literalsOk = Field(stored(literalUnion, "string"));
export type _literalsVt = Expect<Equal<(typeof literalsOk)["valueType"], "string">>;

const numberLiterals = Schema.Literals([1, 2, 3]);
export type _numberLiteralsVt = Expect<
  Equal<InferDbValueType<typeof numberLiterals>, undefined>
>;
// @ts-expect-error number-literal union is not a Number AST — wrap with stored
Field(numberLiterals);
const numberLiteralsOk = Field(stored(numberLiterals, "long"));
export type _numberLiteralsOkVt = Expect<
  Equal<(typeof numberLiteralsOk)["valueType"], "long">
>;

export type _dateVt = Expect<Equal<InferDbValueType<typeof Schema.Date>, undefined>>;
// @ts-expect-error Date is a Declaration AST — wrap with stored or use timestamp()
Field(Schema.Date);
const dateOk = Field(stored(Schema.Date, "instant"));
export type _dateOkVt = Expect<Equal<(typeof dateOk)["valueType"], "instant">>;

const structSchema = Schema.Struct({ x: Schema.String });
export type _structVt = Expect<Equal<InferDbValueType<typeof structSchema>, undefined>>;
// @ts-expect-error struct is not a primitive AST — wrap with stored
Field(structSchema);
void numberLiteralsOk;
void dateOk;

// bag override is gone; mismatched stored() pairs are rejected
// @ts-expect-error valueType is not a Field option
Field(Schema.Boolean, { valueType: "string" });
// @ts-expect-error boolean codec does not pair with "string"
stored(Schema.Boolean, "string");
// @ts-expect-error string codec does not pair with "boolean"
stored(Schema.String, "boolean");
// @ts-expect-error Date codec does not pair with "string"
stored(Schema.Date, "string");
const storedOk = stored(Schema.Boolean, "boolean");
export type _storedOk = Expect<Equal<(typeof storedOk) extends { readonly ast: unknown } ? true : false, true>>;
const storedUuid = stored(Schema.String, "uuid");
const storedLiterals = stored(Schema.Literals(["on", "off"]), "string");
const storedOptional = stored(Schema.optional(Schema.String), "string");
// same-vt re-brand is a no-op; a different vt (or a second stored) is not
const sameVtRebrand = Field(stored(Uuid, "uuid"));
export type _sameVtRebrand = Expect<Equal<(typeof sameVtRebrand)["valueType"], "uuid">>;
// @ts-expect-error Uuid is already branded — pass the unbranded Schema
Field(stored(Uuid, "string"));
// @ts-expect-error Long is already branded — pass the unbranded Schema
stored(Long, "double");
// @ts-expect-error stored() output is already branded
stored(stored(Schema.String, "uuid"), "string");
void storedOk;
void storedUuid;
void storedLiterals;
void storedOptional;
void sameVtRebrand;

// shorthands + composition
const Short = Entity("short", {
  title: string(),
  done: boolean(),
  n: int(),
  rank: float(),
  at: timestamp(),
  uid: uuid(),
  blob: bytes(),
  pri: Enum(["low", "med", "high"]),
  owner: Ref(User),
  tags: Field.many(Ref(User)),
  slug: Field.unique(string(), "upsert"),
  named: Field.unique(string({ doc: "display" }), "upsert"),
});
export type _shortTitle = Expect<Equal<(typeof Short)["title"]["valueType"], "string">>;
export type _shortDone = Expect<Equal<(typeof Short)["done"]["valueType"], "boolean">>;
export type _shortN = Expect<Equal<(typeof Short)["n"]["valueType"], "long">>;
export type _shortRank = Expect<Equal<(typeof Short)["rank"]["valueType"], "double">>;
export type _shortAt = Expect<Equal<(typeof Short)["at"]["valueType"], "instant">>;
export type _shortId = Expect<Equal<(typeof Short)["uid"]["valueType"], "uuid">>;
export type _shortBlob = Expect<Equal<(typeof Short)["blob"]["valueType"], "bytes">>;
export type _shortPri = Expect<Equal<(typeof Short)["pri"]["valueType"], "string">>;
export type _shortPriType = Expect<
  Equal<Schema.Schema.Type<(typeof Short)["pri"]["schema"]>, "low" | "med" | "high">
>;
export type _shortPriMembers = Expect<
  Equal<(typeof Short)["pri"]["members"], readonly ["low", "med", "high"]>
>;
export type _shortOwner = Expect<Equal<(typeof Short)["owner"]["valueType"], "ref">>;
export type _shortTags = Expect<Equal<(typeof Short)["tags"]["cardinality"], "many">>;
export type _shortSlug = Expect<Equal<(typeof Short)["slug"]["unique"], "upsert">>;
export type _shortNamed = Expect<Equal<(typeof Short)["named"]["unique"], "upsert">>;

// composition merge — types match applyField (valueType stays; owned composes)
const manyOwned = Field.many(Field.owned(string()));
export type _manyOwned = Expect<Equal<(typeof manyOwned)["owned"], true>>;
export type _manyOwnedCard = Expect<Equal<(typeof manyOwned)["cardinality"], "many">>;
export type _manyOwnedVt = Expect<Equal<(typeof manyOwned)["valueType"], "string">>;
const uniqueOwned = Field.unique(Field.owned(string()), "upsert");
export type _uniqueOwned = Expect<Equal<(typeof uniqueOwned)["owned"], true>>;
export type _uniqueOwnedMode = Expect<Equal<(typeof uniqueOwned)["unique"], "upsert">>;
const ownedKept = Field(Field.owned(string()), { doc: "keep" });
export type _ownedKept = Expect<Equal<(typeof ownedKept)["owned"], true>>;
const composedVt = Field.unique(string(), "upsert");
export type _composedVt = Expect<Equal<(typeof composedVt)["valueType"], "string">>;
// annotating the bag cannot erase cardinality / uniqueness / ownership
const annotatedBag: FieldOptions = { doc: "shared" };
const annotatedMany = Field.many(string(), annotatedBag);
export type _annotatedMany = Expect<Equal<(typeof annotatedMany)["cardinality"], "many">>;
const annotatedUnique = Field.unique(string(), "strict", annotatedBag);
export type _annotatedUnique = Expect<Equal<(typeof annotatedUnique)["unique"], "strict">>;
const annotatedOwned = Field.owned(string(), annotatedBag);
export type _annotatedOwned = Expect<Equal<(typeof annotatedOwned)["owned"], true>>;
// @ts-expect-error cardinality is not a field option
const _noCardOpt: FieldOptions = { cardinality: "many" };
// @ts-expect-error unique is not a field option
const _noUniqueOpt: FieldOptions = { unique: "upsert" };
// @ts-expect-error owned is not a field option
const _noOwnedOpt: FieldOptions = { owned: true };
void _noCardOpt;
void _noUniqueOpt;
void _noOwnedOpt;
const schemaOverride = Field(stored(Schema.String, "uuid"));
export type _schemaOverride = Expect<Equal<(typeof schemaOverride)["valueType"], "uuid">>;
const bareRef = Field(Ref);
export type _bareRefVt = Expect<Equal<(typeof bareRef)["valueType"], "ref">>;
// @ts-expect-error valueType is not a Field option
Field(string(), { valueType: "long" });
// @ts-expect-error valueType is not a Field option
Field.many(string(), { valueType: "long" });
// @ts-expect-error valueType is not a Field option
Field.unique(string(), "upsert", { valueType: "long" });

/**
 * Componenthood is inferred as a *type*, not just a flag: `attr.reverse` reads
 * it to decide whether the backlink is one entity or a collection.
 */
const Owned = Entity("owned", {
  part: Field.owned(Ref.self),
  peer: Field.many(Ref.self),
  plain: Field(Ref.self),
  label: Field(Schema.String),
});
export type _componentTrue = Expect<Equal<(typeof Owned)["part"]["owned"], true>>;
export type _componentFalse = Expect<Equal<(typeof Owned)["peer"]["owned"], false>>;
export type _componentDefault = Expect<
  Equal<(typeof Owned)["plain"]["owned"], false>
>;
export type _componentScalar = Expect<
  Equal<(typeof Owned)["label"]["owned"], false>
>;
/** an attribute whose componenthood is not statically known stays `boolean` */
export type _componentAny = Expect<Equal<AnyField["owned"], boolean>>;

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
export type _layer = Expect<Equal<typeof built, Layer.Layer<Databases, never, never>>>;

declare const ramose: DatabasesShape;
const movies = ramose.db("movies", Movies);
export type _dbIsDb = Expect<Equal<typeof movies, Db<typeof Movies>>>;
export type _dbCatalog = Expect<Equal<(typeof movies)["schema"], typeof Movies>>;
export type _dbName = Expect<Equal<(typeof movies)["name"], string>>;

// a different catalog is a different db type
const Other = DbSchema({
  tag: Entity("tag", { label: Field(Schema.String) }),
});
const other = ramose.db("other", Other);
export type _notSame = Expect<Equal<Equal<typeof movies, typeof other>, false>>;

// ── asOf / history preserve the catalog and drop the write half ────────────

const asOf = movies.asOf(3);
const hist = movies.history;
export type _asOf = Expect<Equal<typeof asOf, ReadDb<typeof Movies>>>;
export type _hist = Expect<Equal<typeof hist, ReadDb<typeof Movies>>>;
export type _asOfCatalog = Expect<Equal<(typeof asOf)["schema"], typeof Movies>>;
export type _asOfNoWrite = Expect<
  Equal<"transact" extends keyof typeof asOf ? true : false, false>
>;
/** `history` is a property, not a method — a view is a value. */
export type _histIsProperty = Expect<
  Equal<typeof hist extends (...args: never) => unknown ? true : false, false>
>;

// ── install reports a TxReport; transact is gone from both surfaces ────────

const installed = movies.effect.install();
export type _writtenOk = Expect<
  Equal<Effect.Success<typeof installed>, TxReport<typeof Movies>>
>;
export type _writtenErr = Expect<
  Equal<Effect.Error<typeof installed>, DbError | IncompatibleSchema>
>;
/** Every signature's `R` is `never`. */
export type _writtenR = Expect<Equal<Effect.Services<typeof installed>, never>>;
export type _noPromiseTransact = Expect<
  Equal<"transact" extends keyof typeof movies ? true : false, false>
>;
export type _noHatchTransact = Expect<
  Equal<"transact" extends keyof (typeof movies)["effect"] ? true : false, false>
>;

// `dbAfter` is the same `Db`, so it composes without a cast
declare const report: TxReport<typeof Movies>;
export type _dbAfter = Expect<Equal<typeof report.dbAfter, Db<typeof Movies>>>;
export type _txEid = Expect<Equal<typeof report.txEid, Eid<typeof Movies>>>;

// ── eids are data ──────────────────────────────────────────────────────────

declare const eid: Eid<typeof Movies>;
export type _eidIsNumber = Expect<Extends<typeof eid, number>>;
// no methods and no I/O: `Eid` is a branded number
export type _eidNoPull = Expect<Equal<"pull" extends keyof typeof eid ? true : false, false>>;
// a bare string is not an EntityRef — use tempid("ada")
// @ts-expect-error a bare string is not a tempid
const _stringRef: EntityRef<typeof Movies> = "oops-typo-not-a-tempid";

// ── tagged errors remain on the Effect (catchTags still typechecks) ────────

const caught = movies
  .effect.install()
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
      IncompatibleSchema: (e) => Effect.succeed(e.message),
    }),
  );
export type _caught = Expect<
  Equal<Effect.Success<typeof caught>, TxReport<typeof Movies> | string>
>;
export type _caughtErr = Expect<Equal<Effect.Error<typeof caught>, never>>;

// ── the public surface (ramose.ai/reference/client-api), name by name ──────
//
// `db-portable.test.ts` pins that the barrel exports *these names and no
// others*; `surface.test.ts` does the same for `ramose`. What is left
// is the signature each table row promises, which is a compile-time claim.

/** `ClientOptions` — url, a token in either form, and the two injection seams. */
export type _optUrl = Expect<Equal<ClientOptions["url"], string>>;
export type _optToken = Expect<
  Equal<
    ClientOptions["token"],
    string | TokenSource | (() => string | Promise<string>) | undefined
  >
>;
export type _optFetch = Expect<Equal<ClientOptions["fetch"], typeof fetch | undefined>>;
export type _optWs = Expect<
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
export type _databasesShape = Expect<Equal<keyof DatabasesShape, "db">>;

/** `Db<C>` is `ReadDb<C>` plus `principal`, `install`, `run` and the hatch. */
export type _readDbKeys = Expect<
  Equal<keyof ReadDb<typeof Movies>, "name" | "schema" | "query" | "pull" | "livePull" | "live" | "basis" | "asOf" | "history" | "effect">
>;
export type _dbKeys = Expect<
  Equal<Exclude<keyof Db<typeof Movies>, keyof ReadDb<typeof Movies>>, "principal" | "install" | "run">
>;
export type _dbExtendsRead = Expect<Extends<Db<typeof Movies>, ReadDb<typeof Movies>>>;

/** `db.install()` — an idempotent catalog upsert, reported like any tx. */
const installedP = movies.install();
export type _install = Expect<
  Equal<typeof installedP, Promise<TxReport<typeof Movies>>>
>;
const installedHatch = movies.install({ allowIncompatible: [":user/name"] });
export type _installHatch = Expect<
  Equal<typeof installedHatch, Promise<TxReport<typeof Movies>>>
>;

/** `db.principal()` — who am I; the eid is typed against this db's catalog. */
const me = movies.principal();
export type _principal = Expect<
  Equal<typeof me, Promise<DbPrincipal<typeof Movies>>>
>;
export type _principalEid = Expect<
  Equal<DbPrincipal<typeof Movies>["eid"], Eid<typeof Movies> | null>
>;

/** `db.pull` — `null` when a required field is missing, never `undefined`. */
const pulled = movies.pull(eid, { name: User.name });
export type _pullOk = Expect<
  Equal<Awaited<typeof pulled>, { readonly name: string } | null>
>;

/** …and a `LookupRef` on a unique attribute is the other subject form. */
const byLookup = movies.pull([User.name, "Ada"], { name: User.name });
export type _lookupIsSubject = Expect<
  Equal<Awaited<typeof byLookup>, Awaited<typeof pulled>>
>;
declare const lookup: LookupRef<typeof Movies>;
export type _lookupPair = Expect<Extends<typeof lookup, readonly [unknown, unknown]>>;
/** …and only on a unique attribute: `:user/age` resolves nothing. */
// @ts-expect-error :user/age is not unique, so it is not a lookup ref
movies.pull([User.age, 30], { name: User.name });
// @ts-expect-error same, spelled as the ident
movies.pull([":user/age", 30], { name: User.name });

/** `TxHandle<C>` — the handle `tx.entity()` returns: `eid`, `set`, `cas`, `remove`. */
export type _entityKeys = Expect<
  Equal<
    Exclude<keyof TxHandle<typeof Movies>, "_tag">,
    "eid" | "set" | "cas" | "remove" | "delete"
  >
>;
export type _entityEid = Expect<Extends<TxHandle<typeof Movies>["eid"], EntityRef<typeof Movies>>>;

/** `TxReport<C>` — exactly the four fields the table lists. */
export type _reportKeys = Expect<
  Equal<keyof TxReport<typeof Movies>, "t" | "txEid" | "datomCount" | "dbAfter">
>;
export type _reportT = Expect<Equal<TxReport<typeof Movies>["t"], number>>;
export type _reportCount = Expect<
  Equal<TxReport<typeof Movies>["datomCount"], number>
>;

/** `DbSchema.Any` is the bound catalog-generic helpers are written against. */
const anyCatalog = <C extends DbSchema.Any>(db: Db<C>): C => db.schema;
export type _anyCatalog = Expect<
  Equal<ReturnType<typeof anyCatalog<typeof Movies>>, typeof Movies>
>;
export type _moviesIsAny = Expect<Extends<typeof Movies, DbSchema.Any>>;
export type _erasedCasField = Expect<Extends<TxCasField<DbSchema.Any>, TxField<DbSchema.Any>>>;

/** `Field` / `Entity` / `Schema` are types as well as constructors. */
export type _attributeTag = Expect<Equal<Field["_tag"], "Field">>;
export type _attributeIsAttribute = Expect<Extends<(typeof User)["name"], AnyField>>;
export type _namespaceTag = Expect<Equal<Entity["_tag"], "Entity">>;
export type _namespaceIsNamespace = Expect<Extends<typeof User, AnyEntity>>;
export type _catalogTag = Expect<Equal<(typeof Movies)["_tag"], "Schema">>;
export type _catalogIsCatalog = Expect<Extends<typeof Movies, DbSchema.Any>>;

/** `DbError` is the union of the tagged errors a write or read can raise. */
export type _dbErrorUnion = Expect<
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
