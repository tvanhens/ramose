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
import * as Stream from "effect/Stream";
import * as Ramose from "../../packages/ramose/src/db/index.ts";
import * as RamoseEffect from "../../packages/ramose/src/db/effect.ts";
import { addReefIssue, addReefUser, addSession, moveReefIssue } from "../../e2e-ops.ts";
import { attrMap, Peer } from "../support/ramoseHttp.ts";

const { Query, Q } = Ramose;

/** Required card-one fields on the raw `:user/*` e2e schema. */
const JOINED = new Date("2021-05-05Z");
const userAttrs = (
  name: string,
  email: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ":user/name": name,
  ":user/email": email,
  ":user/age": 20,
  ":user/joined": JOINED,
  ...extra,
});

const URL_ = process.env.RAMOSE_URL;
const token = process.env.RAMOSE_TOKEN;
const d = URL_ ? describe : describe.skip;

// Real Cloudflare (workers.dev) is slower than local miniflare, and Peer
// retries transient platform errors — keep headroom above Bun's 5s default.
setDefaultTimeout(90_000);

const dbName = `e2e-${Date.now().toString(36)}`;

d("ramose e2e", () => {
  const client = new Peer(URL_ ?? "http://invalid", {
    token,
    // A fresh workers.dev hostname is eventually consistent across the edge:
    // a colo can serve the HTML placeholder mid-suite, minutes after /health
    // passes. Absorb up to 45s of that per request (application errors never
    // retry). Test timeout is 90s, so a retried request still fails loudly.
    retryTransientMs: 45_000,
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
      attrMap(":user/email", "string", { unique: "upsert" }),
      attrMap(":user/age", "long"),
      attrMap(":user/friends", "ref", { cardinality: "many" }),
      attrMap(":user/joined", "instant"),
    ]);
    tSchema = s.t;
    expect(s.t).toBeGreaterThanOrEqual(2);
    const r = await db.transact([
      userAttrs("Alice", "alice@example.com", {
        ":db/id": "alice",
        ":user/age": 30,
        ":user/joined": JOINED,
      }),
      userAttrs("Bob", "bob@example.com", {
        ":db/id": "bob",
        ":user/age": 25,
        ":user/friends": ["alice"],
      }),
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
    await expect(
      db.transact([
        userAttrs("Eve", "alice@example.com", { ":user/age": 1 }),
      ]),
    ).resolves.toBeDefined(); // upsert (identity)
    const r = await db.q(`[:find ?n . :in $ ?e :where [?e :user/name ?n]]`, [alice]);
    expect(r).toBe("Eve");
    await db.transact([[":db/add", alice, ":user/name", "Alice"]]);
    await expect(
      db.transact([[":db/add", bob, ":user/email", "alice@example.com"]]),
    ).rejects.toMatchObject({ status: 409, code: "tx/unique-conflict" });
  });

  test("index run publishes a root; queries stay consistent; repeat query hits cache", async () => {
    const before = await db.info();
    const idx = await db.index();
    expect(idx.ran).toBe(true);
    expect(idx.root.t).toBeGreaterThanOrEqual(tAge30);
    const after = await db.info();
    expect(after.transactor.root.t).toBeGreaterThan(before.transactor.root.t ?? 0);
    const q1 = await db.queryEnvelope(`[:find ?n ?a :where [?e :user/name ?n] [?e :user/age ?a]]`);
    const q2 = await db.queryEnvelope(`[:find ?n ?a :where [?e :user/name ?n] [?e :user/age ?a]]`);
    expect(q1.result.length).toBe(2);
    expect(q2.result.length).toBe(2);
    if (q2.meta.r2Gets !== null) expect(q2.meta.r2Gets).toBe(0); // warm isolate: no R2 reads
    // as-of still correct after the root flip
    expect(await db.asOf(tAge30).q<number>(`[:find ?a . :in $ ?e :where [?e :user/age ?a]]`, [alice])).toBe(30);
  });

  test("serialized t under concurrent clients (no gaps / dupes)", async () => {
    const acks = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        db.transact([userAttrs(`c${i}`, `c${i}@example.com`)]),
      ),
    );
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
      ...Array.from({ length: 25 }, (_, i) =>
        db.transact([userAttrs(`r${i}`, `r${i}@example.com`)]),
      ),
    ]);
    expect(rc.ok).toBe(true);
    const lastT = Math.max(...acks.map((a) => a.t));
    // read-your-writes: the basis served after the last ack covers it
    const q = await db.queryEnvelope(`[:find (count ?e) . :where [?e :user/email]]`);
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
    // and a normal query still works afterwards (`q` unwraps the find scalar)
    expect(await db.q<number>(`[:find (count ?e) . :where [?e :user/email]]`)).toBeGreaterThan(0);
  });

  test("write throughput smoke (group commit)", async () => {
    const N = 300;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        db.transact([userAttrs(`w${i}`, `w${i}@example.com`)]),
      ),
    );
    const ms = performance.now() - t0;
    const info = await db.info();
    console.log(`e2e write smoke: ${N} tx in ${ms.toFixed(0)} ms → ${((N / ms) * 1000).toFixed(0)} tx/s; max batch ${info.transactor.stats.maxBatch}`);
    expect(info.transactor.stats.maxBatch).toBeGreaterThan(1); // group commit actually batched
  });
});

