/**
 * Required-at-transact (#266) and `op.update` (#265): rejection paths
 * on processTx, the optimistic overlay, and the worker `/op` path.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Connection } from "../src/internal/core/conn.ts";
import { toWireDatom } from "../src/internal/core/index.ts";
import {
  Entity,
  Field,
  Operation,
  Query,
  Ref,
  Schema as DbSchema,
  TxRejected,
  txBuilder,
  type AnySchema,
  txOps,
} from "../src/db/internal.ts";
import { runSync } from "../src/db/promise.ts";
import { rewritePendingTx } from "../src/db/overlay.ts";
import { schemaTx } from "../src/db/ensure.ts";
import { client, fakePeer, settle, type Call } from "./peer.ts";
import { snapshotOf } from "./overlay-seed.ts";
import { Movies, User } from "./db/fixture.ts";

const Person = Entity("person", {
  handle: Field.unique(Schema.String, "upsert"),
  title: Field(Schema.String),
  note: Field(Schema.String, { optional: true }),
  tags: Field.many(Schema.String),
  manager: Field(Ref.self, { optional: true }),
});
const People = DbSchema({ person: Person });

const Movie = Entity("film", {
  title: Field(Schema.String),
});
const Films = DbSchema({ person: Person, film: Movie });

const Label = Entity("label", {
  name: Field.unique(Schema.String, "upsert"),
});
const Doc = Entity("doc", {
  slug: Field.unique(Schema.String, "upsert"),
  title: Field(Schema.String),
  labels: Field.many(Ref(Label)),
});
const Docs = DbSchema({ label: Label, doc: Doc });

const Staff = Entity("staff", {
  handle: Field.unique(Schema.String, "upsert"),
  title: Field(Schema.String),
  manager: Field(Ref.self),
});
const Staffs = DbSchema({ staff: Staff });

const setup = async (catalog: AnySchema = People) => {
  const conn = await Connection.create();
  await conn.transact(schemaTx(catalog) as unknown[]);
  return conn;
};

describe("required-at-transact", () => {
  test("processTx: put missing a required field is tx/required (datom-level too)", async () => {
    const conn = await setup();
    const viaPut = txBuilder(People);
    Effect.runSync(viaPut.put(Person, { handle: "ada" } as never));
    await expect(conn.transact([...txOps(viaPut)])).rejects.toMatchObject({
      code: "tx/required",
    });

    await expect(
      conn.transact([{ ":db/id": "x", ":person/handle": "bea" }]),
    ).rejects.toMatchObject({ code: "tx/required" });
    await expect(
      conn.transact([[":db/add", "y", ":person/handle", "cam"]]),
    ).rejects.toMatchObject({ code: "tx/required" });
  });

  test("processTx: unified/upserting put on an existing row passes", async () => {
    const conn = await setup();
    const first = txBuilder(People);
    Effect.runSync(first.put(Person, { handle: "ada", title: "Eng" }));
    const created = await conn.transact([...txOps(first)]);
    const eid = created.tempids["tmp-1"];
    expect(typeof eid).toBe("number");

    const again = txBuilder(People);
    Effect.runSync(again.put(Person, { handle: "ada", title: "Staff" }));
    const second = await conn.transact([...txOps(again)]);
    expect(second.tempids["tmp-1"]).toBe(eid);
    expect((await conn.db().entity(eid!))?.[":person/title"]).toBe("Staff");
  });

  test("processTx: optional and card-many omitted pass", async () => {
    const conn = await setup();
    const tx = txBuilder(People);
    Effect.runSync(tx.put(Person, { handle: "ada", title: "Eng" }));
    const rep = await conn.transact([...txOps(tx)]);
    const row = await conn.db().entity(rep.tempids["tmp-1"]!);
    expect(row?.[":person/handle"]).toBe("ada");
    expect(row?.[":person/note"]).toBeUndefined();
    expect(row?.[":person/tags"]).toBeUndefined();
  });

  test("processTx: required ref must be supplied", async () => {
    const conn = await setup(Staffs);
    await expect(
      conn.transact([
        { ":db/id": "s", ":staff/handle": "ada", ":staff/title": "Eng" },
      ]),
    ).rejects.toMatchObject({ code: "tx/required" });

    const viaPut = txBuilder(Staffs);
    Effect.runSync(
      viaPut.put(Staff, { handle: "ada", title: "Eng" } as never),
    );
    await expect(conn.transact([...txOps(viaPut)])).rejects.toMatchObject({
      code: "tx/required",
    });
  });

  test("processTx: tx.set on a tempid create is tx/required when a field is missing", async () => {
    const conn = await setup();
    const short = txBuilder(People);
    const e = Effect.runSync(short.entity());
    Effect.runSync(short.set(e, Person.handle, "ada"));
    await expect(conn.transact([...txOps(short)])).rejects.toMatchObject({
      code: "tx/required",
    });

    const full = txBuilder(People);
    const created = Effect.runSync(full.entity());
    Effect.runSync(full.set(created, Person.handle, "ada"));
    Effect.runSync(full.set(created, Person.title, "Eng"));
    const rep = await conn.transact([...txOps(full)]);
    const row = await conn.db().entity(rep.tempids["tmp-1"]!);
    expect(row?.[":person/handle"]).toBe("ada");
    expect(row?.[":person/title"]).toBe("Eng");
  });

  test("processTx: H1 — app attrs on a bootstrap eid are required-checked", async () => {
    const conn = await setup();
    const viaPut = txBuilder(People);
    Effect.runSync(viaPut.put(Person, 10, { title: "no handle" }));
    await expect(conn.transact([...txOps(viaPut)])).rejects.toMatchObject({
      code: "tx/required",
    });
    await expect(
      conn.transact([[":db/add", 10, ":person/title", "no handle"]]),
    ).rejects.toMatchObject({ code: "tx/required" });
  });

  test("processTx: H1 — a numeric eid below FIRST_USER_EID that does not exist is tx/missing-entity", async () => {
    const conn = await setup();
    const viaPut = txBuilder(People);
    Effect.runSync(viaPut.put(Person, 500, { title: "no handle" }));
    await expect(conn.transact([...txOps(viaPut)])).rejects.toMatchObject({
      code: "tx/missing-entity",
    });
  });

  test("processTx: H2 — put / :db/add onto another namespace is tx/wrong-entity", async () => {
    const conn = await setup(Films);
    const film = txBuilder(Films);
    Effect.runSync(film.put(Movie, { title: "Heat" }));
    const made = await conn.transact([...txOps(film)]);
    const filmEid = made.tempids["tmp-1"]!;

    const viaPut = txBuilder(Films);
    Effect.runSync(viaPut.put(Person, filmEid, { title: "nope" }));
    await expect(conn.transact([...txOps(viaPut)])).rejects.toMatchObject({
      code: "tx/wrong-entity",
    });

    const complete = txBuilder(Films);
    Effect.runSync(
      complete.put(Person, filmEid, { handle: "ada", title: "nope" }),
    );
    await expect(conn.transact([...txOps(complete)])).rejects.toMatchObject({
      code: "tx/wrong-entity",
    });

    await expect(
      conn.transact([[":db/add", filmEid, ":person/title", "nope"]]),
    ).rejects.toMatchObject({ code: "tx/wrong-entity" });
  });

  test("processTx: H3 — put / set at a nonexistent numeric eid is tx/missing-entity", async () => {
    const conn = await setup();
    const viaPut = txBuilder(People);
    Effect.runSync(
      viaPut.put(Person, 1008, { handle: "squatter", title: "T" }),
    );
    await expect(conn.transact([...txOps(viaPut)])).rejects.toMatchObject({
      code: "tx/missing-entity",
    });

    const viaSet = txBuilder(People);
    Effect.runSync(viaSet.set(1008, Person.handle, "squatter"));
    await expect(conn.transact([...txOps(viaSet)])).rejects.toMatchObject({
      code: "tx/missing-entity",
    });

    const first = txBuilder(People);
    Effect.runSync(first.put(Person, { handle: "p0", title: "x" }));
    const a = await conn.transact([...txOps(first)]);
    const eid = a.tempids["tmp-1"]!;
    expect(typeof eid).toBe("number");
    expect(await conn.db().entity(1008)).toBeUndefined();
    expect((await conn.db().entity(eid))?.[":person/handle"]).toBe("p0");
  });

  test("processTx: H4 — a dangling ref value is tx/missing-entity", async () => {
    const Team = Entity("team", {
      name: Field(Schema.String),
    });
    const Member = Entity("member", {
      nick: Field(Schema.String),
      team: Field(Ref(Team)),
    });
    const Roster = DbSchema({ team: Team, member: Member });
    const conn = await setup(Roster);

    await expect(
      conn.transact([
        {
          ":db/id": "m",
          ":member/nick": "bob",
          ":member/team": "ghost-string",
        },
      ]),
    ).rejects.toMatchObject({ code: "tx/missing-entity" });

    await expect(
      conn.transact([
        { ":db/id": "m", ":member/nick": "bob", ":member/team": 888888 },
      ]),
    ).rejects.toMatchObject({ code: "tx/missing-entity" });

    const linked = await conn.transact([
      { ":db/id": "t", ":team/name": "eng" },
      { ":db/id": "m", ":member/nick": "bob", ":member/team": "t" },
    ]);
    expect((await conn.db().entity(linked.tempids.m!))?.[":member/team"]).toBe(
      linked.tempids.t,
    );
  });

  test("processTx: clearing a required field is tx/required", async () => {
    const conn = await setup();
    const create = txBuilder(People);
    Effect.runSync(create.put(Person, { handle: "ada", title: "Eng" }));
    const { tempids } = await conn.transact([...txOps(create)]);
    const eid = tempids["tmp-1"]!;

    await expect(
      conn.transact([[":db/retract", eid, ":person/title"]]),
    ).rejects.toMatchObject({ code: "tx/required" });

    const noteGone = await conn.transact([[":db/retract", eid, ":person/note"]]);
    expect(noteGone.t).toBeGreaterThan(0);
  });

  test("processTx: retractEntity cascade that clears a required ref is tx/required", async () => {
    const conn = await setup(Staffs);
    const seed = txBuilder(Staffs);
    const boss = Effect.runSync(seed.entity());
    Effect.runSync(
      seed.put(Staff, boss, { handle: "boss", title: "Lead", manager: boss }),
    );
    const ada = Effect.runSync(seed.entity());
    Effect.runSync(
      seed.put(Staff, ada, { handle: "ada", title: "Eng", manager: boss }),
    );
    const { tempids } = await conn.transact([...txOps(seed)]);
    const bossEid = tempids["tmp-1"]!;
    const adaEid = tempids["tmp-2"]!;

    await expect(
      conn.transact([[":db/retract", adaEid, ":staff/manager"]]),
    ).rejects.toMatchObject({ code: "tx/required" });

    await expect(conn.transact([[":db/retractEntity", bossEid]])).rejects.toMatchObject(
      { code: "tx/required" },
    );
    expect((await conn.db().entity(bossEid))?.[":staff/handle"]).toBe("boss");
    expect((await conn.db().entity(adaEid))?.[":staff/manager"]).toBe(bossEid);
  });

  test("processTx: retractEntity of a row with no incoming required refs passes", async () => {
    const conn = await setup(Staffs);
    const seed = txBuilder(Staffs);
    const solo = Effect.runSync(seed.entity());
    Effect.runSync(
      seed.put(Staff, solo, { handle: "solo", title: "Lead", manager: solo }),
    );
    const { tempids } = await conn.transact([...txOps(seed)]);
    const eid = tempids["tmp-1"]!;
    await conn.transact([[":db/retractEntity", eid]]);
    expect(await conn.db().entity(eid)).toBeUndefined();
  });
});

describe("op.update", () => {
  test("lowers to :db/update and never uses map-form mint", () => {
    const tx = txBuilder(People);
    Effect.runSync(tx.update(Person, 1001, { title: "Eng", note: undefined }));
    Effect.runSync(tx.update(Person, { handle: "ada", title: "Staff" }));
    expect(txOps(tx)).toEqual([
      [":db/update", 1001, ":person/title", "Eng"],
      [":db/update", [":person/handle", "ada"], ":person/title", "Staff"],
    ]);
  });

  test("all-undefined subject form emits an existence ping", () => {
    const tx = txBuilder(People);
    Effect.runSync(tx.update(Person, 999_999, { title: undefined }));
    expect(txOps(tx)).toEqual([[":db/update", 999_999]]);
  });

  test("no-upsert map form is TxRejected tx/invalid", () => {
    const tx = txBuilder(Films);
    try {
      runSync(tx.update(Movie, { title: "Heat" } as never));
      throw new Error("expected TxRejected");
    } catch (err) {
      expect(err).toBeInstanceOf(TxRejected);
      expect((err as TxRejected).code).toBe("tx/invalid");
    }
  });

  test("processTx: missing row is tx/missing-entity (eid and unique map)", async () => {
    const conn = await setup();
    const byEid = txBuilder(People);
    Effect.runSync(byEid.update(Person, 999_999, { title: "x" }));
    await expect(conn.transact([...txOps(byEid)])).rejects.toMatchObject({
      code: "tx/missing-entity",
    });

    const byKey = txBuilder(People);
    Effect.runSync(byKey.update(Person, { handle: "missing", title: "x" }));
    await expect(conn.transact([...txOps(byKey)])).rejects.toMatchObject({
      code: "tx/missing-entity",
    });
  });

  test("processTx: wrong-entity subject is tx/wrong-entity", async () => {
    const conn = await setup(Films);
    const film = txBuilder(Films);
    Effect.runSync(film.put(Movie, { title: "Heat" }));
    const made = await conn.transact([...txOps(film)]);
    const filmEid = made.tempids["tmp-1"]!;

    const wrong = txBuilder(Films);
    Effect.runSync(wrong.update(Person, filmEid, { title: "nope" }));
    await expect(conn.transact([...txOps(wrong)])).rejects.toMatchObject({
      code: "tx/wrong-entity",
    });
  });

  test("processTx: all-undefined subject form on a missing row is tx/missing-entity", async () => {
    const conn = await setup();
    const tx = txBuilder(People);
    Effect.runSync(tx.update(Person, 999_999, { title: undefined }));
    await expect(conn.transact([...txOps(tx)])).rejects.toMatchObject({
      code: "tx/missing-entity",
    });
  });

  test("processTx: all-undefined subject form on an existing row is a no-op", async () => {
    const conn = await setup();
    const create = txBuilder(People);
    Effect.runSync(create.put(Person, { handle: "ada", title: "Eng", note: "hi" }));
    const { tempids } = await conn.transact([...txOps(create)]);
    const eid = tempids["tmp-1"]!;

    const empty = txBuilder(People);
    Effect.runSync(empty.update(Person, eid, { title: undefined, note: undefined }));
    const second = await conn.transact([...txOps(empty)]);
    expect(second.t).toBeGreaterThan(0);
    const row = await conn.db().entity(eid);
    expect(row?.[":person/title"]).toBe("Eng");
    expect(row?.[":person/note"]).toBe("hi");
  });

  test("processTx: undefined values are skipped (title changes, note stays)", async () => {
    const conn = await setup();
    const create = txBuilder(People);
    Effect.runSync(create.put(Person, { handle: "ada", title: "Eng", note: "hi" }));
    const { tempids } = await conn.transact([...txOps(create)]);
    const eid = tempids["tmp-1"]!;

    const patch = txBuilder(People);
    Effect.runSync(patch.update(Person, eid, { title: "Staff", note: undefined }));
    await conn.transact([...txOps(patch)]);
    const row = await conn.db().entity(eid);
    expect(row?.[":person/title"]).toBe("Staff");
    expect(row?.[":person/note"]).toBe("hi");
  });

  test("processTx: update by handle and lookup-ref subject", async () => {
    const conn = await setup();
    const create = txBuilder(People);
    Effect.runSync(create.put(Person, { handle: "ada", title: "Eng" }));
    const { tempids } = await conn.transact([...txOps(create)]);
    const eid = tempids["tmp-1"]!;

    const byHandle = txBuilder(People);
    const handle = Effect.runSync(byHandle.entity(eid));
    Effect.runSync(byHandle.update(Person, handle, { title: "Staff" }));
    await conn.transact([...txOps(byHandle)]);
    expect((await conn.db().entity(eid))?.[":person/title"]).toBe("Staff");

    const byLookup = txBuilder(People);
    Effect.runSync(
      byLookup.update(Person, [Person.handle, "ada"] as const, { title: "Lead" }),
    );
    await conn.transact([...txOps(byLookup)]);
    expect((await conn.db().entity(eid))?.[":person/title"]).toBe("Lead");
  });

  test("processTx: update by unique key sees a put from the same tx", async () => {
    const conn = await setup();
    const tx = txBuilder(People);
    Effect.runSync(tx.put(Person, { handle: "ada", title: "T" }));
    Effect.runSync(tx.update(Person, { handle: "ada", title: "T2" }));
    const { tempids } = await conn.transact([...txOps(tx)]);
    const eid = tempids["tmp-1"]!;
    expect((await conn.db().entity(eid))?.[":person/title"]).toBe("T2");
  });

  test("processTx: update of an existing row is partial and never creates", async () => {
    const conn = await setup();
    const create = txBuilder(People);
    Effect.runSync(create.put(Person, { handle: "ada", title: "Eng", note: "hi" }));
    const { tempids } = await conn.transact([...txOps(create)]);
    const eid = tempids["tmp-1"]!;

    const patch = txBuilder(People);
    Effect.runSync(patch.update(Person, { handle: "ada", title: "Staff" }));
    const second = await conn.transact([...txOps(patch)]);
    expect(second.tempids).toEqual({});
    const row = await conn.db().entity(eid);
    expect(row?.[":person/title"]).toBe("Staff");
    expect(row?.[":person/note"]).toBe("hi");
    expect(Object.keys(await conn.db().entity(eid + 1) ?? {})).toEqual([]);
  });

  test("lowers card-many refs as one :db/update per item (not one array value)", () => {
    const tx = txBuilder(Docs);
    Effect.runSync(tx.update(Doc, 1006, { labels: [1004, 1005] }));
    Effect.runSync(
      tx.update(Doc, 1006, { labels: [[Label.name, "red"] as const] }),
    );
    expect(txOps(tx)).toEqual([
      [":db/update", 1006, ":doc/labels", 1004],
      [":db/update", 1006, ":doc/labels", 1005],
      [":db/update", 1006, ":doc/labels", [":label/name", "red"]],
    ]);
  });

  test("processTx: update of a card-many ref array asserts each ref", async () => {
    const conn = await setup(Docs);
    const seed = txBuilder(Docs);
    Effect.runSync(seed.put(Label, { name: "red" }));
    Effect.runSync(seed.put(Label, { name: "blue" }));
    Effect.runSync(seed.put(Doc, { slug: "roadmap", title: "Roadmap" }));
    const { tempids } = await conn.transact([...txOps(seed)]);
    const red = tempids["tmp-1"]!;
    const blue = tempids["tmp-2"]!;
    const doc = tempids["tmp-3"]!;

    const viaPut = txBuilder(Docs);
    Effect.runSync(viaPut.put(Doc, doc, { labels: [red, blue] }));
    await conn.transact([...txOps(viaPut)]);
    expect(
      ((await conn.db().entity(doc))?.[":doc/labels"] as number[]).sort(),
    ).toEqual([red, blue].sort());

    const viaUpdate = txBuilder(Docs);
    Effect.runSync(viaUpdate.update(Doc, doc, { labels: [red] }));
    await conn.transact([...txOps(viaUpdate)]);
    const labels = (await conn.db().entity(doc))?.[":doc/labels"] as number[];
    expect(labels).toContain(red);
    expect(labels).toContain(blue);

    const byLookup = txBuilder(Docs);
    Effect.runSync(
      byLookup.update(Doc, doc, { labels: [[Label.name, "blue"] as const] }),
    );
    await expect(conn.transact([...txOps(byLookup)])).resolves.toMatchObject({
      t: expect.any(Number),
    });
  });

  test("schema attrs stay :db/-exempt so a healing install can write :db/optional", async () => {
    const conn = await Connection.create();
    // Attribute entities live in :db/ and never carry every bootstrap attr
    // (:db/doc, :db/unique, :db/index, …). If those card-one :db/ attrs
    // were required-at-transact, schemaTx / install() could not write
    // :db/optional onto a pre-#269 database — the healing path.
    await expect(
      conn.transact([
        {
          ":db/ident": ":heal/title",
          ":db/valueType": ":db.type/string",
          ":db/cardinality": ":db.cardinality/one",
        },
      ]),
    ).resolves.toMatchObject({ t: expect.any(Number) });
    await expect(
      conn.transact([
        {
          ":db/ident": ":heal/title",
          ":db/valueType": ":db.type/string",
          ":db/cardinality": ":db.cardinality/one",
          ":db/optional": true,
        },
      ]),
    ).resolves.toMatchObject({ t: expect.any(Number) });
    await expect(
      conn.transact([{ ":db/id": "row", ":heal/title": "ok" }]),
    ).resolves.toMatchObject({ t: expect.any(Number) });
  });

  test("processTx: :db/retract clearing a required field is tx/required", async () => {
    const conn = await setup();
    const create = txBuilder(People);
    Effect.runSync(create.put(Person, { handle: "ada", title: "Eng" }));
    const { tempids } = await conn.transact([...txOps(create)]);
    await expect(
      conn.transact([[":db/retract", tempids["tmp-1"]!, ":person/title"]]),
    ).rejects.toMatchObject({ code: "tx/required" });
  });
});

describe("both write paths reject identically", () => {
  const missRequired = Operation(
    "person/create-short",
    {
      schema: People,
      input: Schema.Struct({ handle: Schema.String }),
      output: Schema.Struct({}),
    },
    (op, input) => {
      op.put(Person, { handle: input.handle } as never);
      return {};
    },
  );

  const patchMissing = Operation(
    "person/update-missing",
    {
      schema: People,
      input: Schema.Struct({ handle: Schema.String }),
      output: Schema.Struct({}),
    },
    (op, input) => {
      op.update(Person, { handle: input.handle, title: "x" });
      return {};
    },
  );

  const putOnBootstrap = Operation(
    "person/put-bootstrap",
    {
      schema: People,
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    },
    (op) => {
      op.put(Person, 10, { title: "no handle" });
      return {};
    },
  );

  const putOnFilm = Operation(
    "person/put-on-film",
    {
      schema: Films,
      input: Schema.Struct({ eid: Schema.Number }),
      output: Schema.Struct({}),
    },
    (op, input) => {
      op.put(Person, input.eid, { title: "nope" });
      return {};
    },
  );

  const putMissingEid = Operation(
    "person/put-missing-eid",
    {
      schema: People,
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    },
    (op) => {
      op.put(Person, 1008, { handle: "squatter", title: "T" });
      return {};
    },
  );

  const putDanglingRef = Operation(
    "person/put-dangling-ref",
    {
      schema: People,
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    },
    (op) => {
      op.put(Person, {
        handle: "ada",
        title: "Eng",
        manager: 888888 as never,
      });
      return {};
    },
  );

  const patchUndefinedMissing = Operation(
    "person/update-undefined-missing",
    {
      schema: People,
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    },
    (op) => {
      op.update(Person, 999_999, { title: undefined });
      return {};
    },
  );

  const patchNoUpsert = Operation(
    "film/update-no-upsert",
    {
      schema: Films,
      input: Schema.Struct({}),
      output: Schema.Struct({}),
    },
    (op) => {
      op.update(Movie, { title: "Heat" } as never);
      return {};
    },
  );

  const names = Query.from(User).select({ name: User.name });

  const overlayOf = async (catalog: AnySchema, dbName: string) => {
    const server = await Connection.create();
    await server.transact(schemaTx(catalog) as unknown[]);
    const http = async (call: Call) => {
      if (call.url.endsWith("/info")) {
        return {
          body: {
            db: dbName,
            t: server.t,
            principal: { eid: null, class: "admin" },
          },
        };
      }
      throw new Error(`unexpected ${call.url}`);
    };
    const peer = fakePeer({ http });
    const c = client(peer);
    const db = c.ramose.db(dbName, catalog);
    return { server, peer, c, db };
  };

  test("overlay: create missing required is TxRejected tx/required", async () => {
    const server = await Connection.create();
    await server.transact(schemaTx(People) as unknown[]);
    const http = async (call: Call) => {
      if (call.url.endsWith("/info")) {
        return { body: { db: "people", t: server.t, principal: { eid: null, class: "admin" } } };
      }
      throw new Error(`unexpected ${call.url}`);
    };
    const peer = fakePeer({ http });
    const c = client(peer);
    const db = c.ramose.db("people", People);
    await db.query(Query.from(Person).select({ handle: Person.handle }));
    peer.socket.push({
      op: "resync",
      t: server.t,
      datoms: [],
    });
    await settle();

    const err = await db.run(missRequired, { handle: "ada" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/required");
    await c.dispose();
  });

  test("overlay: update of a missing row is TxRejected tx/missing-entity", async () => {
    const server = await Connection.create();
    await server.transact(schemaTx(People) as unknown[]);
    const http = async (call: Call) => {
      if (call.url.endsWith("/info")) {
        return { body: { db: "people", t: server.t, principal: { eid: null, class: "admin" } } };
      }
      throw new Error(`unexpected ${call.url}`);
    };
    const peer = fakePeer({ http });
    const c = client(peer);
    const db = c.ramose.db("people", People);
    await db.query(Query.from(Person).select({ handle: Person.handle }));
    peer.socket.push({ op: "resync", t: server.t, datoms: [] });
    await settle();

    const err = await db.run(patchMissing, { handle: "ghost" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/missing-entity");
    await c.dispose();
  });

  test("overlay: H1 put on bootstrap eid is TxRejected tx/required", async () => {
    const { c, db, peer, server } = await overlayOf(People, "people");
    await db.query(Query.from(Person).select({ handle: Person.handle }));
    peer.socket.push({ op: "resync", t: server.t, datoms: [] });
    await settle();
    const err = await db.run(putOnBootstrap, {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/required");
    await c.dispose();
  });

  test("overlay: H2 put onto another namespace is TxRejected tx/wrong-entity", async () => {
    const { c, db, peer, server } = await overlayOf(Films, "films");
    const film = await server.transact([{ ":film/title": "Heat" }]);
    const filmEid = film.tempids[Object.keys(film.tempids)[0]!]!;
    await db.query(Query.from(Person).select({ handle: Person.handle }));
    const snap = await snapshotOf(server);
    peer.socket.push({ op: "resync", t: snap.t, datoms: snap.datoms });
    await settle();
    const err = await db.run(putOnFilm, { eid: filmEid }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/wrong-entity");
    await c.dispose();
  });

  test("overlay: H3 put at a nonexistent eid is TxRejected tx/missing-entity", async () => {
    const { c, db, peer, server } = await overlayOf(People, "people");
    await db.query(Query.from(Person).select({ handle: Person.handle }));
    peer.socket.push({ op: "resync", t: server.t, datoms: [] });
    await settle();
    const err = await db.run(putMissingEid, {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/missing-entity");
    await c.dispose();
  });

  test("overlay: H4 dangling ref is TxRejected tx/missing-entity", async () => {
    const { c, db, peer, server } = await overlayOf(People, "people");
    await db.query(Query.from(Person).select({ handle: Person.handle }));
    peer.socket.push({ op: "resync", t: server.t, datoms: [] });
    await settle();
    const err = await db.run(putDanglingRef, {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/missing-entity");
    await c.dispose();
  });

  test("overlay: put still paints a complete create before POST /op", async () => {
    const server = await Connection.create();
    await server.transact(schemaTx(Movies) as unknown[]);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const create = Operation(
      "user/create-full",
      {
        schema: Movies,
        input: Schema.Struct({ name: Schema.String }),
        output: Schema.Struct({}),
      },
      (op, input) => {
        op.put(User, { name: input.name });
        return {};
      },
    );
    const http = async (call: Call) => {
      if (call.url.endsWith("/info")) {
        return { body: { db: "movies", t: server.t, principal: { eid: null, class: "admin" } } };
      }
      if (!call.url.endsWith("/op")) return { body: { t: server.t } };
      await gate;
      const rep = await server.transact([{ ":user/name": call.body.input.name }]);
      return {
        body: {
          t: rep.t,
          txEid: rep.txEid,
          tempids: rep.tempids,
          datoms: rep.txData.map(toWireDatom),
          clientOpId: call.body.clientOpId,
          output: {},
        },
      };
    };
    const peer = fakePeer({ http });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await db.query(names);
    const snap = await snapshotOf(server);
    peer.socket.push({ op: "resync", t: snap.t, datoms: snap.datoms });
    await settle();

    const pending = db.run(create, { name: "Ada" });
    await settle();
    const rows = await db.query(names);
    expect(rows).toEqual([{ name: "Ada" }]);
    release();
    await pending;
    await c.dispose();
  });

  test("overlay: all-undefined update of a missing row is TxRejected tx/missing-entity", async () => {
    const { c, db, peer, server } = await overlayOf(People, "people");
    await db.query(Query.from(Person).select({ handle: Person.handle }));
    peer.socket.push({ op: "resync", t: server.t, datoms: [] });
    await settle();
    const err = await db.run(patchUndefinedMissing, {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/missing-entity");
    await c.dispose();
  });

  test("overlay: no-upsert map form is TxRejected tx/invalid", async () => {
    const { c, db, peer, server } = await overlayOf(Films, "films");
    await db.query(Query.from(Movie).select({ title: Movie.title }));
    peer.socket.push({ op: "resync", t: server.t, datoms: [] });
    await settle();
    const err = await db.run(patchNoUpsert, {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/invalid");
    await c.dispose();
  });
});

describe("overlay rewriteTx :db/update", () => {
  test("rewrites a tempid subject and a ref-value tempid", async () => {
    const conn = await setup(Staffs);
    const rewritten = rewritePendingTx(
      [
        [":db/update", "tmp-boss", ":staff/title", "Lead"],
        [":db/update", 1001, ":staff/manager", "tmp-boss"],
        [":db/update", 1001],
        [":db/add", 1001, ":staff/manager", "tmp-boss"],
      ],
      { "tmp-boss": 2002 },
      conn.db().schema,
    );
    expect(rewritten).toEqual([
      [":db/update", 2002, ":staff/title", "Lead"],
      [":db/update", 1001, ":staff/manager", 2002],
      [":db/update", 1001],
      [":db/add", 1001, ":staff/manager", 2002],
    ]);
  });
});
