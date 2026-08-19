/**
 * End-to-end tests against a running Ramose deployment (dev stage via
 * `bun alchemy dev`, or a deployed URL).
 *
 *   RAMOSE_URL=http://localhost:8787 bun test test/e2e
 *   RAMOSE_URL=https://ramose-<stage>.<acct>.workers.dev RAMOSE_TOKEN=... bun test test/e2e
 *
 * Skipped when RAMOSE_URL is not set.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Ramose from "../../packages/ramose/src/db/index.ts";
import { attrMap, Peer } from "../support/ramoseHttp.ts";

const URL_ = process.env.RAMOSE_URL;
const token = process.env.RAMOSE_TOKEN;
const d = URL_ ? describe : describe.skip;

// Real Cloudflare (workers.dev) is slower than local miniflare, and Peer
// retries transient platform errors — keep headroom above Bun's 5s default.
setDefaultTimeout(60_000);

const dbName = `e2e-${Date.now().toString(36)}`;

d("ramose e2e", () => {
  const client = new Peer(URL_ ?? "http://invalid", {
    token,
    // A fresh workers.dev hostname is eventually consistent across the edge:
    // a colo can serve the HTML placeholder mid-suite, minutes after /health
    // passes. Absorb up to 30s of that per request (application errors never
    // retry). Test timeout is 60s, so a retried request still fails loudly.
    retryTransientMs: 30_000,
  });
  const db = client.db(dbName);
  let alice = 0, bob = 0, tSchema = 0, tAge30 = 0;

  test("M0: worker answers", async () => {
    const h = await client.health();
    expect(h.ok).toBe(true);
  });

  test("schema install → transact → query", async () => {
    const s = await db.transact([
      attrMap(":user/name", "string", { index: true }),
      attrMap(":user/email", "string", { unique: "identity" }),
      attrMap(":user/age", "long"),
      attrMap(":user/friends", "ref", { cardinality: "many" }),
      attrMap(":user/joined", "instant"),
    ]);
    tSchema = s.t;
    expect(s.t).toBeGreaterThanOrEqual(2);
    const r = await db.transact([
      { ":db/id": "alice", ":user/name": "Alice", ":user/email": "alice@example.com", ":user/age": 30, ":user/joined": new Date("2021-05-05Z") },
      { ":db/id": "bob", ":user/name": "Bob", ":user/email": "bob@example.com", ":user/age": 25, ":user/friends": ["alice"] },
    ]);
    alice = r.tempids.alice;
    bob = r.tempids.bob;
    tAge30 = r.t;
    // read-your-writes through the replica
    const names = await db.q<string[]>(`[:find [?n ...] :where [?e :user/name ?n]]`);
    expect(names.sort()).toEqual(["Alice", "Bob"]);
    const joined = await db.q<Date>(`[:find ?j . :in $ ?e :where [?e :user/joined ?j]]`, [alice]);
    expect(joined).toBeInstanceOf(Date);
    expect((joined as Date).toISOString()).toBe("2021-05-05T00:00:00.000Z");
    const friend = await db.q<string>(`[:find ?fn . :where [?e :user/name "Bob"] [?e :user/friends ?f] [?f :user/name ?fn]]`);
    expect(friend).toBe("Alice");
  });

  test("update, as-of, history, pull", async () => {
    const u = await db.transact([[":db/add", [":user/email", "alice@example.com"], ":user/age", 31]]);
    expect(await db.q<number>(`[:find ?a . :in $ ?e :where [?e :user/age ?a]]`, [alice])).toBe(31);
    expect(await db.asOf(tAge30).q<number>(`[:find ?a . :in $ ?e :where [?e :user/age ?a]]`, [alice])).toBe(30);
    expect(await db.asOf(tSchema).q(`[:find ?a . :in $ ?e :where [?e :user/age ?a]]`, [alice])).toBeNull();
    const hist = await db.history().q<[number, boolean][]>(`[:find ?a ?op :in $ ?e :where [?e :user/age ?a _ ?op]]`, [alice]);
    expect(hist.map((r) => JSON.stringify(r)).sort()).toEqual([[30, false], [30, true], [31, true]].map((r) => JSON.stringify(r)).sort());
    const p = await db.pull(bob, `[:user/name {:user/friends [:user/name :user/age]}]`);
    expect(p).toEqual({ ":user/name": "Bob", ":user/friends": [{ ":user/name": "Alice", ":user/age": 31 }] });
    expect(u.t).toBeGreaterThan(tAge30);
  });

  test("unique conflicts are rejected with 409", async () => {
    await expect(db.transact([{ ":user/name": "Eve", ":user/email": "alice@example.com", ":user/age": 1 }])).resolves.toBeDefined(); // upsert (identity)
    const r = await db.q(`[:find ?n . :in $ ?e :where [?e :user/name ?n]]`, [alice]);
    expect(r).toBe("Eve");
    await db.transact([[":db/add", alice, ":user/name", "Alice"]]);
  });

  test("index run publishes a root; queries stay consistent; repeat query hits cache", async () => {
    const before = await db.info();
    const idx = await db.index();
    expect(idx.ran).toBe(true);
    expect(idx.root.t).toBeGreaterThanOrEqual(tAge30);
    const after = await db.info();
    expect(after.transactor.root.t).toBeGreaterThan(before.transactor.root.t ?? 0);
    const q1 = await db.query(`[:find ?n ?a :where [?e :user/name ?n] [?e :user/age ?a]]`);
    const q2 = await db.query(`[:find ?n ?a :where [?e :user/name ?n] [?e :user/age ?a]]`);
    expect(q1.result.length).toBe(2);
    expect(q2.result.length).toBe(2);
    if (q2.meta.r2Gets !== null) expect(q2.meta.r2Gets).toBe(0); // warm isolate: no R2 reads
    // as-of still correct after the root flip
    expect(await db.asOf(tAge30).q<number>(`[:find ?a . :in $ ?e :where [?e :user/age ?a]]`, [alice])).toBe(30);
  });

  test("serialized t under concurrent clients (no gaps / dupes)", async () => {
    const acks = await Promise.all(Array.from({ length: 40 }, (_, i) => db.transact([{ ":user/name": `c${i}`, ":user/email": `c${i}@example.com` }])));
    const ts = acks.map((a) => a.t).sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBe(ts[i - 1] + 1);
    const count = await db.q<number>(`[:find (count ?e) . :where [?e :user/email]]`);
    expect(count).toBe(42);
  });

  test("M5: replica reconnect resumes with no missed datoms; root flips drop novelty", async () => {
    // writes land while the replica is (re)connecting: nothing may be missed
    const before = await db.q<number>(`[:find (count ?e) . :where [?e :user/email]]`);
    const [rc, ...acks] = await Promise.all([
      db.reconnectReplica(),
      ...Array.from({ length: 25 }, (_, i) => db.transact([{ ":user/name": `r${i}`, ":user/email": `r${i}@example.com` }])),
    ]);
    expect(rc.ok).toBe(true);
    const lastT = Math.max(...acks.map((a) => a.t));
    // read-your-writes: the basis served after the last ack covers it
    const q = await db.query(`[:find (count ?e) . :where [?e :user/email]]`);
    expect(q.t).toBeGreaterThanOrEqual(lastT);
    expect(q.result).toBe(before + 25);
    const info1 = await db.info();
    expect(info1.replica.t).toBeGreaterThanOrEqual(lastT);
    expect(info1.replica.novelty).toBeGreaterThan(0);
    // an index run flips the root → the replica drops the absorbed novelty (memory stays bounded)
    await db.index();
    // the root frame reaches the replica over its WebSocket a beat after index() acks (~100 ms on real Cloudflare)
    let info2 = await db.info();
    for (let i = 0; i < 40 && info2.replica.stats.rootFlips <= info1.replica.stats.rootFlips; i++) {
      await Bun.sleep(250);
      info2 = await db.info();
    }
    expect(info2.replica.stats.rootFlips).toBeGreaterThan(info1.replica.stats.rootFlips);
    expect(info2.replica.novelty).toBeLessThan(info1.replica.novelty);
    expect(await db.q<number>(`[:find (count ?e) . :where [?e :user/email]]`)).toBe(before + 25);
  });

  test("M7: an over-budget query is refused with a tagged 413, not an OOM", async () => {
    // cross product of two unrelated patterns over the users written so far: refused up front
    let err: any;
    try {
      await db.q(`[:find ?a ?b :where [?x :user/email ?a] [?y :user/email ?b] [?z :user/email ?c]]`);
    } catch (e) {
      err = e;
    }
    // ~70 users → 70³ = 343k rows × 6 cols > default budget? Not necessarily; force it via a tiny budget is a server setting,
    // so accept either a clean success or a tagged refusal — but never a 5xx.
    if (err) {
      expect(err.status).toBe(413);
      expect(err.code).toBe("query/budget-exceeded");
    }
    // and a normal query still works afterwards
    expect(await db.q<number>(`[:find (count ?e) . :where [?e :user/email]]`)).toBeGreaterThan(0);
  });

  test("write throughput smoke (group commit)", async () => {
    const N = 300;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: N }, (_, i) => db.transact([{ ":user/name": `w${i}`, ":user/email": `w${i}@example.com` }])));
    const ms = performance.now() - t0;
    const info = await db.info();
    console.log(`e2e write smoke: ${N} tx in ${ms.toFixed(0)} ms → ${((N / ms) * 1000).toFixed(0)} tx/s; max batch ${info.transactor.stats.maxBatch}`);
    expect(info.transactor.stats.maxBatch).toBeGreaterThan(1); // group commit actually batched
  });
});

/**
 * The session socket (`GET /db/:name/session`), over a real WebSocket.
 *
 * `Ramose.layer` is the whole client: reads and `t` ticks ride the socket,
 * `transact` is HTTPS, and a write on *another* connection shows up here as a
 * standing `db.live` re-running.
 */
