/**
 * `install()` schema-evolution check: incompatible flips are named errors;
 * compatible adds stay silent; `allowIncompatible` is the opt-in.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Connection,
  QueryError,
  QueryParseError,
  TxError,
  fromJson,
  query,
  toJson,
  toWireDatom,
} from "../../src/internal/core/index.ts";
import {
  Entity,
  Field,
  IncompatibleSchema,
  Long,
  Schema as DbSchema,
  assembleInstalled,
  checkEvolution,
  incompatibleMessage,
  installedCoreQuery,
  installedOptionalQuery,
  installedUniqueQuery,
  installTx,
  isRequiredAttr,
  isSystemIdent,
  makeDatabases,
  namespaceOf,
  namespacesNeedingOccupancy,
  occupancyIdents,
  optionalRetracts,
  schemaTx,
  seedWrite,
} from "../../src/db/internal.ts";
import { TxRejected } from "../../src/db/Errors.ts";

const Note = Entity("note", {
  title: Field(Schema.String),
  body: Field(Schema.String, { optional: true }),
});
const Notes = DbSchema({ note: Note });

const title: import("../../src/db/evolution.ts").InstalledAttr = {
  ident: ":note/title",
  valueType: ":db.type/string",
  cardinality: ":db.cardinality/one",
};
const body: import("../../src/db/evolution.ts").InstalledAttr = {
  ident: ":note/body",
  valueType: ":db.type/string",
  cardinality: ":db.cardinality/one",
  optional: true,
};

describe("evolution helpers", () => {
  test("namespaceOf / isSystemIdent", () => {
    expect(namespaceOf(":note/title")).toBe("note");
    expect(namespaceOf(":db/ident")).toBe("db");
    expect(isSystemIdent(":db/ident")).toBe(true);
    expect(isSystemIdent(":note/title")).toBe(false);
  });

  test("card-many is never required", () => {
    expect(isRequiredAttr({ cardinality: ":db.cardinality/many" })).toBe(false);
    expect(isRequiredAttr({ cardinality: ":db.cardinality/one" })).toBe(true);
    expect(
      isRequiredAttr({ cardinality: ":db.cardinality/one", optional: true }),
    ).toBe(false);
  });

  test("assembleInstalled drops :db/* and joins unique / optional", () => {
    const assembled = assembleInstalled(
      [
        {
          e: { id: 10 },
          ident: ":db/ident",
          valueType: ":db.type/string",
          cardinality: ":db.cardinality/one",
        },
        {
          e: { id: 2001 },
          ident: ":note/title",
          valueType: ":db.type/string",
          cardinality: ":db.cardinality/one",
        },
        {
          e: { id: 2002 },
          ident: ":note/body",
          valueType: ":db.type/string",
          cardinality: ":db.cardinality/one",
        },
      ],
      [{ e: { id: 2001 }, unique: ":db.unique/identity" }],
      [{ e: { id: 2002 }, optional: true }],
    );
    expect(assembled).toEqual([
      {
        e: 2001,
        ident: ":note/title",
        valueType: ":db.type/string",
        cardinality: ":db.cardinality/one",
        unique: ":db.unique/identity",
      },
      {
        e: 2002,
        ident: ":note/body",
        valueType: ":db.type/string",
        cardinality: ":db.cardinality/one",
        optional: true,
      },
    ]);
  });
});

describe("checkEvolution", () => {
  test("a matching re-install is silent", () => {
    expect(checkEvolution(schemaTx(Notes), [title, body], new Set())).toBeUndefined();
  });

  test("a new optional field is silent", () => {
    const Grown = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String),
        body: Field(Schema.String, { optional: true }),
        tag: Field(Schema.String, { optional: true }),
      }),
    });
    expect(checkEvolution(schemaTx(Grown), [title, body], new Set(["note"]))).toBeUndefined();
  });

  test("a new namespace is silent, even with required fields", () => {
    const Grown = DbSchema({
      note: Note,
      tag: Entity("tag", { label: Field(Schema.String) }),
    });
    expect(checkEvolution(schemaTx(Grown), [title, body], new Set(["note"]))).toBeUndefined();
  });

  test("a value-type flip is IncompatibleSchema", () => {
    const Flipped = DbSchema({
      note: Entity("note", {
        title: Field(Long),
        body: Field(Schema.String, { optional: true }),
      }),
    });
    const e = checkEvolution(schemaTx(Flipped), [title, body], new Set());
    expect(e).toBeInstanceOf(IncompatibleSchema);
    expect(e?._tag).toBe("IncompatibleSchema");
    expect(e?.changes).toEqual([
      {
        ident: ":note/title",
        kind: "valueType",
        from: ":db.type/string",
        to: ":db.type/long",
      },
    ]);
    expect(e?.message).toContain(":note/title valueType :db.type/string → :db.type/long");
    expect(e?.message).toContain('allowIncompatible: [":note/title"]');
  });

  test("a cardinality flip is IncompatibleSchema", () => {
    const Flipped = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String, { cardinality: "many" }),
        body: Field(Schema.String, { optional: true }),
      }),
    });
    const e = checkEvolution(schemaTx(Flipped), [title, body], new Set());
    expect(e?.changes.map((c) => c.kind)).toEqual(["cardinality"]);
    expect(e?.changes[0]?.from).toBe(":db.cardinality/one");
    expect(e?.changes[0]?.to).toBe(":db.cardinality/many");
  });

  test("a uniqueness flip is IncompatibleSchema", () => {
    const Flipped = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String, { unique: "upsert" }),
        body: Field(Schema.String, { optional: true }),
      }),
    });
    const e = checkEvolution(schemaTx(Flipped), [title, body], new Set());
    expect(e?.changes.map((c) => c.kind)).toEqual(["unique"]);
    expect(e?.changes[0]?.to).toBe(":db.unique/identity");
  });

  test("dropping unique is a silent no-op", () => {
    const UniqueTitle = {
      ...title,
      unique: ":db.unique/identity",
    };
    expect(checkEvolution(schemaTx(Notes), [UniqueTitle, body], new Set())).toBeUndefined();
  });

  test("identity → value uniqueness is IncompatibleSchema", () => {
    const UniqueTitle = {
      ...title,
      unique: ":db.unique/identity",
    };
    const Flipped = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String, { unique: "strict" }),
        body: Field(Schema.String, { optional: true }),
      }),
    });
    const e = checkEvolution(schemaTx(Flipped), [UniqueTitle, body], new Set());
    expect(e?.changes).toEqual([
      {
        ident: ":note/title",
        kind: "unique",
        from: ":db.unique/identity",
        to: ":db.unique/value",
      },
    ]);
  });

  test("a new required field on an occupied namespace is IncompatibleSchema", () => {
    const Grown = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String),
        body: Field(Schema.String, { optional: true }),
        rank: Field(Long),
      }),
    });
    const e = checkEvolution(schemaTx(Grown), [title, body], new Set(["note"]));
    expect(e?.changes).toEqual([{ ident: ":note/rank", kind: "required" }]);
    expect(e?.message).toContain("a default or a migration step is required");
  });

  test("a new required field on an empty namespace is silent", () => {
    const Grown = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String),
        body: Field(Schema.String, { optional: true }),
        rank: Field(Long),
      }),
    });
    expect(checkEvolution(schemaTx(Grown), [title, body], new Set())).toBeUndefined();
  });

  test("optional → required on occupied data is IncompatibleSchema", () => {
    const Tight = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String),
        body: Field(Schema.String),
      }),
    });
    const e = checkEvolution(schemaTx(Tight), [title, body], new Set(["note"]));
    expect(e?.changes).toEqual([{ ident: ":note/body", kind: "required" }]);
  });

  test("allowIncompatible skips listed idents", () => {
    const Flipped = DbSchema({
      note: Entity("note", {
        title: Field(Long),
        body: Field(Schema.String, { optional: true }),
        rank: Field(Long),
      }),
    });
    expect(
      checkEvolution(schemaTx(Flipped), [title, body], new Set(["note"]), {
        allowIncompatible: [":note/title", ":note/rank"],
      }),
    ).toBeUndefined();
  });

  test("allowIncompatible is per-ident — unlisted flips still fail", () => {
    const Flipped = DbSchema({
      note: Entity("note", {
        title: Field(Long),
        body: Field(Schema.String, { optional: true }),
        rank: Field(Long),
      }),
    });
    const e = checkEvolution(schemaTx(Flipped), [title, body], new Set(["note"]), {
      allowIncompatible: [":note/title"],
    });
    expect(e?.changes.map((c) => c.ident)).toEqual([":note/rank"]);
  });

  test("several flips are listed on one error", () => {
    const Flipped = DbSchema({
      note: Entity("note", {
        title: Field(Long, { unique: "strict" }),
        body: Field(Schema.String, { optional: true }),
      }),
    });
    const e = checkEvolution(schemaTx(Flipped), [title, body], new Set());
    expect(e?.changes.map((c) => c.kind).sort()).toEqual(["unique", "valueType"]);
  });

  test("namespacesNeedingOccupancy is only required adds / flips", () => {
    const Grown = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String),
        body: Field(Schema.String, { optional: true }),
        rank: Field(Long),
      }),
    });
    expect(namespacesNeedingOccupancy(schemaTx(Grown), [title, body])).toEqual([
      "note",
    ]);
    expect(
      namespacesNeedingOccupancy(schemaTx(Grown), [title, body], {
        allowIncompatible: [":note/rank"],
      }),
    ).toEqual([]);
    expect(occupancyIdents([title, body], "note")).toEqual([
      ":note/title",
      ":note/body",
    ]);
  });

  test("optionalRetracts uses the attribute eid", () => {
    const Tight = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String),
        body: Field(Schema.String),
      }),
    });
    const installedBody = { ...body, e: 2002 };
    expect(optionalRetracts(schemaTx(Tight), [title, installedBody])).toEqual([
      [":db/retract", 2002, ":db/optional", true],
    ]);
    expect(installTx(schemaTx(Tight), [title, installedBody]).at(-1)).toEqual([
      ":db/retract",
      2002,
      ":db/optional",
      true,
    ]);
  });

  test("optionalRetracts falls back to an ident lookup", () => {
    const Tight = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String),
        body: Field(Schema.String),
      }),
    });
    expect(optionalRetracts(schemaTx(Tight), [title, body])).toEqual([
      [":db/retract", [":db/ident", ":note/body"], ":db/optional", true],
    ]);
  });

  test("incompatibleMessage names the hatch", () => {
    const msg = incompatibleMessage([
      {
        ident: ":note/title",
        kind: "valueType",
        from: ":db.type/string",
        to: ":db.type/long",
      },
    ]);
    expect(msg.startsWith("ramose: install() refused incompatible schema changes:")).toBe(
      true,
    );
    expect(msg).toContain('install({ allowIncompatible: [":note/title"] })');
  });
});

const run = <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<A> =>
  Effect.isEffect(value) ? Effect.runPromise(value) : value;
const runFail = async <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<unknown> => {
  if (Effect.isEffect(value)) return Effect.runPromise(Effect.flip(value));
  try {
    await value;
    throw new Error("expected failure");
  } catch (error) {
    return error;
  }
};

/** HTTPS-only peer so install()'s asOf catalog read hits the engine, not an overlay. */
const peer = async () => {
  const conn = await Connection.create();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init.body === undefined ? {} : fromJson(JSON.parse(String(init.body)));
    try {
      if (path.endsWith("/transact")) {
        const rep = await conn.transact((body as { tx: unknown[] }).tx);
        return new Response(
          JSON.stringify(
            toJson({
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: rep.txData.map(toWireDatom),
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path.endsWith("/query")) {
        const b = body as { query: object; inputs?: unknown[]; asOf?: number };
        let db = conn.db();
        if (typeof b.asOf === "number") db = db.asOf(b.asOf);
        const result = await query(db, b.query, b.inputs ?? []);
        return new Response(
          JSON.stringify(toJson({ t: db.effectiveT, result })),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: `no ${path}` }), { status: 404 });
    } catch (err) {
      if (err instanceof TxError) {
        return new Response(
          JSON.stringify({ error: err.message, tag: "TxRejected", code: err.code }),
          { status: 409 },
        );
      }
      if (err instanceof QueryParseError || err instanceof QueryError) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        { status: 500 },
      );
    }
  }) as unknown as typeof fetch;

  const { databases, close } = makeDatabases({
    url: Effect.succeed("https://peer.local"),
    fetch: (url, init) =>
      fetchImpl(String(url), init as RequestInit) as unknown as Promise<Response>,
  });
  return {
    ramose: databases,
    dispose: () => close(),
  };
};

