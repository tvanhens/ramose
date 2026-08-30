/**
 * Opt-in transport forensics for #551 — a diagnostic harness, not a lane.
 *
 * #551 is a `POST /db/graph-path-root/op`, issued one statement after a
 * replication stream parks in `resumed.next()`, that never reaches the Worker:
 * zero Worker-side log lines, a `fetch` rejection carrying `ECONNRESET`, and
 * (before #565 bounded it) an 85s park that burned Bun's whole test budget.
 * It has never reproduced locally; every occurrence is a GitHub Actions runner.
 *
 * These cases measure the transport underneath that request rather than the
 * request itself, at three layers, so an occurrence can be attributed:
 *
 *   1. how long the local stack holds an idle HTTP/1.1 keep-alive socket, and
 *      whether it advertises that bound to the client at all;
 *   2. whether a pooled `fetch` reuse aimed at that boundary rejects or parks;
 *   3. the same load with pooling disabled (`Connection: close`), which is the
 *      control: a failure that survives it is not a reuse race.
 *
 * Everything here runs against the real Alchemy/workerd stack the rest of
 * `test/local` uses — real sockets, real Worker, no substitutes. It is
 * deliberately slow (idle boundaries are measured in seconds), which is why it
 * is registered from its own entry (`stress.test.ts`, `bun run test:stress`)
 * and is not part of `test:conformance`.
 */

import { describe, expect, test } from "bun:test";
import type { LocalUrls } from "./fixtures.ts";

/** Attempts per idle offset in the reuse sweep. */
const ROUNDS = Number(process.env.RAMOSE_STRESS_ROUNDS ?? "8");

/** Concurrent lanes, i.e. how many pooled sockets are aged in parallel. */
const LANES = Number(process.env.RAMOSE_STRESS_LANES ?? "12");

/** Idle-close probes to average. */
const IDLE_PROBES = Number(process.env.RAMOSE_STRESS_IDLE_PROBES ?? "3");

/** Ceiling on one idle-close probe. Nothing local should exceed this. */
const IDLE_PROBE_CEILING_MS = 60_000;

/**
 * Offsets, in ms, of the reused request relative to the measured idle-close.
 *
 * Negative lands before the close, zero on it, positive after. The real call
 * site lands here by accident: the replication change it waits for arrives on
 * a different socket about five seconds after the previous request, so the
 * pooled socket that served that request has been idle for almost exactly the
 * close bound when the next `/op` reuses it.
 */
const OFFSETS_MS = [-60, -20, -8, -3, -1, 0, 1, 3, 8, 20] as const;

type SocketOutcome = {
  /** ms from the response to the server closing the idle socket, if it did. */
  readonly closedAfterMs: number | null;
  readonly how: string;
  readonly responseHead: string;
};

const endpoint = (raw: string) => {
  const url = new URL(raw);
  return {
    hostname: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    host: url.host,
  };
};

/**
 * Hold one raw HTTP/1.1 keep-alive socket open and report when the server
 * closes it. Raw rather than `fetch` because the question is what the server
 * does to an idle connection, which a pooling client hides.
 */
const probeIdleClose = async (
  base: string,
  ceilingMs: number,
): Promise<SocketOutcome> => {
  const { hostname, port, host } = endpoint(base);
  let respondedAt = 0;
  let closedAt: number | null = null;
  let how = "still-open";
  let head = "";
  const socket = await Bun.connect({
    hostname,
    port,
    socket: {
      data(_socket, chunk) {
        if (respondedAt === 0) respondedAt = Date.now();
        if (head.length < 512) head += new TextDecoder().decode(chunk);
      },
      end() {
        if (closedAt === null) {
          closedAt = Date.now();
          how = "server-fin";
        }
      },
      close() {
        if (closedAt === null) {
          closedAt = Date.now();
          how = "closed";
        }
      },
      error(_socket, error) {
        if (closedAt === null) {
          closedAt = Date.now();
          how = `error:${(error as { code?: string }).code ?? error.message}`;
        }
      },
    },
  });
  socket.write(
    `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n\r\n`,
  );
  const deadline = Date.now() + ceilingMs;
  while (closedAt === null && Date.now() < deadline) await Bun.sleep(20);
  try {
    socket.end();
  } catch {
    // The server already closed it; nothing to release.
  }
  return {
    closedAfterMs: closedAt === null || respondedAt === 0
      ? null
      : closedAt - respondedAt,
    how,
    responseHead: head.split("\r\n\r\n")[0] ?? "",
  };
};

