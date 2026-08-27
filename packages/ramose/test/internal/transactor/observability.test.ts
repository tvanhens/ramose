/**
 * Write-path observability: one Analytics Engine data point per commit batch
 * (never per tx), one per indexer run, the documented column order, and the
 * hard rule that a failing sink can never fail a transaction.
 */
import { describe, expect, test } from "bun:test";
import { FakeAnalytics, Harness, attribute, entityKind } from "./harness.ts";
import { TxMetrics } from "../../../src/internal/transactor/index.ts";

const SCHEMA = [entityKind("k"), attribute(":k/id", "long", { ":db/unique": ":db.unique/identity" }), attribute(":k/v", "string")];

async function fresh(analytics?: FakeAnalytics, config = {}) {
  const h = new Harness({ ...(analytics !== undefined && { analytics }), config });
  await h.transactor.init();
  await h.transactor.transact(SCHEMA);
  return h;
}

describe("observability: analytics engine data points", () => {
  test("one point per batch, not per tx; documented index/blob/double layout", async () => {
    const ae = new FakeAnalytics();
    const h = await fresh(ae, { indexTxThreshold: 1_000_000, indexIntervalMs: 1_000_000 });
    const batchesBefore = h.transactor.stats.batches;
    const N = 200;
    await Promise.all(Array.from({ length: N }, (_, i) => h.transactor.transact([{ ":ramose/type": ":k", ":k/id": i, ":k/v": `v${i}` }])));

    const batchPoints = ae.ofStage("batch");
    // exactly one point per commit batch — far fewer than N
    expect(batchPoints.length).toBe(h.transactor.stats.batches);
    expect(batchPoints.length).toBeLessThan(N / 4);
    expect(h.transactor.stats.batches - batchesBefore).toBeGreaterThan(0);

    for (const p of batchPoints) {
      expect(p.indexes).toEqual(["test"]); // indexes[0] = db
      expect(p.blobs).toEqual(["batch", "test", "unknown"]); // blob1 stage, blob2 db, blob3 colo
      expect(p.doubles).toHaveLength(8);
      const [resolveMs, commitMs, batchSize, queueDepth, noveltyDatoms, txOk, txErr, fenceMs] = p.doubles!;
      expect(fenceMs).toBe(0); // timing fences off by default
      expect(resolveMs).toBeGreaterThanOrEqual(0);
      expect(commitMs).toBeGreaterThanOrEqual(0);
      expect(batchSize).toBeGreaterThan(0);
      expect(txOk).toBe(batchSize);
      expect(txErr).toBe(0);
      expect(queueDepth).toBeGreaterThanOrEqual(batchSize);
      expect(noveltyDatoms).toBeGreaterThan(0);
    }
    // txs acked == sum of batch_size across points
    const acked = batchPoints.reduce((n, p) => n + p.doubles![2], 0);
    expect(acked).toBe(h.transactor.stats.txs);
    expect(h.transactor.metrics.writes).toBe(ae.points.length);
    expect(h.transactor.metrics.errors).toBe(0);
  });

  test("rejected txs land in double7 (tx_err) of their batch", async () => {
    const ae = new FakeAnalytics();
    const h = await fresh(ae);
    await Promise.allSettled([
      h.transactor.transact([{ ":ramose/type": ":k", ":k/id": 1, ":k/v": "a" }]),
      h.transactor.transact([[":db/add", "x", ":k/nope", 1]]), // unknown attribute
    ]);
    const errs = ae.ofStage("batch").reduce((n, p) => n + p.doubles![6], 0);
    expect(errs).toBe(1);
  });

  test("indexer run emits its own point (stage 'index'; double5 = novelty before the merge)", async () => {
    const ae = new FakeAnalytics();
    const h = await fresh(ae, { indexTxThreshold: 1_000_000, indexIntervalMs: 1_000_000 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => h.transactor.transact([{ ":ramose/type": ":k", ":k/id": i }])));
    const noveltyBefore = h.transactor.connection.noveltyCount;
    await h.transactor.handleRequest(new Request("https://t/admin/index", { method: "POST" }));

    const idx = ae.ofStage("index");
    expect(idx.length).toBe(1);
    expect(idx[0].indexes).toEqual(["test"]);
    expect(idx[0].blobs).toEqual(["index", "test", "unknown"]);
    const [indexMs, zero2, txs, zero4, novelty, datoms, zero7] = idx[0].doubles!;
    expect(indexMs).toBeGreaterThanOrEqual(0);
    expect(zero2).toBe(0);
    expect(zero4).toBe(0);
    expect(zero7).toBe(0);
    expect(txs).toBeGreaterThan(0);
    expect(datoms).toBeGreaterThan(0);
    expect(novelty).toBe(noveltyBefore);
    expect(h.transactor.connection.noveltyCount).toBe(0); // merged away
  });

  test("a throwing sink is counted, never propagated to the transaction", async () => {
    const ae = new FakeAnalytics(true);
    const h = await fresh(ae);
    const ack = await h.transactor.transact([{ ":ramose/type": ":k", ":k/id": 7, ":k/v": "still committed" }]);
    expect(ack.t).toBe(h.transactor.t);
    expect(h.transactor.metrics.errors).toBeGreaterThan(0);
    expect(h.transactor.metrics.writes).toBe(0);
    expect(ae.points.length).toBe(0);
  });

  test("no dataset bound = no-op sink (default harness)", async () => {
    const h = await fresh();
    expect(h.transactor.metrics.enabled).toBe(false);
    await h.transactor.transact([{ ":ramose/type": ":k", ":k/id": 1 }]);
    expect(h.transactor.metrics.writes).toBe(0);
    expect(h.transactor.metrics.errors).toBe(0);
  });

  test("colo is learned from request.cf and tags later points", async () => {
    const ae = new FakeAnalytics();
    const h = await fresh(ae);
    const req = new Request("https://t/transact", { method: "POST", body: JSON.stringify({ tx: [{ ":ramose/type": ":k", ":k/id": 42 }] }) });
    Object.defineProperty(req, "cf", { value: { colo: "IAD" } });
    const res = await h.transactor.handleRequest(req);
    expect(res.status).toBe(200);
    expect(h.transactor.metrics.colo).toBe("IAD");
    expect(ae.ofStage("batch").at(-1)!.blobs).toEqual(["batch", "test", "IAD"]);
  });

  test("TxMetrics standalone: no-op without a dataset, counts writes with one", () => {
    const off = new TxMetrics();
    off.batch({ db: "d", resolveMs: 1, commitMs: 2, batchSize: 3, queueDepth: 4, noveltyDatoms: 5, txOk: 3, txErr: 0 });
    expect(off.snapshot()).toEqual({ enabled: false, colo: "unknown", aeWrites: 0, aeErrors: 0 });

    const ae = new FakeAnalytics();
    const on = new TxMetrics(ae);
    on.observeColo(undefined);
    expect(on.colo).toBe("unknown");
    on.observeColo("LHR");
    on.batch({ db: "d", resolveMs: 1, commitMs: 2, batchSize: 3, queueDepth: 4, noveltyDatoms: 5, txOk: 3, txErr: 0 });
    expect(ae.points).toEqual([{ indexes: ["d"], blobs: ["batch", "d", "LHR"], doubles: [1, 2, 3, 4, 5, 3, 0, 0] }]);
    on.index({ db: "d", indexMs: 9, txs: 8, datoms: 7, noveltyDatoms: 6 });
    expect(ae.points[1]).toEqual({ indexes: ["d"], blobs: ["index", "d", "LHR"], doubles: [9, 0, 8, 0, 6, 7, 0] });
    expect(on.snapshot()).toEqual({ enabled: true, colo: "LHR", aeWrites: 2, aeErrors: 0 });
  });
});

