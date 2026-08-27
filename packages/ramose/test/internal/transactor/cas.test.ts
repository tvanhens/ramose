import { describe, expect, test } from "bun:test";
import { TxError } from "../../../src/internal/core/index.ts";
import { Harness, attribute } from "./harness.ts";

const SCHEMA = [
  attribute(":k/id", "long", { ":db/unique": ":db.unique/identity" }),
  attribute(":k/v", "string"),
  attribute(":k/n", "long"),
];

async function fresh(opts: ConstructorParameters<typeof Harness>[0] = {}) {
  const h = new Harness(opts);
  await h.transactor.init();
  await h.transactor.transact(SCHEMA);
  return h;
}

const eidOf = (ack: { tempids: Record<string, number> }): number =>
  ack.tempids[Object.keys(ack.tempids)[0]];

describe("transactor: :db/cas", () => {
  test("concurrent same-expected different replacements: exactly one ack", async () => {
    const h = await fresh();
    const seed = await h.transactor.transact([{ ":k/id": 1, ":k/v": "old" }]);
    const eid = eidOf(seed);
    const tBefore = h.transactor.t;
    const settled = await Promise.allSettled([
      h.transactor.transact([[":db/cas", eid, ":k/v", "old", "a"]]),
      h.transactor.transact([[":db/cas", eid, ":k/v", "old", "b"]]),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const bad = settled.filter((s) => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(TxError);
    expect((bad[0] as PromiseRejectedResult).reason).toMatchObject({ code: "tx/cas-conflict" });
    const won = (await h.transactor.connection.db().entity(eid))![":k/v"];
    expect(won === "a" || won === "b").toBe(true);
    expect(h.transactor.t).toBe(tBefore + 1);
    expect(h.logTs()).toEqual(Array.from({ length: tBefore + 1 }, (_, i) => i + 1));
  });

  test("mismatch commits none of the tx", async () => {
    const h = await fresh();
    const seed = await h.transactor.transact([{ ":k/id": 1, ":k/v": "old" }]);
    const eid = eidOf(seed);
    await expect(
      h.transactor.transact([
        [":db/cas", eid, ":k/v", "wrong", "x"],
        [":db/add", eid, ":k/n", 1],
      ]),
    ).rejects.toMatchObject({ code: "tx/cas-conflict" });
    const row = await h.transactor.connection.db().entity(eid);
    expect(row![":k/v"]).toBe("old");
    expect(row![":k/n"]).toBeUndefined();
  });

  test("successful CAS survives restart", async () => {
    const h = await fresh();
    const seed = await h.transactor.transact([{ ":k/id": 1, ":k/v": "old" }]);
    const eid = eidOf(seed);
    await h.transactor.transact([[":db/cas", eid, ":k/v", "old", "new"]]);
    const h2 = h.restart();
    await h2.transactor.init();
    expect((await h2.transactor.connection.db().entity(eid))![":k/v"]).toBe("new");
  });

  test("CAS result survives a later storage-fault batch", async () => {
    // 1 = bootstrap, 2 = schema, 3 = seed, 4 = CAS, 5 = injected failure
    const h = await fresh({ failWriteAt: 5 });
    const seed = await h.transactor.transact([{ ":k/id": 1, ":k/v": "old" }]);
    const eid = eidOf(seed);
    await h.transactor.transact([[":db/cas", eid, ":k/v", "old", "kept"]]);
    await expect(h.transactor.transact([{ ":k/id": 2, ":k/v": "later" }])).rejects.toBeDefined();
    const h2 = h.restart();
    await h2.transactor.init();
    expect((await h2.transactor.connection.db().entity(eid))![":k/v"]).toBe("kept");
    expect(await h2.transactor.connection.db().entid([":k/id", 2])).toBeUndefined();
  });

  test("storage-fault batch containing a CAS does not land; restart can retry", async () => {
    // 1 = bootstrap, 2 = schema, 3 = seed, 4 = CAS batch fails
    const h = await fresh({ failWriteAt: 4 });
    const seed = await h.transactor.transact([{ ":k/id": 1, ":k/v": "old" }]);
    const eid = eidOf(seed);
    await expect(h.transactor.transact([[":db/cas", eid, ":k/v", "old", "x"]])).rejects.toBeDefined();
    const h2 = h.restart();
    await h2.transactor.init();
    expect((await h2.transactor.connection.db().entity(eid))![":k/v"]).toBe("old");
    await h2.transactor.transact([[":db/cas", eid, ":k/v", "old", "x"]]);
    expect((await h2.transactor.connection.db().entity(eid))![":k/v"]).toBe("x");
  });

  test("same-tx two CAS on the same pair is tx/invalid and commits nothing", async () => {
    const h = await fresh();
    const seed = await h.transactor.transact([{ ":k/id": 1, ":k/v": "old" }]);
    const eid = eidOf(seed);
    const tBefore = h.transactor.t;
    await expect(
      h.transactor.transact([
        [":db/cas", eid, ":k/v", "old", "a"],
        [":db/cas", eid, ":k/v", "old", "b"],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    expect((await h.transactor.connection.db().entity(eid))![":k/v"]).toBe("old");
    expect(h.transactor.t).toBe(tBefore);
    expect(h.logTs()).toEqual(Array.from({ length: tBefore }, (_, i) => i + 1));
  });

  test("HTTP 409 for a mismatching CAS", async () => {
    const h = await fresh();
    const seed = await h.transactor.transact([{ ":k/id": 1, ":k/v": "old" }]);
    const eid = eidOf(seed);
    const r = await h.transactor.handleRequest(
      new Request("https://t/transact", {
        method: "POST",
        body: JSON.stringify({ tx: [[":db/cas", eid, ":k/v", "wrong", "x"]] }),
      }),
    );
    expect(r.status).toBe(409);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.tag).toBe("TxRejected");
    expect(body.code).toBe("tx/cas-conflict");
    expect((await h.transactor.connection.db().entity(eid))![":k/v"]).toBe("old");
  });
});