describe("install() against a live engine", () => {
  test("first install and a matching re-install succeed", async () => {
    const p = await peer();
    const db = p.ramose.db("notes", Notes);
    const first = await db.install();
    const second = await db.install();
    expect(first.t).toBeGreaterThan(0);
    expect(second.t).toBeGreaterThan(first.t);
    await p.dispose();
  });

  test("a new optional field and a new namespace apply silently", async () => {
    const p = await peer();
    await p.ramose.db("notes", Notes).install();
    await run(
      seedWrite(p.ramose.db("notes", Notes), function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Note.title, "hello");
      }),
    );
    const Grown = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String),
        body: Field(Schema.String, { optional: true }),
        tag: Field(Schema.String, { optional: true }),
      }),
      label: Entity("label", { name: Field(Schema.String) }),
    });
    const report = await p.ramose.db("notes", Grown).install();
    expect(report.t).toBeGreaterThan(0);
    await p.dispose();
  });

  test("flipping value type fails with IncompatibleSchema", async () => {
    const p = await peer();
    await p.ramose.db("notes", Notes).install();
    const Flipped = DbSchema({
      note: Entity("note", {
        title: Field(Long),
        body: Field(Schema.String, { optional: true }),
      }),
    });
    const e = await runFail(p.ramose.db("notes", Flipped).install());
    expect(e).toBeInstanceOf(IncompatibleSchema);
    expect((e as IncompatibleSchema).changes[0]).toMatchObject({
      ident: ":note/title",
      kind: "valueType",
    });
    await p.dispose();
  });

  test("a new required field on existing rows fails and names a migration", async () => {
    const p = await peer();
    const db = p.ramose.db("notes", Notes);
    await db.install();
    await run(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Note.title, "hello");
      }),
    );
    const Grown = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String),
        body: Field(Schema.String, { optional: true }),
        rank: Field(Long),
      }),
    });
    const e = await runFail(p.ramose.db("notes", Grown).install());
    expect(e).toBeInstanceOf(IncompatibleSchema);
    expect((e as IncompatibleSchema).changes).toEqual([
      { ident: ":note/rank", kind: "required" },
    ]);
    expect((e as IncompatibleSchema).message).toContain(
      "a default or a migration step is required",
    );
    await p.dispose();
  });

  test("a new required field on a namespace with no rows applies", async () => {
    const p = await peer();
    await p.ramose.db("notes", Notes).install();
    const Grown = DbSchema({
      note: Entity("note", {
        title: Field(Schema.String),
        body: Field(Schema.String, { optional: true }),
        rank: Field(Long),
      }),
    });
    const report = await p.ramose.db("notes", Grown).install();
    expect(report.t).toBeGreaterThan(0);
    await p.dispose();
  });

  test("allowIncompatible applies a listed flip", async () => {
    const p = await peer();
    await p.ramose.db("notes", Notes).install();
    const Flipped = DbSchema({
      note: Entity("note", {
        title: Field(Long),
        body: Field(Schema.String, { optional: true }),
      }),
    });
    const report = await p.ramose.db("notes", Flipped).install({
      allowIncompatible: [":note/title"],
    });
    expect(report.t).toBeGreaterThan(0);
    await p.dispose();
  });

  test("dropping unique stays a no-op — uniqueness is still enforced", async () => {
    const UniqueNote = Entity("note", {
      title: Field(Schema.String, { unique: "strict" }),
      body: Field(Schema.String, { optional: true }),
    });
    const UniqueNotes = DbSchema({ note: UniqueNote });
    const p = await peer();
    const uniqueDb = p.ramose.db("notes", UniqueNotes);
    await uniqueDb.install();
    await run(
      seedWrite(uniqueDb, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(UniqueNote.title, "hello");
      }),
    );
    const after = p.ramose.db("notes", Notes);
    const report = await after.install();
    expect(report.t).toBeGreaterThan(0);
    const snap = after.asOf(Number.MAX_SAFE_INTEGER);
    const installed = assembleInstalled(
      await snap.query(installedCoreQuery),
      await snap.query(installedUniqueQuery),
      await snap.query(installedOptionalQuery),
    );
    expect(installed.find((a) => a.ident === ":note/title")?.unique).toBe(
      ":db.unique/value",
    );
    const err = await runFail(
      seedWrite(after, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Note.title, "hello");
      }),
    );
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/unique-conflict");
    await p.dispose();
  });

  test("optional → required on an empty namespace retracts :db/optional", async () => {
    const TightNote = Entity("note", {
      title: Field(Schema.String),
      body: Field(Schema.String),
    });
    const Tight = DbSchema({ note: TightNote });
    const p = await peer();
    await p.ramose.db("notes", Notes).install();
    const report = await p.ramose.db("notes", Tight).install();
    expect(report.t).toBeGreaterThan(0);
    const err = await runFail(
      seedWrite(p.ramose.db("notes", Notes), function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Note.title, "hello");
      }),
    );
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/required");
    await p.dispose();
  });

  test("allowIncompatible retracts :db/optional on occupied data", async () => {
    const TightNote = Entity("note", {
      title: Field(Schema.String),
      body: Field(Schema.String),
    });
    const Tight = DbSchema({ note: TightNote });
    const p = await peer();
    const db = p.ramose.db("notes", Notes);
    await db.install();
    await run(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Note.title, "hello");
      }),
    );
    const refused = await runFail(p.ramose.db("notes", Tight).install());
    expect(refused).toBeInstanceOf(IncompatibleSchema);
    const report = await p.ramose.db("notes", Tight).install({
      allowIncompatible: [":note/body"],
    });
    expect(report.t).toBeGreaterThan(0);
    const err = await runFail(
      seedWrite(p.ramose.db("notes", Notes), function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Note.title, "other");
      }),
    );
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/required");
    await p.dispose();
  });
});