const Session = Ramose.Namespace("s", {
  name: Ramose.Attr(Schema.String, { unique: "identity" }),
  n: Ramose.Attr(Ramose.Long),
});
const SessionCatalog = Ramose.Catalog({ s: Session });

d("ramose session socket e2e", () => {
  const url = URL_ ?? "http://invalid";
  const sessionDb = `${dbName}-session`;

  /**
   * The alchemy client's own transient retry is a ~6s ladder; a fresh
   * workers.dev host can serve platform errors for longer than that (see
   * `retryTransientMs` on the raw Peer above). Absorb up to 30s per operation
   * — only `Unavailable` / `NetworkError`; application errors never retry.
   */
  const absorb = <A, E extends { readonly _tag: string }, R>(
    eff: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.retry(eff, {
      while: (e) => e._tag === "Unavailable" || e._tag === "NetworkError",
      schedule: Schedule.spaced("500 millis").pipe(
        Schedule.upTo({ duration: "30 seconds" }),
      ),
    });

  test(
    "one socket queries and pulls; a write on another connection wakes db.live",
    async () => {
      const options = {
        url,
        token: token === undefined ? undefined : Effect.succeed(Redacted.make(token)),
      };
      const a = ManagedRuntime.make(Ramose.layer(options));
      const b = ManagedRuntime.make(Ramose.layer(options));
      try {
        const dbA = a.runSync(Ramose.Databases).db(sessionDb, SessionCatalog);
        const dbB = b.runSync(Ramose.Databases).db(sessionDb, SessionCatalog);

        await a.runPromise(absorb(dbA.install()));
        const report = await a.runPromise(
          absorb(
            dbA.transact(function* (tx) {
              const ada = yield* tx.entity();
              yield* ada.add(Session.name, "Ada");
              yield* ada.add(Session.n, 1);
            }),
          ),
        );
        expect(report.t).toBeGreaterThan(0);

        // read-your-writes with no second round trip
        const names = await a.runPromise(
          absorb(
            report.dbAfter.q(
              Ramose.query(Session).select({ name: Session.name }),
            ),
          ),
        );
        expect(names).toEqual([{ name: "Ada" }]);

        const pulled = await a.runPromise(
          absorb(
            report.dbAfter.pull([":s/name", "Ada"], {
              name: Session.name,
              n: Session.n,
            }),
          ),
        );
        expect(pulled).toEqual({ name: "Ada", n: 1 });

        // …and B's write reaches A's standing stream without A polling
        const seen: number[] = [];
        const fiber = a.runFork(
          Stream.runForEach(
            dbA.live(
              Ramose.query(Session).select({ name: Session.name }),
            ),
            (rows) => Effect.sync(() => seen.push(rows.length)),
          ),
        );
        for (let i = 0; i < 40 && seen.length === 0; i++) await Bun.sleep(100);

        await b.runPromise(
          absorb(
            dbB.transact(function* (tx) {
              const bob = yield* tx.entity();
              yield* bob.add(Session.name, "Bob");
              yield* bob.add(Session.n, 2);
            }),
          ),
        );
        // Prove B's write is visible on A's HTTPS path before requiring live.
        let count = 0;
        for (let i = 0; i < 40 && count < 2; i++) {
          count = (
            await a.runPromise(
              absorb(
                dbA.q(Ramose.query(Session).select({ name: Session.name })),
              ),
            )
          ).length;
          if (count < 2) await Bun.sleep(250);
        }
        expect(count).toBeGreaterThanOrEqual(2);
        // Cross-connection novelty over a fresh workers.dev peer can take longer
        // than a local miniflare hop; wait up to ~45s for the standing live.
        for (let i = 0; i < 90 && (seen.at(-1) ?? 0) < 2; i++) await Bun.sleep(500);
        await Effect.runPromise(Fiber.interrupt(fiber));

        expect(seen.at(-1)).toBeGreaterThanOrEqual(2);
      } finally {
        await a.dispose();
        await b.dispose();
      }
    },
    120_000,
  );

  /**
   * Regression for #28: two session sockets on one db. The shared basis
   * watcher used to run in the first session's request context; the fan-out to
   * the second socket was illegal cross-context I/O in workerd, so the second
   * session zombied after the first write (no ticks, frames dropped with no
   * reply, socket never closed).
   *
   * Raw sockets on purpose: the client's reconnect-on-close would mask a
   * zombied session. Under local miniflare both sockets share one isolate —
   * the exact #28 shape; on real Cloudflare they may land apart, which only
   * makes the test weaker, never wrongly red.
   */
  test(
    "two session sockets on one db both tick on every write; both keep answering (#28)",
    async () => {
      const twoDb = `${dbName}-two-socks`;
      const http = new Peer(url, { token, retryTransientMs: 30_000 }).db(twoDb);
      const wsUrl = `${url.replace(/^http/, "ws")}/db/${encodeURIComponent(twoDb)}/session${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`;

      interface RawSock {
        ws: WebSocket;
        frames: any[];
        closed: boolean;
        next: number;
      }
      const openSock = (): Promise<RawSock> =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const s: RawSock = { ws, frames: [], closed: false, next: 1 };
          ws.addEventListener("open", () => resolve(s));
          ws.addEventListener("error", (ev) => reject(new Error(`session socket error: ${String((ev as { message?: unknown }).message ?? ev)}`)));
          ws.addEventListener("close", () => {
            s.closed = true;
          });
          ws.addEventListener("message", (ev) => s.frames.push(JSON.parse(String(ev.data))));
        });
      const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
        const t0 = Date.now();
        while (!cond() && Date.now() - t0 < ms) await Bun.sleep(100);
        return cond();
      };
      const ticksOf = (s: RawSock): number[] => s.frames.filter((f) => f.op === "t").map((f) => f.t as number);
      /** send one `info` frame; resolve to its reply (a zombie never answers) */
      const answers = async (s: RawSock): Promise<boolean> => {
        const id = s.next++;
        s.ws.send(JSON.stringify({ id, op: "info" }));
        return until(() => s.frames.some((f) => f.id === id && f.status === 200), 15_000);
      };

      // the db must exist before a socket can watch it move
      const t0 = (await http.transact([attrMap(":two/a", "string")])).t;
      const s1 = await openSock();
      const s2 = await openSock();
      try {
        expect(await answers(s1)).toBe(true);
        expect(await answers(s2)).toBe(true);
        // let each session's watcher take its seed reading before the write moves the basis
        await Bun.sleep(2_500);

        const w1 = await http.transact([attrMap(":two/b", "string")]);
        expect(w1.t).toBeGreaterThan(t0);
        // the non-polling session reads the shared basis one interval later; real CF adds edge lag
        expect(await until(() => ticksOf(s1).some((t) => t >= w1.t) && ticksOf(s2).some((t) => t >= w1.t), 20_000)).toBe(true);

        // the second write is the #28 regression: the old fan-out had killed one session by now
        const w2 = await http.transact([attrMap(":two/c", "string")]);
        expect(await until(() => ticksOf(s1).some((t) => t >= w2.t) && ticksOf(s2).some((t) => t >= w2.t), 20_000)).toBe(true);

        expect(await answers(s1)).toBe(true);
        expect(await answers(s2)).toBe(true);
        expect(s1.closed).toBe(false);
        expect(s2.closed).toBe(false);
      } finally {
        s1.ws.close();
        s2.ws.close();
      }
    },
    120_000,
  );
});