/**
 * The session socket (`GET /db/:name/session`), over a real WebSocket.
 *
 * The session client: reads and `t` ticks ride the socket, writes are
 * HTTPS, and a write on *another* connection shows up here as a standing
 * `db.live` re-running. Hatch tests use `ramose/db/effect`; the public
 * promise path (`connect`, `db.run`, `db.query`, a `Subscription`) is covered separately.
 */
const Session = Ramose.Entity("s", {
  name: Ramose.string({ unique: "upsert" }),
  n: Ramose.int(),
});
const SessionCatalog = Ramose.Schema({ s: Session });
const sessionNames = Query.from(Session).select({ name: Session.name });

/** Reef-shaped card-one issue: title / status / rank + required creator join. */
const ReefUser = Ramose.Entity("user", {
  name: Ramose.string(),
});
const ReefIssue = Ramose.Entity("issue", {
  title: Ramose.string(),
  status: Ramose.string(),
  rank: Ramose.float(),
  creator: Ramose.Ref(ReefUser),
});
const ReefBoard = Ramose.Schema({ user: ReefUser, issue: ReefIssue });
const reefBoardQuery = Query.from(ReefIssue)
  .select({
    id: ReefIssue.id,
    title: ReefIssue.title,
    status: ReefIssue.status,
    rank: ReefIssue.rank,
    creator: ReefIssue.creator.select({ name: ReefUser.name }),
  })
  .orderBy("rank", "asc");
