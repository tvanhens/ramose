/**
 * Required-at-transact (#266) and `op.update` (#265): rejection paths
 * on processTx, the optimistic overlay, and the worker `/op` path.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Connection } from "../src/internal/core/conn.ts";
import { TxError } from "../src/internal/core/tx.ts";
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
import { schemaTx } from "../src/db/ensure.ts";
import { client, fakePeer, settle, type Call } from "./peer.ts";
import { snapshotOf } from "./overlay-seed.ts";
import { Movies, User } from "./db/fixture.ts";

const Person = Entity("person", {
  handle: Field(Schema.String, { unique: "upsert" }),
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
  name: Field(Schema.String, { unique: "upsert" }),
});
const Doc = Entity("doc", {
  slug: Field(Schema.String, { unique: "upsert" }),
  title: Field(Schema.String),
  labels: Field.many(Ref(Label)),
});
const Docs = DbSchema({ label: Label, doc: Doc });

const Staff = Entity("staff", {
  handle: Field(Schema.String, { unique: "upsert" }),
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

  test("processTx: optional and card-many omitted pass; required ref must be supplied", async () => {
    const conn = await setup();
    const tx = txBuilder(People);
    Effect.runSync(tx.put(Person, { handle: "ada", title: "Eng" }));
    const rep = await conn.transact([...txOps(tx)]);
    const row = await conn.db().entity(rep.tempids["tmp-1"]!);
    expect(row?.[":person/handle"]).toBe("ada");
    expect(row?.[":person/note"]).toBeUndefined();
    expect(row?.[":person/tags"]).toBeUndefined();
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
    Effect.runSync(
      seed.put(Staff, 1003, { handle: "boss", title: "Lead", manager: 1003 }),
    );
    Effect.runSync(
      seed.put(Staff, 1004, { handle: "ada", title: "Eng", manager: 1003 }),
    );
    await conn.transact([...txOps(seed)]);

    await expect(
      conn.transact([[":db/retract", 1004, ":staff/manager"]]),
    ).rejects.toMatchObject({ code: "tx/required" });

    await expect(conn.transact([[":db/retractEntity", 1003]])).rejects.toMatchObject(
      { code: "tx/required" },
    );
    expect((await conn.db().entity(1003))?.[":staff/handle"]).toBe("boss");
    expect((await conn.db().entity(1004))?.[":staff/manager"]).toBe(1003);
  });

  test("processTx: retractEntity of a row with no incoming required refs passes", async () => {
    const conn = await setup(Staffs);
    const seed = txBuilder(Staffs);
    Effect.runSync(
      seed.put(Staff, 1003, { handle: "solo", title: "Lead", manager: 1003 }),
    );
    await conn.transact([...txOps(seed)]);
    await conn.transact([[":db/retractEntity", 1003]]);
    expect(await conn.db().entity(1003)).toBeUndefined();
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

  test("processTx: update clearing a required field is tx/required", async () => {
    const conn = await setup();
    const create = txBuilder(People);
    Effect.runSync(create.put(Person, { handle: "ada", title: "Eng" }));
    const { tempids } = await conn.transact([...txOps(create)]);
    await expect(
      conn.transact([[":db/retract", tempids["tmp-1"]!, ":person/title"]]),
    ).rejects.toBeInstanceOf(TxError);
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

  const names = Query.from(User).select({ name: User.name });

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
});
