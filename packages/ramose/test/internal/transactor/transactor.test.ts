/**
 * M2 acceptance for the Transactor write path, without Cloudflare:
 *   - serialized, contiguous `t` under concurrent clients (no gaps / dupes),
 *     including under storage-fault injection and restart
 *   - group commit actually coalesces concurrent txs into few storage writes
 *   - novelty frames delivered to subscribers; resume-from-watermark catch-up
 *   - HTTP surface (/transact, /info, /log)
 *   - alarm-driven indexing publishes a root and prunes the log
 */
import { describe, expect, test } from "bun:test";
import {
  TxError,
  makeCompositionIndex,
} from "../../../src/internal/core/index.ts";
import { markEngineTypeAssertion } from "../../../src/internal/core/tx-provenance.ts";
import { Harness, attribute } from "./harness.ts";
import { TransactorDeadError } from "../../../src/internal/transactor/index.ts";

const SCHEMA = [attribute(":k/id", "long", { ":db/unique": ":db.unique/identity" }), attribute(":k/v", "string"), attribute(":k/n", "long")];

async function fresh(opts: ConstructorParameters<typeof Harness>[0] = {}) {
  const h = new Harness(opts);
  await h.transactor.init();
  await h.transactor.transact(SCHEMA);
  return h;
}