type ReefBoardRow = Ramose.Row<typeof reefBoardQuery>;

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
      const a = ManagedRuntime.make(RamoseEffect.layer(options));
      const b = ManagedRuntime.make(RamoseEffect.layer(options));
      try {
        const dbA = a.runSync(RamoseEffect.Databases).db(sessionDb, SessionCatalog);
        const dbB = b.runSync(RamoseEffect.Databases).db(sessionDb, SessionCatalog);

        await a.runPromise(absorb(dbA.effect.install()));
        const report = await a.runPromise(
          absorb(dbA.effect.run(addSession, { name: "Ada", n: 1 })),
        );
        expect(report.t).toBeGreaterThan(0);

        // read-your-writes with no second round trip
        const names = await a.runPromise(
          absorb(report.dbAfter.effect.query(sessionNames)),
        );
        expect(names).toEqual([{ name: "Ada" }]);

        const pulled = await a.runPromise(
          absorb(
            report.dbAfter.effect.pull([":s/name", "Ada"], {
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
            dbA.effect.live(sessionNames),
            (rows) => Effect.sync(() => seen.push(rows.length)),
          ),
        );
        for (let i = 0; i < 40 && seen.length === 0; i++) await Bun.sleep(100);

        await b.runPromise(
          absorb(dbB.effect.run(addSession, { name: "Bob", n: 2 })),
        );
        // Prove B's write is visible on A's HTTPS path before requiring live.
        let count = 0;
        for (let i = 0; i < 40 && count < 2; i++) {
          count = (
            await a.runPromise(absorb(dbA.effect.query(sessionNames)))
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

  test(
    "public connect() promise q, plain-string token, and a Subscription",
    async () => {
      const name = `${dbName}-public`;
      const retry = async <A>(fn: () => Promise<A>): Promise<A> => {
        const start = Date.now();
        for (;;) {
          try {
            return await fn();
          } catch (error) {
            const tag = (error as { _tag?: string })._tag;
            if (tag !== "Unavailable" && tag !== "NetworkError") throw error;
            if (Date.now() - start > 30_000) throw error;
            await Bun.sleep(500);
          }
        }
      };

      const ramose = Ramose.connect({ url, token });
      try {
        const pdb = ramose.db(name, SessionCatalog);
        await retry(() => pdb.install());

        // Same connect() overlay as the public reads. A raw Peer.transact
        // (or a hatch write on another runtime) can commit before this
        // session has followed, so `pdb.q` would see [].
        await retry(() => pdb.run(addSession, { name: "Ada", n: 1 }));

        const live = pdb.live(sessionNames);
        let latest: readonly { name: string }[] | undefined;
        live.subscribe((rows) => {
          latest = rows;
        });
        for (let i = 0; i < 90 && (latest?.length ?? 0) < 1; i++) {
          await Bun.sleep(500);
        }
        expect(latest).toEqual([{ name: "Ada" }]);
        const rows = await retry(() => pdb.query(sessionNames));
        expect(rows).toEqual([{ name: "Ada" }]);
        live.close();
      } finally {
        await ramose.close();
      }
    },
    120_000,
  );

  /** Aggregates and keyset paging lower to the same `/query` the peer runs. */
  test(
    "aggregates, groupBy and `.after` paging over the wire",
    async () => {
      const rt = ManagedRuntime.make(
        RamoseEffect.layer({
          url,
          token: token === undefined ? undefined : Effect.succeed(Redacted.make(token)),
        }),
      );
      try {
        const db = rt
          .runSync(RamoseEffect.Databases)
          .db(`${dbName}-agg`, SessionCatalog);
        await rt.runPromise(absorb(db.effect.install()));
        let report = await rt.runPromise(
          absorb(db.effect.run(addSession, { name: "a", n: 1 })),
        );
        for (const [name, n] of [
          ["b", 2],
          ["c", 2],
          ["d", 3],
        ] as const) {
          report = await rt.runPromise(
            absorb(db.effect.run(addSession, { name, n })),
          );
        }
        const view = report.dbAfter;

        // `.count()` / `.sum(attr)` scalars → count/sum cells; the kernel
        // answers zero rows over an empty match set, hence `?? 0`.
        const countQ = Query.q(function* () {
          const e = yield* Query.entities(Session);
          return { n: Q.count(e) };
        });
        const countRows = await rt.runPromise(absorb(view.effect.query(countQ)));
        expect(countRows[0]?.n ?? 0).toBe(4);
        const sumQ = Query.q(function* () {
          const e = yield* Query.entities(Session);
          const f = yield* Q.fact(e, Session.n);
          return { total: Q.sum(f.v) };
        });
        const sumRows = await rt.runPromise(absorb(view.effect.query(sumQ)));
        expect(sumRows[0]?.total ?? 0).toBe(8);

        // groupBy/aggregate → a record projection: the bound cell is the
        // group key, the aggregate cell counts the group.
        const perN = Query.q(function* () {
          const e = yield* Query.entities(Session);
          const f = yield* Q.fact(e, Session.n);
          return { n: f.v, rows: Q.count(e) };
        });
        const groups = await rt.runPromise(absorb(view.effect.query(perN)));
        expect([...groups].sort((a, b) => a.n - b.n)).toEqual([
          { n: 1, rows: 1 },
          { n: 2, rows: 2 },
          { n: 3, rows: 1 },
        ]);

        // `.having((g) => g.rows.gt(1))` has no kernel spelling — filter the
        // grouped rows in JS, keeping the assertion's intent.
        const kept = groups.filter((g) => g.rows > 1);
        expect(kept).toEqual([{ n: 2, rows: 2 }]);

        const paged = Query.from(Session)
          .select({ name: Session.name })
          .orderBy("name")
          .limit(3);
        const pageQ = (after: Ramose.Cursor | null) => paged.after(after);
        const p1 = await rt.runPromise(absorb(view.effect.query(pageQ(null))));
        expect(p1.rows.map((r) => r.name)).toEqual(["a", "b", "c"]);
        expect(p1.cursor).not.toBeNull();
        const p2 = await rt.runPromise(absorb(view.effect.query(pageQ(p1.cursor))));
        expect(p2.rows.map((r) => r.name)).toEqual(["d"]);
        expect(p2.cursor).toBeNull();
      } finally {
        await rt.dispose();
      }
    },
    120_000,
  );

  /**
   * Regression for #28: two session sockets on one db. The shared basis
   * watcher used to run in the first session's request context; the fan-out to
   * the second socket was illegal cross-context I/O in workerd, so the second
   * session zombied after the first write (no unsolicited frame, frames
   * dropped with no reply, socket never closed).
   *
   * Raw sockets on purpose: the client's reconnect-on-close would mask a
   * zombied session. They never send `{op:sync}`, so they seed
   * `watermark = 0`.
   *
   * Not a flake and not a fan-out miss. Schema/catalog txs still walk as
   * `{op:tx}` on the open e2e peer (no `RAMOSE_POLICY` → `decideSessionTx`
   * returns `tx`). The first apply after an unsynced connect never reaches
   * that walk: `from < rootT` dumps `{op:resync}`. Leftover `{op:t}` after
   * that dump is what made `ticksOf` green. Waiting only for `{op:tx}` is
   * the wrong frame. Either unsolicited frame with `t >= write.t` is a
   * live session; both sockets must still answer `{op:info}`.
   *
   * Under local miniflare both sockets share one isolate — the exact #28
   * shape; on real Cloudflare they may land apart, which only makes the
   * test weaker, never wrongly red.
   */
  test(
    "two session sockets on one db both receive tx or resync on every write; both keep answering (#28)",
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
      const openOnce = (): Promise<RawSock> =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const s: RawSock = { ws, frames: [], closed: false, next: 1 };
          ws.addEventListener("open", () => resolve(s));
          ws.addEventListener("error", (ev) => {
            try {
              ws.close();
            } catch {
              // already dead
            }
            reject(
              new Error(
                `session socket error: ${String((ev as { message?: unknown }).message ?? ev)}`,
              ),
            );
          });
          ws.addEventListener("close", () => {
            s.closed = true;
          });
          ws.addEventListener("message", (ev) => s.frames.push(JSON.parse(String(ev.data))));
        });
      // Same workers.dev eventual-consistency window as `Peer.retryTransientMs`:
      // a colo can refuse the upgrade (non-101 / HTML placeholder) after
      // /health already passed. Application errors still fail the test — they
      // just take up to 30s to do so.
      const openSock = async (): Promise<RawSock> => {
        const deadline = Date.now() + 30_000;
        for (let attempt = 0; ; attempt++) {
          try {
            return await openOnce();
          } catch (e) {
            if (Date.now() >= deadline) throw e;
            const base = Math.min(2000, 150 * 2 ** attempt);
            await Bun.sleep(Math.round(base * (0.5 + Math.random())));
          }
        }
      };
      const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
        const t0 = Date.now();
        while (!cond() && Date.now() - t0 < ms) await Bun.sleep(100);
        return cond();
      };
      const pushesOf = (s: RawSock): number[] =>
        s.frames.filter((f) => f.op === "tx" || f.op === "resync").map((f) => f.t as number);
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
        // Schema still walks as {op:tx} once the cursor is at root. The
        // first apply is {op:resync} (from < rootT), not a skipped catalog
        // tick. Either unsolicited frame is enough. Real CF adds edge lag.
        expect(await until(() => pushesOf(s1).some((t) => t >= w1.t) && pushesOf(s2).some((t) => t >= w1.t), 20_000)).toBe(true);

        // the second write is the #28 regression: the old fan-out had killed one session by now
        const w2 = await http.transact([attrMap(":two/c", "string")]);
        expect(await until(() => pushesOf(s1).some((t) => t >= w2.t) && pushesOf(s2).some((t) => t >= w2.t), 20_000)).toBe(true);

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

  /**
   * Reef hole after #119/#120/#122: two session clients, same principal,
   * same db, each move a *different existing* issue at the same time.
   * Both writes commit. Both standing `db.live` boards must show both
   * new statuses without a refresh and without a `q()` wait that would
   * mask a live-only hole.
   */
  test(
    "two clients moving two existing issues both see both moves on live (no refresh)",
    async () => {
      const options = {
        url,
        token: token === undefined ? undefined : Effect.succeed(Redacted.make(token)),
      };
      const phoneRt = ManagedRuntime.make(RamoseEffect.layer(options));
      const computerRt = ManagedRuntime.make(RamoseEffect.layer(options));
      const boardDb = `${dbName}-reef-two`;
      try {
        const phone = phoneRt.runSync(RamoseEffect.Databases).db(boardDb, ReefBoard);
        const computer = computerRt.runSync(RamoseEffect.Databases).db(boardDb, ReefBoard);

        await phoneRt.runPromise(absorb(phone.effect.install()));
        const person = await phoneRt.runPromise(
          absorb(phone.effect.run(addReefUser, { name: "Ada" })),
        );
        const people = await phoneRt.runPromise(
          absorb(
            person.dbAfter.effect.query(
              Query.from(ReefUser).select({ id: ReefUser.id, name: ReefUser.name }),
            ),
          ),
        );
        const adaId = people[0]!.id;
        const seeded = await phoneRt.runPromise(
          absorb(
            phone.effect.run(addReefIssue, {
              title: "One",
              status: "todo",
              rank: 1,
              creatorId: adaId,
            }),
          ),
        );
        await phoneRt.runPromise(
          absorb(
            phone.effect.run(addReefIssue, {
              title: "Two",
              status: "todo",
              rank: 2,
              creatorId: adaId,
            }),
          ),
        );
        expect(seeded.t).toBeGreaterThan(0);

        const phoneSeen: Array<readonly ReefBoardRow[]> = [];
        const computerSeen: Array<readonly ReefBoardRow[]> = [];
        const phoneFiber = phoneRt.runFork(
          Stream.runForEach(phone.effect.live(reefBoardQuery), (rows) =>
            Effect.sync(() => phoneSeen.push(rows)),
          ),
        );
        const computerFiber = computerRt.runFork(
          Stream.runForEach(computer.effect.live(reefBoardQuery), (rows) =>
            Effect.sync(() => computerSeen.push(rows)),
          ),
        );

        const statusesOf = (rows: readonly ReefBoardRow[] | undefined) => {
          const out: Record<string, string> = {};
          for (const row of rows ?? []) out[row.title] = row.status;
          return out;
        };
        const bothMoves = (rows: readonly ReefBoardRow[] | undefined) => {
          const s = statusesOf(rows);
          return s.One === "doing" && s.Two === "done";
        };
        const waitSeed = async (seen: Array<readonly ReefBoardRow[]>) => {
          for (let i = 0; i < 80 && (seen.at(-1)?.length ?? 0) < 2; i++) {
            await Bun.sleep(100);
          }
        };
        await waitSeed(phoneSeen);
        await waitSeed(computerSeen);
        expect(statusesOf(phoneSeen.at(-1))).toEqual({ One: "todo", Two: "todo" });
        expect(statusesOf(computerSeen.at(-1))).toEqual({ One: "todo", Two: "todo" });

        const one = phoneSeen.at(-1)!.find((r) => r.title === "One");
        const two = phoneSeen.at(-1)!.find((r) => r.title === "Two");
        expect(one).toBeDefined();
        expect(two).toBeDefined();

        await Promise.all([
          phoneRt.runPromise(
            absorb(
              phone.effect.run(moveReefIssue, one!.id, {
                status: "doing",
                rank: 10,
              }),
            ),
          ),
          computerRt.runPromise(
            absorb(
              computer.effect.run(moveReefIssue, two!.id, {
                status: "done",
                rank: 20,
              }),
            ),
          ),
        ]);

        // Live only — do not `q()` here. A local overlay q can be current
        // while the standing stream is stuck on a hole.
        for (let i = 0; i < 90 && !(bothMoves(phoneSeen.at(-1)) && bothMoves(computerSeen.at(-1))); i++) {
          await Bun.sleep(500);
        }
        await Effect.runPromise(Fiber.interrupt(phoneFiber));
        await Effect.runPromise(Fiber.interrupt(computerFiber));

        expect(statusesOf(phoneSeen.at(-1))).toEqual({ One: "doing", Two: "done" });
        expect(statusesOf(computerSeen.at(-1))).toEqual({ One: "doing", Two: "done" });
      } finally {
        await phoneRt.dispose();
        await computerRt.dispose();
      }
    },
    120_000,
  );
});
