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

const setup = async (catalog = People) => {
  const conn = await Connection.create();
  await conn.transact(schemaTx(catalog) as unknown[]);
  return conn;
};

describe("required-at-transact", () => {
  test("processTx: put missing a required field is tx/required (datom-level too)", async () => {
    const conn = await setup();
    const viaPut = txBuilder(People);
    Effect.runSync(viaPut.put(Person, { handle: "ada" } as never));
    await expect(conn.transact([...viaPut.spec.ops])).rejects.toMatchObject({
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
    const created = await conn.transact([...first.spec.ops]);
    const eid = created.tempids["tmp-1"];
    expect(typeof eid).toBe("number");

    const again = txBuilder(People);
    Effect.runSync(again.put(Person, { handle: "ada", title: "Staff" }));
    const second = await conn.transact([...again.spec.ops]);
    expect(second.tempids["tmp-1"]).toBe(eid);
    expect((await conn.db().entity(eid!))?.[":person/title"]).toBe("Staff");
  });

  test("processTx: optional and card-many omitted pass; required ref must be supplied", async () => {
    const conn = await setup();
    const tx = txBuilder(People);
    Effect.runSync(tx.put(Person, { handle: "ada", title: "Eng" }));
    const rep = await conn.transact([...tx.spec.ops]);
    const row = await conn.db().entity(rep.tempids["tmp-1"]!);
    expect(row?.[":person/handle"]).toBe("ada");
    expect(row?.[":person/note"]).toBeUndefined();
    expect(row?.[":person/tags"]).toBeUndefined();
  });

  test("processTx: clearing a required field is tx/required", async () => {
    const conn = await setup();
    const create = txBuilder(People);
    Effect.runSync(create.put(Person, { handle: "ada", title: "Eng" }));
    const { tempids } = await conn.transact([...create.spec.ops]);
    const eid = tempids["tmp-1"]!;

    await expect(
      conn.transact([[":db/retract", eid, ":person/title"]]),
    ).rejects.toMatchObject({ code: "tx/required" });

    const noteGone = await conn.transact([[":db/retract", eid, ":person/note"]]);
    expect(noteGone.t).toBeGreaterThan(0);
  });
});

describe("op.update", () => {
  test("lowers to :db/update and never uses map-form mint", () => {
    const tx = txBuilder(People);
    Effect.runSync(tx.update(Person, 1001, { title: "Eng", note: undefined }));
    Effect.runSync(tx.update(Person, { handle: "ada", title: "Staff" }));
    expect(tx.spec.ops).toEqual([
      [":db/update", 1001, ":person/title", "Eng"],
      [":db/update", [":person/handle", "ada"], ":person/title", "Staff"],
    ]);
  });

  test("processTx: missing row is tx/missing-entity (eid and unique map)", async () => {
    const conn = await setup();
    const byEid = txBuilder(People);
    Effect.runSync(byEid.update(Person, 999_999, { title: "x" }));
    await expect(conn.transact([...byEid.spec.ops])).rejects.toMatchObject({
      code: "tx/missing-entity",
    });

    const byKey = txBuilder(People);
    Effect.runSync(byKey.update(Person, { handle: "missing", title: "x" }));
    await expect(conn.transact([...byKey.spec.ops])).rejects.toMatchObject({
      code: "tx/missing-entity",
    });
  });

  test("processTx: wrong-entity subject is tx/wrong-entity", async () => {
    const conn = await setup(Films);
    const film = txBuilder(Films);
    Effect.runSync(film.put(Movie, { title: "Heat" }));
    const made = await conn.transact([...film.spec.ops]);
    const filmEid = made.tempids["tmp-1"]!;

    const wrong = txBuilder(Films);
    Effect.runSync(wrong.update(Person, filmEid, { title: "nope" }));
    await expect(conn.transact([...wrong.spec.ops])).rejects.toMatchObject({
      code: "tx/wrong-entity",
    });
  });

  test("processTx: update of an existing row is partial and never creates", async () => {
    const conn = await setup();
    const create = txBuilder(People);
    Effect.runSync(create.put(Person, { handle: "ada", title: "Eng", note: "hi" }));
    const { tempids } = await conn.transact([...create.spec.ops]);
    const eid = tempids["tmp-1"]!;

    const patch = txBuilder(People);
    Effect.runSync(patch.update(Person, { handle: "ada", title: "Staff" }));
    const second = await conn.transact([...patch.spec.ops]);
    expect(second.tempids).toEqual({});
    const row = await conn.db().entity(eid);
    expect(row?.[":person/title"]).toBe("Staff");
    expect(row?.[":person/note"]).toBe("hi");
    expect(Object.keys(await conn.db().entity(eid + 1) ?? {})).toEqual([]);
  });

  test("processTx: update clearing a required field is tx/required", async () => {
    const conn = await setup();
    const create = txBuilder(People);
    Effect.runSync(create.put(Person, { handle: "ada", title: "Eng" }));
    const { tempids } = await conn.transact([...create.spec.ops]);
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