describe("transactor: group commit + monotonic t", () => {
  test("restored connections use the bound deployed composition", async () => {
    const composition = makeCompositionIndex({
      entities: [":issue"],
      traits: [":taggable"],
      entityTraits: [[":issue", [":taggable"]]],
    });
    const unitHash = "a".repeat(64);
    const schema = [
      {
        ":db/ident": ":issue/title",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":taggable/tag",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
    ];
    const typed = (title: string, tag?: string) =>
      markEngineTypeAssertion({
        ":db/id": `issue-${title}`,
        ":ramose/type": ":issue",
        ":issue/title": title,
        ...(tag === undefined ? {} : { ":taggable/tag": tag }),
      });

    const h = new Harness();
    h.transactor.bindComposition(unitHash, composition);
    await h.transactor.init();
    await h.transactor.transact(schema);
    await h.transactor.transact([typed("first", "tag")]);

    const restarted = h.restart();
    restarted.transactor.bindComposition(unitHash, composition);
    await restarted.transactor.init();
    await expect(
      restarted.transactor.transact([typed("missing")]),
    ).rejects.toMatchObject({ code: "tx/required" });
    await expect(() =>
      restarted.transactor.bindComposition("b".repeat(64), composition),
    ).toThrow(/cannot change deployed catalog composition/);
  });

  test("bootstraps a fresh database at t=1 and persists it", async () => {
    const h = new Harness();
    await h.transactor.init();
    expect(h.transactor.t).toBe(1);
    expect(h.logTs()).toEqual([1]);
    expect(h.raw.objects.size).toBeGreaterThan(0); // empty roots were written (under db/test/)
  });

  test("concurrent clients get contiguous t; batches coalesce into few writes", async () => {
    const h = await fresh();
    const t0 = h.transactor.t;
    const writesBefore = h.writes;
    const batchesBefore = h.transactor.stats.batches;
    const N = 500;
    const acks = await Promise.all(Array.from({ length: N }, (_, i) => h.transactor.transact([{ ":k/id": i, ":k/v": `v${i}` }])));
    const ts = acks.map((a) => a.t).sort((a, b) => a - b);
    // contiguous, no dupes, in arrival order
    for (let i = 0; i < N; i++) expect(ts[i]).toBe(t0 + 1 + i);
    expect(acks.map((a) => a.t)).toEqual(ts); // arrival order == t order
    // durable log matches memory exactly
    expect(h.logTs()).toEqual(Array.from({ length: t0 + N }, (_, i) => i + 1));
    // group commit: far fewer storage writes than transactions
    const writes = h.writes - writesBefore;
    expect(writes).toBeLessThan(N / 4);
    expect(h.transactor.stats.maxBatch).toBeGreaterThan(1);
    expect(h.transactor.stats.batches - batchesBefore).toBe(writes);
    // reads see everything
    const db = h.transactor.connection.db();
    expect(await db.entid([":k/id", 123])).toBeDefined();
  });

  test("a failed tx in a batch is rejected alone; the rest of the batch commits", async () => {
    const h = await fresh();
    const results = await Promise.allSettled([
      h.transactor.transact([{ ":k/id": 1, ":k/v": "a" }]),
      h.transactor.transact([[":db/add", "x", ":k/nope", 1]]), // unknown attribute
      h.transactor.transact([{ ":k/id": 2, ":k/v": "b" }]),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(TxError);
    expect(results[2].status).toBe("fulfilled");
    const ts = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.t] : []));
    expect(ts[1]).toBe(ts[0] + 1); // no t burned by the rejected tx
    expect(h.transactor.stats.rejected).toBe(1);
  });

  test("storage fault: batch is all-or-nothing, instance aborts, restart continues with no gaps/dupes", async () => {
    // fail the 4th storage write (1 = bootstrap, 2 = schema, 3 = first user batch, 4 = second)
    const h = await fresh({ failWriteAt: 4 });
    const first = await h.transactor.transact([{ ":k/id": 1, ":k/v": "a" }]);
    // this batch (everything submitted concurrently) hits the injected failure
    const settled = await Promise.allSettled([
      h.transactor.transact([{ ":k/id": 2, ":k/v": "b" }]),
      h.transactor.transact([{ ":k/id": 3, ":k/v": "c" }]),
      h.transactor.transact([{ ":k/id": 4, ":k/v": "d" }]),
    ]);
    expect(settled.every((r) => r.status === "rejected")).toBe(true);
    expect(h.aborted).toContain("log write failed");
    expect(h.transactor.isDead).toBe(true);
    // further submissions to the dead instance are rejected fast
    await expect(h.transactor.transact([{ ":k/id": 5 }])).rejects.toBeInstanceOf(TransactorDeadError);
    // durable state: nothing from the failed batch landed
    expect(h.logTs()).toEqual(Array.from({ length: first.t }, (_, i) => i + 1));

    // "DO restarts": fresh instance over the same SQLite → t continues right after the last durable tx
    const h2 = h.restart();
    await h2.transactor.init();
    expect(h2.transactor.t).toBe(first.t);
    const again = await Promise.all([2, 3, 4].map((i) => h2.transactor.transact([{ ":k/id": i, ":k/v": "x" }])));
    expect(again.map((a) => a.t)).toEqual([first.t + 1, first.t + 2, first.t + 3]);
    expect(h2.logTs()).toEqual(Array.from({ length: first.t + 3 }, (_, i) => i + 1));
    // and the entities from the failed batch never leaked (ids 2..4 exist exactly once, from the retry)
    const db = h2.transactor.connection.db();
    for (const i of [1, 2, 3, 4]) expect(await db.entid([":k/id", i])).toBeDefined();
    expect(await db.entid([":k/id", 5])).toBeUndefined();
  });

  test("restart replays the un-indexed log and keeps unique-identity semantics", async () => {
    const h = await fresh();
    const a = await h.transactor.transact([{ ":k/id": 7, ":k/v": "seven" }]);
    const h2 = h.restart();
    await h2.transactor.init();
    // upsert on the restarted instance resolves to the same entity
    const b = await h2.transactor.transact([{ ":k/id": 7, ":k/n": 70 }]);
    expect(b.t).toBe(a.t + 1);
    const eid = a.tempids[Object.keys(a.tempids)[0]];
    const ent = await h2.transactor.connection.db().entity(eid);
    expect(ent![":k/v"]).toBe("seven");
    expect(ent![":k/n"]).toBe(70);
    // next_eid persisted: new entities do not collide with old ones
    const c = await h2.transactor.transact([{ ":k/id": 8 }]);
    const eid2 = c.tempids[Object.keys(c.tempids)[0]];
    expect(eid2).toBeGreaterThan(eid);
  });

  test("maxBatch caps the number of txs per storage write", async () => {
    const h = await fresh({ config: { maxBatch: 10 } });
    await Promise.all(Array.from({ length: 95 }, (_, i) => h.transactor.transact([{ ":k/id": i }])));
    expect(h.transactor.stats.maxBatch).toBeLessThanOrEqual(10);
    expect(h.logTs().length).toBe(2 + 95);
  });
});

