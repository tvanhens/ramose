/**
 * Transactor/indexer coverage through the real Worker, Transactor DO, DO
 * SQLite, R2, alarms, and hibernating WebSockets. Test admin routes only
 * forward to those resources or arm checkpoints in the real isolate.
 */

import { describe, expect, test } from "bun:test";
import {
  recordingTransport,
  type RecordingTransport,
} from "../support/recorder.ts";
import {
  attr,
  json,
  testAdmin,
  uniqueDb,
  type LocalUrls,
} from "./fixtures.ts";
import { TEST_CAPABILITY } from "./test-hooks-env.ts";

type AdminResponse = Awaited<ReturnType<typeof testAdmin>>;
type SocketHarness = {
  readonly socket: WebSocket;
  readonly recorder: RecordingTransport;
};

const TIMEOUT_MS = 12_000;
const WRITE_FENCE = "transactor.commit.write";

const SCHEMA = [
  attr(":k/id", "long", { ":db/unique": ":db.unique/identity" }),
  attr(":k/v", "string"),
  attr(":k/n", "long"),
  attr(":item/uid", "uuid"),
];

const requireOk = <A = any>(label: string, response: AdminResponse): A => {
  if (response.status !== 200) {
    throw new Error(
      `${label} failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  return response.body as A;
};

const waitFor = async (
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`${label} timed out${detail}`);
};

const transactorInfo = async (base: string, db: string): Promise<any> =>
  requireOk("transactor info", await testAdmin(base, db, "/info", {}));

const r2List = async (
  base: string,
  db: string,
  prefix: string,
): Promise<string[]> => {
  const body = requireOk<any>(
    `r2 list ${prefix}`,
    await testAdmin(base, db, "/r2", { action: "list", prefix }),
  );
  expect(body.truncated).toBe(false);
  return body.objects.map((object: { key: string }) => object.key).sort();
};

const r2Body = async (base: string, db: string, key: string): Promise<string> => {
  const body = requireOk<any>(
    `r2 get ${key}`,
    await testAdmin(base, db, "/r2", { action: "get", key }),
  );
  if (body.found !== true || typeof body.bodyBase64 !== "string") {
    throw new Error(`missing R2 object ${key}`);
  }
  const bytes = Uint8Array.from(atob(body.bodyBase64), (char) =>
    char.charCodeAt(0)
  );
  return new TextDecoder().decode(bytes);
};

const subscriberUrl = (base: string, db: string, from: number): URL => {
  const url = new URL(
    `/__test__/db/${encodeURIComponent(db)}/subscribe?from=${from}`,
    base,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("__ramose_test_capability", TEST_CAPABILITY);
  return url;
};

const openSubscriber = async (
  base: string,
  db: string,
  from: number,
): Promise<SocketHarness> => {
  for (let attempt = 0; ; attempt++) {
    const recorder = recordingTransport();
    const socket = new recorder.webSocket(subscriberUrl(base, db, from));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("transactor subscriber timed out opening")),
          TIMEOUT_MS,
        );
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("transactor subscriber failed to open"));
        }, { once: true });
      });
      return { socket, recorder };
    } catch (error) {
      socket.close();
      if (attempt === 2) throw error;
      await Bun.sleep(50 * (attempt + 1));
    }
  }
};

const received = (harness: SocketHarness): any[] =>
  harness.recorder.frames
    .filter((frame) => frame.direction === "recv")
    .map((frame) => frame.payload);

const waitForFrame = async <A>(
  harness: SocketHarness,
  predicate: (frame: any) => frame is A,
): Promise<A> => {
  const existing = received(harness).find(predicate);
  if (existing !== undefined) return existing;
  return new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => {
      harness.socket.removeEventListener("message", onMessage);
      reject(
        new Error(
          `transactor frame timed out: ${JSON.stringify(received(harness))}`,
        ),
      );
    }, TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!predicate(frame)) return;
      clearTimeout(timer);
      harness.socket.removeEventListener("message", onMessage);
      resolve(frame);
    };
    harness.socket.addEventListener("message", onMessage);
  });
};

const frameKind = (kind: string) =>
  (frame: any): frame is { kind: string; t?: number; from?: number } =>
    frame !== null && typeof frame === "object" && frame.kind === kind;

const queryIds = async (
  base: string,
  db: string,
  minT: number,
): Promise<number[]> => {
  const response = await testAdmin(
    base,
    db,
    "/query",
    { query: "[:find ?id :where [?e :k/id ?id]]" },
    { "x-ramose-min-t": String(minT) },
  );
  const body = requireOk<any>("query ids", response);
  return body.result.flat().sort((a: number, b: number) => a - b);
};

export function registerTransactor(target: { urls: () => LocalUrls }): void {
  describe("real Transactor DO", () => {
    test("fresh boot, HTTP errors, replay, UUID normalization, and durable log", async () => {
      const base = target.urls().openUrl;
      const db = uniqueDb("txhttp");

      const initial = await transactorInfo(base, db);
      expect(initial.t).toBe(1);
      expect(initial.root.t).toBe(0);
      expect([
        ...(await r2List(base, db, "seg/")),
        ...(await r2List(base, db, "n/")),
      ].length).toBeGreaterThan(0);

      const schema = requireOk<any>(
        "schema",
        await testAdmin(base, db, "/transact", { tx: SCHEMA }),
      );
      const malformed = await testAdmin(base, db, "/transact", { nope: 1 });
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({
        tag: "BadRequest",
        error: "body must be { tx: [...] }",
      });
      const rejected = await testAdmin(base, db, "/transact", {
        tx: [[":db/add", 1, ":k/nope", 1]],
      });
      expect(rejected.status).toBe(409);
      expect(rejected.body.tag).toBe("TxRejected");
      expect(String(rejected.body.error)).toMatch(/:k\/nope/);

      const ack = requireOk<any>(
        "uuid write",
        await testAdmin(base, db, "/transact", {
          tx: [
            {
              ":db/id": "item",
              ":item/uid": "3F333DF6-90A4-4FDA-8DD3-9485D27CEE36",
            },
          ],
          clientTxId: "uuid-once",
        }),
      );
      expect(ack.t).toBe(schema.t + 1);
      expect(ack.clientTxId).toBe("uuid-once");
      const replay = requireOk<any>(
        "replay",
        await testAdmin(base, db, "/transact", {
          tx: [{ ":item/uid": "00000000-0000-4000-8000-000000000000" }],
          clientTxId: "uuid-once",
        }),
      );
      expect(replay).toEqual(ack);

      const entity = requireOk<any>(
        "uuid entity",
        await testAdmin(
          base,
          db,
          "/query",
          { entity: ack.tempids.item },
          { "x-ramose-min-t": String(ack.t) },
        ),
      );
      expect(entity.entity[":item/uid"]).toBe(
        "3f333df6-90a4-4fda-8dd3-9485d27cee36",
      );
      expect(typeof entity.entity[":item/uid"]).toBe("string");

      const invalidJson = await json(
        base,
        `/__test__/db/${encodeURIComponent(db)}/transact`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        },
      );
      expect(invalidJson.status).toBe(500);
      expect(invalidJson.body.tag).toBe("Internal");

      const info = await transactorInfo(base, db);
      expect(info.t).toBe(ack.t);
      expect(info.stats.rejected).toBe(1);
      expect(info.metrics.enabled).toBe(false);
      expect(info.metrics.aeWrites).toBe(0);
      const log = requireOk<any>(
        "transactor log",
        await testAdmin(base, db, "/log", { from: 0 }),
      );
      expect(log.entries.map((entry: any) => entry.t)).toEqual(
        Array.from({ length: ack.t }, (_, index) => index + 1),
      );
    });

    test("concurrent callers get dense t values through real group commits", async () => {
      const base = target.urls().openUrl;
      const db = uniqueDb("txbatch");
      const schema = requireOk<any>(
        "schema",
        await testAdmin(base, db, "/transact", { tx: SCHEMA }),
      );
      const before = await transactorInfo(base, db);
      const count = 80;
      const responses = await Promise.all(
        Array.from({ length: count }, (_, id) =>
          testAdmin(base, db, "/transact", {
            tx: [{ ":k/id": id, ":k/v": `v${id}` }],
          })
        ),
      );
      const acks = responses.map((response, index) =>
        requireOk<any>(`concurrent write ${index}`, response)
      );
      const ts = acks.map((ack) => ack.t).sort((a, b) => a - b);
      expect(ts).toEqual(
        Array.from({ length: count }, (_, index) => schema.t + 1 + index),
      );

      const info = await transactorInfo(base, db);
      const batches = info.stats.batches - before.stats.batches;
      expect(batches).toBeGreaterThan(0);
      expect(batches).toBeLessThan(count / 2);
      expect(info.stats.maxBatch).toBeGreaterThan(1);
      expect(info.metrics.batchSize.count).toBe(info.stats.batches);
      expect(info.metrics.batchResolveMs.count).toBe(info.stats.batches);
      expect(info.metrics.batchCommitMs.count).toBe(info.stats.batches);
      expect(info.metrics.batchLoopMs.count).toBe(info.stats.batches);
      expect(info.metrics.queueDepth).toBe(0);

      const log = requireOk<any>(
        "group commit log",
        await testAdmin(base, db, "/log", { from: schema.t }),
      );
      expect(log.entries.map((entry: any) => entry.t)).toEqual(ts);
      expect(await queryIds(base, db, ts.at(-1)!)).toEqual(
        Array.from({ length: count }, (_, id) => id),
      );
    });

    test("interrupted and failed batches commit no subset, then restart gap-free", async () => {
      const base = target.urls().openUrl;
      const db = uniqueDb("txrollback");
      requireOk("schema", await testAdmin(base, db, "/transact", { tx: SCHEMA }));
      const seed = requireOk<any>(
        "seed",
        await testAdmin(base, db, "/transact", {
          tx: [{ ":k/id": 1, ":k/v": "kept" }],
        }),
      );

      requireOk(
        "arm commit wait",
        await testAdmin(base, db, "/checkpoint", {
          scope: "transactor",
          action: "arm-wait",
          name: "transactor.commit",
        }),
      );
      const interrupted = testAdmin(base, db, "/transact", {
        tx: [{ ":k/id": 2, ":k/v": "interrupted", ":k/n": 2 }],
      }).catch((error) => ({ error }));
      await waitFor(async () => {
        const status = await testAdmin(base, db, "/checkpoint", {
          scope: "transactor",
          action: "status",
        });
        return status.body.checkpoints?.["transactor.commit"]?.pending === true;
      }, "commit checkpoint");
      requireOk(
        "abort interrupted transactor",
        await testAdmin(base, db, "/abort", { target: "transactor" }),
      );
      await interrupted;
      await waitFor(async () => {
        const response = await testAdmin(base, db, "/info", {});
        return response.status === 200 && response.body.t === seed.t;
      }, "transactor restart after interrupted commit");
      expect(await queryIds(base, db, seed.t)).toEqual([1]);

      requireOk(
        "arm failed batch wait",
        await testAdmin(base, db, "/checkpoint", {
          scope: "transactor",
          action: "arm-wait",
          name: "transactor.commit",
        }),
      );
      requireOk(
        "arm failed batch storage throw",
        await testAdmin(base, db, "/checkpoint", {
          scope: "transactor",
          action: "arm-throw",
          name: WRITE_FENCE,
          error: "induced real DO SQLite write failure",
        }),
      );
      const failing = [testAdmin(base, db, "/transact", {
        tx: [{ ":k/id": 3, ":k/v": "failed-3" }],
      })];
      await waitFor(async () => {
        const status = await testAdmin(base, db, "/checkpoint", {
          scope: "transactor",
          action: "status",
        });
        return status.body.checkpoints?.["transactor.commit"]?.pending === true;
      }, "failed batch commit checkpoint");
      failing.push(...[4, 5].map((id) =>
        testAdmin(base, db, "/transact", {
          tx: [{ ":k/id": id, ":k/v": `failed-${id}` }],
        })
      ));
      await waitFor(async () => {
        const response = await testAdmin(base, db, "/info", {});
        return response.status === 200 && response.body.metrics.queueDepth === 2;
      }, "failed batch queued requests");
      // Releasing reaches the armed sync throw before the admin response can
      // leave the isolate, so this request may observe the expected abort.
      // The three transaction results below are the authoritative outcome.
      await testAdmin(base, db, "/checkpoint", {
        scope: "transactor",
        action: "release",
        name: "transactor.commit",
      }).catch(() => undefined);
      const failed = await Promise.allSettled(failing);
      expect(
        failed.some(
          (result) => result.status === "fulfilled" && result.value.status === 200,
        ),
      ).toBe(false);
      await waitFor(async () => {
        const response = await testAdmin(base, db, "/info", {});
        return response.status === 200 && response.body.t === seed.t;
      }, "transactor restart after failed storage batch");
      expect(await queryIds(base, db, seed.t)).toEqual([1]);

      const retried = await Promise.all(
        [3, 4, 5].map((id) =>
          testAdmin(base, db, "/transact", {
            tx: [{ ":k/id": id, ":k/v": `retry-${id}` }],
          })
        ),
      );
      const retryTs = retried
        .map((response, index) => requireOk<any>(`retry ${index}`, response).t)
        .sort((a, b) => a - b);
      expect(retryTs).toEqual([seed.t + 1, seed.t + 2, seed.t + 3]);
      expect(await queryIds(base, db, retryTs.at(-1)!)).toEqual([1, 3, 4, 5]);
    });
  });

  describe("real Transactor subscriber and indexer", () => {
    test("subscriber receives ordered tx/root frames and stale catch-up gaps", async () => {
      const base = target.urls().transactorUrl;
      const db = uniqueDb("txsocket");
      const schema = requireOk<any>(
        "schema",
        await testAdmin(base, db, "/transact", { tx: SCHEMA }),
      );
      const live = await openSubscriber(base, db, schema.t);
      try {
        const hello = await waitForFrame(live, frameKind("hello"));
        expect(hello.t).toBe(schema.t);
        const responses = await Promise.all(
          Array.from({ length: 6 }, (_, id) =>
            testAdmin(base, db, "/transact", {
              tx: [{ ":k/id": id, ":k/v": `v${id}` }],
            })
          ),
        );
        const ts = responses
          .map((response, index) =>
            requireOk<any>(`subscriber write ${index}`, response).t
          )
          .sort((a, b) => a - b);
        await waitFor(async () =>
          received(live).filter(frameKind("tx")).length === 6,
        "subscriber tx frames");
        expect(received(live).filter(frameKind("tx")).map((frame) => frame.t))
          .toEqual(ts);

        let indexed: any;
        do {
          indexed = requireOk<any>(
            "manual index",
            await testAdmin(base, db, "/index", {}),
          );
        } while (indexed.remainingTxs > 0);
        expect(indexed.toT).toBe(ts.at(-1));
        const root = await waitForFrame(
          live,
          (frame: any): frame is { kind: "root"; root: { t: number } } =>
            frame?.kind === "root" && frame.root?.t === ts.at(-1),
        );
        expect(root.root.t).toBe(ts.at(-1));

        const info = await transactorInfo(base, db);
        expect(info.earliestLogT).toBeGreaterThan(schema.t + 1);
        const tail = requireOk<any>(
          "pruned log",
          await testAdmin(base, db, "/log", { from: 0 }),
        );
        expect(tail.entries.length).toBeLessThanOrEqual(3);
      } finally {
        live.socket.close();
      }

      const stale = await openSubscriber(base, db, schema.t);
      try {
        const gap = await waitForFrame(stale, frameKind("gap"));
        expect(gap.from).toBeGreaterThan(schema.t);
        await waitFor(async () =>
          received(stale).filter(frameKind("tx")).length > 0,
        "stale subscriber tail");
      } finally {
        stale.socket.close();
      }

      const afterClose = requireOk<any>(
        "write after subscriber close",
        await testAdmin(base, db, "/transact", {
          tx: [{ ":k/id": 99, ":k/v": "after-close" }],
        }),
      );
      expect(afterClose.t).toBeGreaterThan(schema.t);
    });

    test("incremental roots structurally share real R2 objects and preserve as-of", async () => {
      const base = target.urls().transactorUrl;
      const db = uniqueDb("txsharing");
      const schema = [
        attr(":p/id", "long", { ":db/unique": ":db.unique/identity" }),
        attr(":p/age", "long"),
        attr(":p/city", "string", { ":db/index": true }),
      ];
      requireOk("schema", await testAdmin(base, db, "/transact", { tx: schema }));
      const seed = requireOk<any>(
        "large seed",
        await testAdmin(base, db, "/transact", {
          tx: Array.from({ length: 800 }, (_, id) => ({
            ":p/id": id,
            ":p/age": id % 90,
            ":p/city": `c${id % 40}`,
          })),
        }),
      );
      const first = requireOk<any>(
        "first index",
        await testAdmin(base, db, "/index", {}),
      );
      expect(first.toT).toBe(seed.t);
      const beforeNodes = new Set([
        ...(await r2List(base, db, "seg/")),
        ...(await r2List(base, db, "n/")),
      ]);
      const beforeRoots = await r2List(base, db, "roots/");

      const delta = requireOk<any>(
        "small delta",
        await testAdmin(base, db, "/transact", {
          tx: [
            { ":p/id": 0, ":p/age": 200 },
            ...Array.from({ length: 10 }, (_, offset) => ({
              ":p/id": 800 + offset,
              ":p/age": offset,
              ":p/city": "new",
            })),
          ],
        }),
      );
      const second = requireOk<any>(
        "second index",
        await testAdmin(base, db, "/index", {}),
      );
      expect(second.toT).toBe(delta.t);
      const afterNodes = new Set([
        ...(await r2List(base, db, "seg/")),
        ...(await r2List(base, db, "n/")),
      ]);
      const fresh = [...afterNodes].filter((key) => !beforeNodes.has(key));
      expect(second.r2Puts).toBe(fresh.length);
      expect(fresh.length).toBeGreaterThan(0);
      expect(fresh.length).toBeLessThan(beforeNodes.size);
      const afterRoots = await r2List(base, db, "roots/");
      expect(afterRoots.length).toBe(beforeRoots.length + 1);

      const query = "[:find ?age . :where [?e :p/id 0] [?e :p/age ?age]]";
      const old = requireOk<any>(
        "old as-of",
        await testAdmin(base, db, "/query", { query, asOf: first.toT }),
      );
      const current = requireOk<any>(
        "current value",
        await testAdmin(
          base,
          db,
          "/query",
          { query },
          { "x-ramose-min-t": String(delta.t) },
        ),
      );
      expect(old.result).toBe(0);
      expect(current.result).toBe(200);
    });

    test("an index checkpoint exposes the old root until retry publishes the new root", async () => {
      const base = target.urls().transactorUrl;
      const db = uniqueDb("txindexcut");
      requireOk("schema", await testAdmin(base, db, "/transact", { tx: SCHEMA }));
      const seed = requireOk<any>(
        "seed",
        await testAdmin(base, db, "/transact", {
          tx: [{ ":k/id": 1, ":k/v": "old" }],
        }),
      );
      const baseline = requireOk<any>(
        "baseline index",
        await testAdmin(base, db, "/index", {}),
      );
      expect(baseline.toT).toBe(seed.t);
      const oldRoot = await r2Body(base, db, "root/current");
      const latest = requireOk<any>(
        "unindexed write",
        await testAdmin(base, db, "/transact", {
          tx: [{ ":k/id": 2, ":k/v": "new" }],
        }),
      );
      requireOk(
        "arm index wait",
        await testAdmin(base, db, "/checkpoint", {
          scope: "transactor",
          action: "arm-wait",
          name: "indexer.run",
        }),
      );
      const indexing = testAdmin(base, db, "/index", {}).catch((error) => ({
        error,
      }));
      await waitFor(async () => {
        const status = await testAdmin(base, db, "/checkpoint", {
          scope: "transactor",
          action: "status",
        });
        return status.body.checkpoints?.["indexer.run"]?.pending === true;
      }, "index checkpoint");
      expect(await r2Body(base, db, "root/current")).toBe(oldRoot);
      expect(await queryIds(base, db, latest.t)).toEqual([1, 2]);

      requireOk(
        "abort indexing isolate",
        await testAdmin(base, db, "/abort", { target: "transactor" }),
      );
      await indexing;
      expect(await r2Body(base, db, "root/current")).toBe(oldRoot);
      await waitFor(async () => {
        const response = await testAdmin(base, db, "/info", {});
        return response.status === 200 &&
          response.body.t === latest.t &&
          response.body.root.t === baseline.toT;
      }, "indexer restart on old complete root");

      const retried = requireOk<any>(
        "retry index",
        await testAdmin(base, db, "/index", {}),
      );
      expect(retried.toT).toBe(latest.t);
      expect(await r2Body(base, db, "root/current")).not.toBe(oldRoot);
      expect(await queryIds(base, db, latest.t)).toEqual([1, 2]);
    });

    test("real alarms drain bounded index runs and re-arm until caught up", async () => {
      const base = target.urls().transactorUrl;
      const db = uniqueDb("txalarm");
      requireOk("schema", await testAdmin(base, db, "/transact", { tx: SCHEMA }));
      const responses = await Promise.all(
        Array.from({ length: 30 }, (_, id) =>
          testAdmin(base, db, "/transact", {
            tx: [{ ":k/id": id, ":k/v": `v${id}` }],
          })
        ),
      );
      const t = Math.max(
        ...responses.map((response, index) =>
          requireOk<any>(`alarm write ${index}`, response).t
        ),
      );
      await waitFor(async () => {
        const info = await transactorInfo(base, db);
        return info.root.t === t &&
          info.indexer.runs > 1 &&
          info.indexer.lastRun?.remainingTxs === 0;
      }, "bounded alarm drain", 20_000);

      const info = await transactorInfo(base, db);
      expect(info.opts.maxBatch).toBe(8);
      expect(info.stats.maxBatch).toBeLessThanOrEqual(8);
      expect(info.metrics.fenceMs.count).toBe(info.stats.batches);
      expect(info.indexer.lastRun.txs).toBeLessThanOrEqual(5);
      const chunks = await r2List(base, db, "log/");
      expect(chunks.length).toBeGreaterThan(1);
      for (const key of chunks) {
        const match = /log\/(\d+)-(\d+)$/.exec(key);
        expect(match).not.toBeNull();
        expect(Number(match![2]) - Number(match![1]) + 1).toBeLessThanOrEqual(5);
      }
      expect((await r2List(base, db, "roots/")).length).toBeGreaterThan(2);
      expect(await queryIds(base, db, t)).toEqual(
        Array.from({ length: 30 }, (_, id) => id),
      );
    });
  });
}