type Attempt = {
  readonly offsetMs: number;
  readonly outcome: "ok" | "rejected" | "parked";
  readonly detail: string;
  readonly ms: number;
};

/**
 * Burn CPU synchronously, the way a two-vCPU runner does when several suites,
 * the Alchemy sidecar and a dozen workerd processes share it. A reuse race is
 * only observable while the client has not yet processed the server's close.
 */
const stall = (ms: number): void => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Intentionally blocking.
  }
};

/**
 * One lane: warm a pooled socket, let it age to `idleMs`, then reuse it.
 *
 * `keepAlive: false` sends `Connection: close`, which keeps the socket out of
 * Bun's pool — the control arm. Bounded so a park is reported as a park
 * instead of hanging the suite.
 */
const reuseAttempt = async (
  base: string,
  idleMs: number,
  offsetMs: number,
  keepAlive: boolean,
  boundMs: number,
): Promise<Attempt> => {
  const headers = keepAlive ? undefined : { connection: "close" };
  const warm = await fetch(`${base}/health`, { ...(headers && { headers }) });
  await warm.text();
  const wait = Math.max(0, idleMs + offsetMs);
  // Leave the last few ms to a blocking stall so the close, if it is coming,
  // lands while the loop cannot service it.
  await Bun.sleep(Math.max(0, wait - 12));
  stall(Math.min(12, wait));
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundMs);
  try {
    const res = await fetch(`${base}/health`, {
      signal: controller.signal,
      ...(headers && { headers }),
    });
    await res.text();
    return {
      offsetMs,
      outcome: "ok",
      detail: String(res.status),
      ms: Date.now() - started,
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const aborted = (error as { name?: string }).name === "AbortError";
    return {
      offsetMs,
      outcome: aborted ? "parked" : "rejected",
      detail: aborted ? `no answer in ${boundMs}ms` : code ?? String(error),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
};

const summarise = (attempts: readonly Attempt[]): string => {
  const byOffset = new Map<number, { ok: number; rejected: number; parked: number; detail: Set<string> }>();
  for (const attempt of attempts) {
    const row = byOffset.get(attempt.offsetMs) ??
      { ok: 0, rejected: 0, parked: 0, detail: new Set<string>() };
    row[attempt.outcome] += 1;
    if (attempt.outcome !== "ok") row.detail.add(attempt.detail);
    byOffset.set(attempt.offsetMs, row);
  }
  return [...byOffset.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([offset, row]) =>
      `  offset ${String(offset).padStart(4)}ms  ok=${row.ok} rejected=${row.rejected} parked=${row.parked}` +
      (row.detail.size === 0 ? "" : `  [${[...row.detail].join(", ")}]`)
    )
    .join("\n");
};

export const registerTransportForensics = (ctx: {
  readonly urls: () => LocalUrls;
}): void => {
  describe("#551 transport forensics", () => {
    let idleCloseMs: number | undefined;

    test("the local stack's idle keep-alive bound, and whether it is advertised", async () => {
      const base = ctx.urls().graphPathsUrl;
      const probes: SocketOutcome[] = [];
      for (let i = 0; i < IDLE_PROBES; i++) {
        probes.push(await probeIdleClose(base, IDLE_PROBE_CEILING_MS));
      }
      const closes = probes
        .map((probe) => probe.closedAfterMs)
        .filter((ms): ms is number => ms !== null);
      idleCloseMs = closes.length === 0
        ? undefined
        : Math.round(closes.reduce((a, b) => a + b, 0) / closes.length);
      const advertises = probes.some((probe) =>
        /keep-alive:\s*timeout=/i.test(probe.responseHead)
      );
      console.log(
        [
          "#551 idle-close probe",
          `  closes: ${closes.length}/${probes.length} at ${JSON.stringify(closes)}ms`,
          `  how: ${JSON.stringify(probes.map((probe) => probe.how))}`,
          `  advertises Keep-Alive: timeout=: ${advertises}`,
          `  response head: ${JSON.stringify(probes[0]?.responseHead ?? "")}`,
        ].join("\n"),
      );
      // The measurement is the point; a server that never closes is also a
      // result, and is reported rather than failed.
      expect(probes.length).toBe(IDLE_PROBES);
    }, 300_000);

    /**
     * The same race one layer down, without a pooling client in the way.
     *
     * Writes a second request onto a raw socket at the idle bound while the
     * event loop is blocked, so the server's close cannot have been observed
     * first — which is exactly the state a pooled `fetch` reuse is in when it
     * loses. Reports what the server does with a request that arrives on a
     * connection it has already closed: answer it, drop it silently, or reset.
     */
    test("raw write into the idle bound", async () => {
      const base = ctx.urls().graphPathsUrl;
      if (idleCloseMs === undefined) {
        console.log("#551 raw write skipped: no idle close was observed");
        return;
      }
      const { hostname, port, host } = endpoint(base);
      const outcomes: string[] = [];
      for (const offset of [-40, -10, -2, 0, 2, 10]) {
        let responses = 0;
        let terminal = "";
        const socket = await Bun.connect({
          hostname,
          port,
          socket: {
            data() {
              responses += 1;
            },
            end() {
              if (terminal === "") terminal = "server-fin";
            },
            error(_socket, error) {
              terminal = `error:${(error as { code?: string }).code ?? error.message}`;
            },
          },
        });
        const request =
          `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n\r\n`;
        socket.write(request);
        await Bun.sleep(Math.max(0, idleCloseMs + offset - 25));
        stall(25);
        try {
          socket.write(request);
        } catch (error) {
          terminal = `write:${(error as { code?: string }).code ?? String(error)}`;
        }
        await Bun.sleep(1_500);
        outcomes.push(
          `  offset ${String(offset).padStart(4)}ms  responses=${responses} terminal=${terminal || "none"}`,
        );
        try {
          socket.end();
        } catch {
          // Already gone.
        }
      }
      console.log(
        `#551 raw write at the idle bound (${idleCloseMs}ms)\n${outcomes.join("\n")}`,
      );
      expect(outcomes.length).toBe(6);
    }, 600_000);

    test("pooled reuse aimed at that bound", async () => {
      const base = ctx.urls().graphPathsUrl;
      if (idleCloseMs === undefined) {
        console.log("#551 reuse sweep skipped: no idle close was observed");
        return;
      }
      const attempts: Attempt[] = [];
      for (const offset of OFFSETS_MS) {
        for (let round = 0; round < ROUNDS; round++) {
          const lane = Array.from(
            { length: LANES },
            () => reuseAttempt(base, idleCloseMs!, offset, true, 20_000),
          );
          attempts.push(...await Promise.all(lane));
        }
      }
      const bad = attempts.filter((attempt) => attempt.outcome !== "ok");
      console.log(
        [
          `#551 pooled reuse sweep (idle bound ${idleCloseMs}ms, ${attempts.length} attempts)`,
          summarise(attempts),
          `  total non-ok: ${bad.length}`,
        ].join("\n"),
      );
      expect(attempts.length).toBe(OFFSETS_MS.length * ROUNDS * LANES);
    }, 3_600_000);

    test("control: the same load with pooling disabled", async () => {
      const base = ctx.urls().graphPathsUrl;
      if (idleCloseMs === undefined) {
        console.log("#551 control skipped: no idle close was observed");
        return;
      }
      const attempts: Attempt[] = [];
      for (const offset of [-3, 0, 3]) {
        for (let round = 0; round < ROUNDS; round++) {
          const lane = Array.from(
            { length: LANES },
            () => reuseAttempt(base, idleCloseMs!, offset, false, 20_000),
          );
          attempts.push(...await Promise.all(lane));
        }
      }
      const bad = attempts.filter((attempt) => attempt.outcome !== "ok");
      console.log(
        [
          `#551 no-pooling control (${attempts.length} attempts)`,
          summarise(attempts),
          `  total non-ok: ${bad.length}`,
        ].join("\n"),
      );
      expect(attempts.length).toBe(3 * ROUNDS * LANES);
    }, 3_600_000);
  });
};