describe("transactor: novelty subscribers", () => {
  test("subscribers get hello then one tx frame per commit, in t order", async () => {
    const h = await fresh();
    const s = h.subscribe(h.transactor.t);
    expect(s.frames[0].kind).toBe("hello");
    expect(s.frames[0].t).toBe(h.transactor.t);
    const acks = await Promise.all(Array.from({ length: 20 }, (_, i) => h.transactor.transact([{ ":k/id": i, ":k/v": "v" }])));
    const txs = s.ofKind("tx");
    expect(txs.map((f) => f.t)).toEqual(acks.map((a) => a.t));
    // each frame carries the tx's datoms (wire form) — at least txInstant + 2 user datoms
    for (const f of txs) expect(f.datoms.length).toBeGreaterThanOrEqual(3);
  });

  test("late subscriber catches up from its watermark; resume works; a pruned log yields a gap frame", async () => {
    const h = await fresh({ config: { logKeepTxs: 5, indexTxThreshold: 1_000_000, indexIntervalMs: 1_000_000 } });
    const t0 = h.transactor.t;
    await Promise.all(Array.from({ length: 10 }, (_, i) => h.transactor.transact([{ ":k/id": i }])));
    const late = h.subscribe(t0);
    expect(late.ofKind("tx").map((f) => f.t)).toEqual(Array.from({ length: 10 }, (_, i) => t0 + 1 + i));
    // resume from the middle
    const mid = new (await import("./harness.ts")).FakeSocket();
    h.transactor.onSocketMessage(mid, JSON.stringify({ kind: "resume", from: t0 + 5 }));
    expect(mid.ofKind("tx").map((f) => f.t)).toEqual([t0 + 6, t0 + 7, t0 + 8, t0 + 9, t0 + 10]);
    // index → log pruned to the last 5 txs → a subscriber from t0 gets a gap frame first
    const res = await h.transactor.handleRequest(new Request("https://t/admin/index", { method: "POST" }));
    expect(res.status).toBe(200);
    const stale = h.subscribe(t0);
    expect(stale.frames[1].kind).toBe("gap");
    expect(h.transactor.earliestLogT()).toBeGreaterThan(t0 + 1);
    // root frame reached the earlier subscriber
    expect(late.ofKind("root").length).toBe(1);
  });

  test("closed sockets do not break broadcast", async () => {
    const h = await fresh();
    const s = h.subscribe(h.transactor.t);
    s.close();
    await h.transactor.transact([{ ":k/id": 1 }]);
    expect(h.transactor.stats.broadcasts).toBeGreaterThan(0);
  });
});

describe("transactor: HTTP + alarm", () => {
  test("/transact, /info, /log", async () => {
    const h = await fresh();
    const r = await h.transactor.handleRequest(new Request("https://t/transact", { method: "POST", body: JSON.stringify({ tx: [{ ":k/id": 1, ":k/v": "a" }] }) }));
    expect(r.status).toBe(200);
    const ack = (await r.json()) as any;
    expect(ack.t).toBe(h.transactor.t);
    const bad = await h.transactor.handleRequest(new Request("https://t/transact", { method: "POST", body: JSON.stringify({ tx: [[":db/add", 1, ":k/nope", 1]] }) }));
    expect(bad.status).toBe(409);
    const info = (await (await h.transactor.handleRequest(new Request("https://t/info"))).json()) as any;
    expect(info.t).toBe(h.transactor.t);
    expect(info.stats.txs).toBeGreaterThan(0);
    const log = (await (await h.transactor.handleRequest(new Request(`https://t/log?from=${h.transactor.t - 1}`))).json()) as any;
    expect(log.entries.length).toBe(1);
    expect(log.entries[0].t).toBe(h.transactor.t);
  });

  test("alarm-driven indexing publishes a root, adopts it, prunes the log; reads stay consistent", async () => {
    let clock = 1_000_000;
    const h = await fresh({ config: { indexTxThreshold: 50, logKeepTxs: 10 }, now: () => clock });
    await Promise.all(Array.from({ length: 60 }, (_, i) => h.transactor.transact([{ ":k/id": i, ":k/n": i }])));
    expect(h.alarm).not.toBeNull(); // threshold crossed → alarm armed
    clock += 10;
    expect(await h.fireAlarm()).toBe(true);
    const rec = h.transactor.currentRootRecord;
    expect(rec.t).toBe(h.transactor.t);
    expect(h.raw.objects.has("db/test/root/current")).toBe(true);
    expect(h.transactor.earliestLogT()).toBeGreaterThan(1);
    // after indexing, novelty is empty and queries still see all entities
    expect(h.transactor.connection.noveltyCount).toBe(0);
    const db = h.transactor.connection.db();
    const n = (await db.datomsArray(2 /* AVET */, { a: db.schema.entid(":k/id")! })).length;
    expect(n).toBe(60);
    // restart from the published root + tail log
    const h2 = h.restart({ now: () => clock });
    await h2.transactor.init();
    expect(h2.transactor.t).toBe(h.transactor.t);
    expect(await h2.transactor.connection.db().entid([":k/id", 59])).toBeDefined();
  });
});