describe("observability: timing fences (config.timingYields)", () => {
  test("off by default: no fence samples, fence columns zero", async () => {
    const ae = new FakeAnalytics();
    const h = await fresh(ae, { indexTxThreshold: 1_000_000, indexIntervalMs: 1_000_000 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => h.transactor.transact([{ ":ramose/type": ":k", ":k/id": i }])));
    expect(h.transactor.info().opts.timingYields).toBe(false);
    expect(h.transactor.stats.fenceMs).toBe(0);
    expect(h.transactor.info().metrics.fenceMs.count).toBe(0);
    expect(ae.ofStage("batch").every((p) => p.doubles![7] === 0)).toBe(true);
  });

  test("on: one calibration fence per batch, reported in /info and double8", async () => {
    const ae = new FakeAnalytics();
    const h = await fresh(ae, { indexTxThreshold: 1_000_000, indexIntervalMs: 1_000_000, timingYields: true });
    const N = 50;
    const acks = await Promise.all(Array.from({ length: N }, (_, i) => h.transactor.transact([{ ":ramose/type": ":k", ":k/id": i }])));
    expect(acks).toHaveLength(N); // acks still only resolve after the storage write
    expect(h.transactor.t).toBe(acks.at(-1)!.t);

    const info = h.transactor.info();
    expect(info.opts.timingYields).toBe(true);
    expect(info.metrics.fenceMs.count).toBeGreaterThanOrEqual(info.stats.batches);
    expect(info.stats.fenceMs).toBeGreaterThanOrEqual(0);
    // the loop still brackets resolve + commit, and every batch point carries its fence
    expect(info.stats.loopMs).toBeGreaterThanOrEqual(info.stats.resolveMs + info.stats.commitMs - 1e-6);
    const points = ae.ofStage("batch");
    expect(points.length).toBe(info.stats.batches);
    for (const p of points) {
      expect(p.doubles).toHaveLength(8);
      expect(p.doubles![7]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("observability: /info counters", () => {
  test("cumulative resolve/commit/loop counters plus per-batch distributions and AE counters", async () => {
    const ae = new FakeAnalytics();
    const h = await fresh(ae, { indexTxThreshold: 1_000_000, indexIntervalMs: 1_000_000 });
    await Promise.all(Array.from({ length: 50 }, (_, i) => h.transactor.transact([{ ":ramose/type": ":k", ":k/id": i }])));
    const info = h.transactor.info();

    // the pre-existing cumulative counters are still wired the same way
    expect(info.stats.resolveMs).toBeGreaterThan(0);
    expect(info.stats.commitMs).toBeGreaterThan(0);
    expect(info.stats.loopMs).toBeGreaterThan(0);
    // loop wall clock brackets resolve + commit, so "other" is computable and >= 0
    expect(info.stats.loopMs).toBeGreaterThanOrEqual(info.stats.resolveMs + info.stats.commitMs - 1e-6);

    const m = info.metrics;
    expect(m.batchResolveMs.count).toBe(h.transactor.stats.batches);
    expect(m.batchCommitMs.count).toBe(h.transactor.stats.batches);
    expect(m.batchLoopMs.count).toBe(h.transactor.stats.batches);
    expect(m.resolveMs).toBeGreaterThan(0);
    expect(m.loopMs).toBeGreaterThan(0);
    expect(m.noveltyDatoms).toBe(h.transactor.connection.noveltyCount);
    expect(m.queueDepth).toBe(0);
    expect(m.enabled).toBe(true);
    expect(m.colo).toBe("unknown");
    expect(m.aeWrites).toBe(ae.points.length);
    expect(m.aeErrors).toBe(0);
  });
});