describe("transactor: structured metrics", () => {
  test("commit batches, rejects, subscribers and index runs emit structured events; /info carries live metrics", async () => {
    const { events, eventsOf } = await import("./harness.ts");
    const mark = events.length;
    const h = await fresh({ config: { indexTxThreshold: 1_000_000, indexIntervalMs: 1_000_000 } });
    h.subscribe(h.transactor.t);
    await Promise.all(Array.from({ length: 30 }, (_, i) => h.transactor.transact([{ ":k/id": i }])));
    await h.transactor.transact([[":db/add", 1, ":k/nope", 1]]).catch(() => undefined);
    await h.transactor.handleRequest(new Request("https://t/admin/index", { method: "POST" }));
    const mine = events.slice(mark);
    const commits = mine.filter((e) => e.event === "tx.commit");
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((e) => e.component === "transactor" && e.db === "test" && typeof e.batch === "number" && typeof e.writeMs === "number")).toBe(true);
    expect(commits.reduce((n, e) => n + (e.batch as number), 0)).toBe(31); // schema + 30
    expect(mine.some((e) => e.event === "boot")).toBe(true);
    expect(mine.some((e) => e.event === "subscriber.connect")).toBe(true);
    expect(mine.filter((e) => e.event === "tx.rejected").length).toBe(1);
    const run = mine.find((e) => e.event === "index.run")!;
    expect(run.component).toBe("indexer");
    expect(run.txs).toBe(32); // bootstrap + schema + 30
    expect(typeof run.ms).toBe("number");
    expect(typeof run.r2Puts).toBe("number");
    const info = h.transactor.info();
    expect(info.metrics.batchSize.count).toBe(commits.length);
    expect(info.metrics.commitMs.count).toBe(commits.length);
    expect(info.metrics.avgBatch).toBeGreaterThan(1);
    expect(info.metrics.txPerSec).toBeGreaterThan(0);
    expect(eventsOf("tx.commit").length).toBeGreaterThanOrEqual(commits.length);
  });
});

describe("transactor: TxAck datoms + clientTxId", () => {
  test("ack.datoms is the wire array, not a count", async () => {
    const h = await fresh();
    const ack = await h.transactor.transact([{ ":k/id": 1, ":k/v": "a" }]);
    expect(Array.isArray(ack.datoms)).toBe(true);
    expect(ack.datoms.length).toBeGreaterThan(0);
    expect(ack.datoms[0]).toHaveLength(6); // [e, a, vt, v, t, op]
    expect(ack.datoms.every((d) => d[4] === ack.t)).toBe(true);
    const http = await h.transactor.handleRequest(
      new Request("https://t/transact", { method: "POST", body: JSON.stringify({ tx: [{ ":k/id": 2, ":k/v": "b" }] }) }),
    );
    const body = (await http.json()) as { datoms: unknown };
    expect(Array.isArray(body.datoms)).toBe(true);
  });

  test("clientTxId replay returns the same ack and does not assign a second t", async () => {
    const h = await fresh();
    const t0 = h.transactor.t;
    const first = await h.transactor.transact([{ ":k/id": 9, ":k/v": "once" }], undefined, "c1");
    expect(first.t).toBe(t0 + 1);
    expect(first.clientTxId).toBe("c1");
    const replay = await h.transactor.transact([{ ":k/id": 9, ":k/v": "once more" }], undefined, "c1");
    expect(replay).toEqual(first);
    expect(h.transactor.t).toBe(first.t);
    const viaHttp = await h.transactor.handleRequest(
      new Request("https://t/transact", { method: "POST", body: JSON.stringify({ tx: [{ ":k/id": 10 }], clientTxId: "c1" }) }),
    );
    expect(((await viaHttp.json()) as { t: number }).t).toBe(first.t);
    expect(h.transactor.t).toBe(first.t);
    const next = await h.transactor.transact([{ ":k/id": 11 }], undefined, "c2");
    expect(next.t).toBe(first.t + 1);
  });
});
