/**
 * Shared local-stack fixture.
 *
 * One `Test.make({ dev: true })` + one deploy for every `test/local` file
 * that imports this module. Bun evaluates the module once; `beforeAll`
 * is registered on the first importing test file. Keep a single test
 * entry (`integration.test.ts`) so the sidecar outlives every contract.
 */

import "./env.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ramose from "ramose";
import Stack from "./alchemy.run.ts";
import { TEST_CAPABILITY } from "./test-hooks-env.ts";
import { REQUEST_DEADLINE_MS, withRequestDeadline } from "../support/stream.ts";
import { expect } from "bun:test";
import type { EntityIdScope } from "../../packages/ramose/src/internal/replication/entity-id.ts";

export const { deploy, destroy, beforeAll, afterAll } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers()),
  state: Alchemy.inMemoryState(),
  stage: "local",
  dev: true,
});

export type LocalUrls = {
  readonly openUrl: string;
  readonly emptyUrl: string;
  readonly tokenUrl: string;
  readonly policyUrl: string;
  readonly policyClosedUrl: string;
  readonly policySchemaUrl: string;
  readonly nativeOperationsUrl: string;
  readonly mcpBudgetUrl: string;
  readonly graphPathsUrl: string;
  readonly conformanceUrl: string;
  readonly seededUrl: string;
  readonly jwksUrl: string;
  readonly jwksBoundUrl: string;
  readonly jwksUrlOnlyUrl: string;
  readonly authUrl: string;
  readonly authRestartUrl: string;
  readonly authRotatedUrl: string;
  readonly transactorUrl: string;
};

const deployed = beforeAll(deploy(Stack));
afterAll(destroy(Stack));

/** Stack outputs. Call only from a test body (after `beforeAll`). */
export const localUrls = (): LocalUrls => Effect.runSync(deployed) as LocalUrls;

let seq = 0;

/** Unique database name. Valid against `DATABASE_NAME_RE`. */
export const uniqueDb = (prefix: string): string => {
  seq += 1;
  const name = `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
  return name.slice(0, 64);
};

export const post = (body: unknown, token?: string) => ({
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  ...(token === undefined ? {} : { token }),
});

/**
 * A 502 the Alchemy dev proxy produced before the Worker saw the request.
 *
 * The product itself answers 502 in two places
 * (`worker/authorized-operation.ts`, `worker/peer.ts`), always as
 * `{"error": "<string>"}`. Those must never retry, so a 502 only counts as a
 * proxy blip when its body is not an object, carries an explicit `ProxyError`
 * tag, or has no `error` key at all.
 */
const isProxyBlip = (status: number, body: unknown): boolean => {
  if (status !== 502) return false;
  if (body === null || typeof body !== "object") return true;
  const err = (body as { error?: { _tag?: string } }).error;
  return err?._tag === "ProxyError" || err === undefined;
};

/**
 * Retry budget for a dev-proxy blip, shared by every local call site.
 *
 * PR #530 measured this against the same proxy and settled on six bounded
 * exponential attempts (~1.5s total). `json` had kept a much smaller
 * three-attempt, 150ms budget, and a 502 that outlasts 150ms is exactly what
 * failed `replication.ts:494` in nine of fourteen recent conformance runs —
 * that call site already routes through `json` (#545) and still lost. One
 * constant so the two budgets cannot drift apart again.
 */
const PROXY_BLIP_ATTEMPTS = 6;

const proxyBlipBackoffMs = (attempt: number): number => 50 * 2 ** attempt;

/**
 * Codes Bun attaches when the Alchemy dev proxy drops a connection before it
 * produces a response. `fetch` only rejects while it is still establishing
 * the exchange — a reset *during* a streamed body rejects the body reader
 * instead — so a rejection here proves no response was produced and no bytes
 * were consumed.
 */
const PRE_RESPONSE_CODES: ReadonlySet<string> = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "ECONNRESET",
  "ConnectionClosed",
]);

const isPreResponseFailure = (error: unknown): boolean => {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && PRE_RESPONSE_CODES.has(code);
};

/**
 * Issue a request whose response `json` must not drain: a long-lived stream
 * (`/replicate`, `/live`) the caller consumes frame by frame, or a probe a
 * recording transport has to observe directly.
 *
 * Retries only failures that prove the Worker never answered:
 *
 *   - HTTP 502 — these routes answer 200, 401, 403, 404 or 409 and never
 *     502, so unlike the routes `json` covers there is no product 502 to
 *     confuse with the proxy's own.
 *   - a `fetch` rejection carrying a transport code — `fetch` only rejects
 *     while still establishing the exchange, so nothing was read and no
 *     frame was lost. A reset *inside* an open stream surfaces on the body
 *     reader and is never retried here.
 *
 * Any status the Worker actually produced is returned untouched on the first
 * attempt, so no product answer can be masked. Only safe, read-only requests
 * may use this: re-issuing one that commits would double-apply it.
 *
 * The open itself is bounded by `REQUEST_DEADLINE_MS`. Only the headers are
 * covered: the deadline is cleared the moment the `Response` arrives, so the
 * caller keeps a stream it can hold open for as long as it likes.
 */
export const fetchPastProxyBlip = async (
  url: string,
  init: RequestInit,
  label: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> => {
  let last: unknown;
  for (let attempt = 0; attempt < PROXY_BLIP_ATTEMPTS; attempt++) {
    if (attempt > 0) await Bun.sleep(proxyBlipBackoffMs(attempt - 1));
    init.signal?.throwIfAborted();
    try {
      // A caller that brought its own signal keeps it and owns the bound.
      const response = init.signal === undefined
        ? await withRequestDeadline(
          (signal) => fetcher(url, { ...init, signal }),
          label,
        )
        : await fetcher(url, init);
      if (response.status !== 502) return response;
      await response.body?.cancel().catch(() => undefined);
      last = new Error(`${label}: dev proxy answered 502`);
    } catch (error) {
      if (!isPreResponseFailure(error)) throw error;
      last = error;
    }
  }
  throw last;
};

/* ── #551: the local runtime's unadvertised keep-alive bound ─────────────── */

/**
 * Last completed exchange per origin, so a call site can report how long the
 * connection it is about to reuse has been idle.
 *
 * This is the measurement that explained #551. The local stack is served by a
 * workerd proxy process that FINs an idle HTTP/1.1 keep-alive socket at a hard
 * 5000ms and sends no `Keep-Alive: timeout=` (nor even `Connection:`) header,
 * so a pooling client has no way to learn the bound. The two `/op` posts #551
 * names are issued 5003ms and 5006ms after the previous request to the same
 * origin — they wait on a replication frame that arrives on a *different*
 * socket about five seconds later — which puts them 1–6ms past a close the
 * client cannot anticipate.
 */
const lastExchangeAt = new Map<string, number>();

const originIdleMs = (origin: string, now: number): number | undefined => {
  const previous = lastExchangeAt.get(origin);
  return previous === undefined ? undefined : now - previous;
};

const noteOriginActivity = (origin: string): void => {
  lastExchangeAt.set(origin, Date.now());
};

/** `RAMOSE_TRACE_IDLE=1` prints the idle age of every reused connection. */
const traceIdle = (
  label: string,
  idleBeforeMs: number | undefined,
  tookMs: number,
  outcome: string,
): void => {
  if (process.env.RAMOSE_TRACE_IDLE !== "1") return;
  console.log(
    `IDLE ${label} idleBefore=${idleBeforeMs ?? "-"}ms took=${tookMs}ms -> ${outcome}`,
  );
};

/**
 * Attempts for a request that died before the Worker answered.
 *
 * Bun's `fetch` rejects only while it is still establishing the exchange, so
 * such a rejection proves the Worker produced no response. Combined with the
 * durable invocation receipt every `/op` carries — an identical `invocationId`
 * replays rather than re-executes — re-issuing the byte-identical request is
 * at-most-once. Off by default: a caller opts in only where both halves of
 * that argument hold.
 */
const PRE_RESPONSE_ATTEMPTS = 3;

/**
 * Per-attempt bound for those call sites.
 *
 * A request written into the closing socket has two endings, both measured
 * against the local runtime: it is reset, or it is *silently discarded* — the
 * server neither dispatches nor answers it, and the caller waits for its own
 * deadline. Only the first raises a transport code, so the bound is what
 * catches the second. Three attempts stay under `REQUEST_DEADLINE_MS`, and an
 * `/op` on this stack answers in single-digit ms, so this is never a race
 * against real work.
 */
const PRE_RESPONSE_ATTEMPT_DEADLINE_MS = 10_000;

export const json = async (
  base: string,
  path: string,
  init: RequestInit & {
    token?: string;
    /**
     * Re-issue this request if the connection died before any response
     * (#551). Only for requests whose replay is provably at-most-once.
     */
    retryPreResponse?: boolean;
  } = {},
): Promise<{ status: number; body: any; text: string; res: Response }> => {
  const { token, retryPreResponse = false, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  if (path.startsWith("/__test__/")) {
    headers.set("x-ramose-test-capability", TEST_CAPABILITY);
  }
  const url = `${base.replace(/\/+$/, "")}${path}`;
  const label = `${rest.method ?? "GET"} ${path}`;
  const exchange = async (
    signal: AbortSignal | undefined,
    fresh: boolean,
  ): Promise<{ res: Response; text: string }> => {
    const attemptHeaders = fresh ? new Headers(headers) : headers;
    // Evicts the dead pooled socket so the next dial is a fresh one.
    if (fresh) attemptHeaders.set("connection", "close");
    const res = await fetch(url, {
      ...rest,
      headers: attemptHeaders,
      ...(signal === undefined ? {} : { signal }),
    });
    // Inside the same bound: the deadline keeps running after the headers
    // arrive, so a body that stalls fails here rather than hanging, and
    // reports the same way as a request that never answered at all.
    return { res, text: await res.text() };
  };
  // Losing the keep-alive race is what does not reproduce locally, so the
  // retry arm is otherwise unexercised. `RAMOSE_FORCE_FRESH=1` sends every
  // opted-in request the way a retry sends it; the suite passes under it.
  let fresh = process.env.RAMOSE_FORCE_FRESH === "1" && retryPreResponse;
  for (let attempt = 0; ; attempt++) {
    const origin = new URL(url).origin;
    const startedAt = Date.now();
    const idleBefore = originIdleMs(origin, startedAt);
    let res: Response;
    let text: string;
    try {
      // Callers never pass their own signal today; honour one if they start to.
      const exchanged = rest.signal === undefined
        ? await withRequestDeadline(
          (signal) => exchange(signal, fresh),
          label,
          retryPreResponse
            ? PRE_RESPONSE_ATTEMPT_DEADLINE_MS
            : REQUEST_DEADLINE_MS,
        )
        : await exchange(undefined, fresh);
      res = exchanged.res;
      text = exchanged.text;
    } catch (error) {
      noteOriginActivity(origin);
      const elapsed = Date.now() - startedAt;
      // Either ending of a request written into the closing socket: a
      // transport code, or nothing at all until this attempt's bound.
      const lostBeforeTheWorker = isPreResponseFailure(error) ||
        elapsed >= PRE_RESPONSE_ATTEMPT_DEADLINE_MS;
      if (
        !retryPreResponse ||
        attempt >= PRE_RESPONSE_ATTEMPTS - 1 ||
        !lostBeforeTheWorker
      ) {
        throw error;
      }
      traceIdle(
        label,
        idleBefore,
        elapsed,
        isPreResponseFailure(error) ? "reset" : "dropped",
      );
      // Dial a fresh socket rather than whatever the pool hands back.
      fresh = true;
      await Bun.sleep(proxyBlipBackoffMs(attempt));
      continue;
    }
    noteOriginActivity(origin);
    traceIdle(label, idleBefore, Date.now() - startedAt, String(res.status));
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (
      attempt < PROXY_BLIP_ATTEMPTS - 1 && isProxyBlip(res.status, body)
    ) {
      await Bun.sleep(proxyBlipBackoffMs(attempt));
      continue;
    }
    return { status: res.status, body, text, res };
  }
};

/** Read the exact runtime-bound proof through source-only test instrumentation. */
export const catalogProof = async (
  base: string,
  database: string,
): Promise<{ readonly catalog: string; readonly unitHash: string }> => {
  const response = await json(
    base,
    `/__test__/db/${encodeURIComponent(database)}/catalog-proof`,
  );
  if (
    response.status !== 200 ||
    typeof response.body?.catalog !== "string" ||
    !/^[0-9a-f]{64}$/.test(response.body?.unitHash)
  ) {
    throw new Error(
      `catalog proof ${database} failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  return response.body as { readonly catalog: string; readonly unitHash: string };
};

export const attr = (
  ident: string,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ":db/ident": ident,
  ":db/valueType": `:db.type/${type}`,
  ":db/cardinality": extra[":db/cardinality"] ?? ":db.cardinality/one",
  ...(extra[":db/cardinality"] === ":db.cardinality/many"
    ? {}
    : { ":db/optional": true }),
  ...extra,
});

export const AUTH_SCHEMA = [
  attr(":user/sub", "string", { ":db/unique": ":db.unique/identity" }),
  attr(":org/members", "ref", { ":db/cardinality": ":db.cardinality/many" }),
  attr(":project/org", "ref"),
  attr(":doc/title", "string"),
  attr(":doc/owner", "ref"),
  attr(":doc/project", "ref"),
  attr(":doc/audit", "string"),
];

/** POST a test-only admin path (`/__test__/db/:name/...`). */
export const testAdmin = async (
  base: string,
  db: string,
  rest:
    | "/r2"
    | "/storage"
    | "/basis"
    | "/checkpoint"
    | "/abort"
    | "/reconnect"
    | "/transact"
    | "/query"
    | "/sessions"
    | "/index"
    | "/info"
    | "/operation-receipts"
    | "/server-identity"
    | "/replication-revision"
    | "/log",
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; res: Response }> => {
  const init = post(body);
  return json(base, `/__test__/db/${encodeURIComponent(db)}${rest}`, {
    ...init,
    headers:
      headers === undefined ? init.headers : { ...init.headers, ...headers },
  });
};

export const seedTx = async (
  base: string,
  db: string,
  tx: unknown[],
  token?: string,
): Promise<{ t: number; tempids: Record<string, number> }> => {
  const { status, body } = await json(
    base,
    `/db/${encodeURIComponent(db)}/transact`,
    post({ tx }, token),
  );
  if (status !== 200) {
    throw new Error(
      `seed ${db} failed (${status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
};

/* ── opaque entity handles at the operation boundary (#475) ──────────────── */

/**
 * The `{ server, principal, database }` scope this bearer's invocations seal
 * under, derived by the Worker's own code from the really verified caller.
 *
 * Cached per bearer and database because it is a pure PRF of three stable
 * inputs, and because deriving it is the one thing a test needs in order to
 * read an opaque handle the same way the authoritative resolver does.
 */
const invocationScopes = new Map<string, Promise<EntityIdScope>>();

const invocationScope = (
  base: string,
  database: string,
  token: string,
): Promise<EntityIdScope> => {
  const key = `${base} ${database} ${token}`;
  const cached = invocationScopes.get(key);
  if (cached !== undefined) return cached;
  const derived = (async () => {
    const response = await testAdmin(base, database, "/server-identity", {
      action: "invocation-entity-id-scope",
      bearer: token,
    });
    expect(response.status).toBe(200);
    return response.body.scope as EntityIdScope;
  })();
  invocationScopes.set(key, derived);
  return derived;
};

/**
 * Open one public entity handle, through the real sealed-EntityId resolver.
 *
 * The handle is what an operation result carries now: #475 seals every
 * entity-reference position of client-visible output, so no numeric eid crosses
 * the operation boundary. These noninterference cases still need the private
 * eid to drive admin reads, and this is the only way to obtain one — which is
 * itself the assertion: a wrong scope, a tampered handle, or an unsealed number
 * simply fails to resolve.
 */
export const openEntityHandle = async (
  base: string,
  database: string,
  token: string,
  handle: string,
): Promise<number> => {
  const response = await testAdmin(base, database, "/server-identity", {
    action: "open-entity-id",
    scope: await invocationScope(base, database, token),
    token: handle,
  });
  expect(response.status).toBe(200);
  expect(response.body.resolution.type).toBe("resolved");
  return response.body.resolution.eid as number;
};

/**
 * The exact public handle this caller's output carries for one entity, minted
 * by the same codec under the same derived scope. Sealing is deterministic in
 * `(root, scope, eid)`, so this is the byte-for-byte value a result must hold.
 */
export const entityHandle = async (
  base: string,
  database: string,
  token: string,
  eid: number,
): Promise<string> => {
  const response = await testAdmin(base, database, "/server-identity", {
    action: "seal-entity-id",
    scope: await invocationScope(base, database, token),
    eid,
  });
  expect(response.status).toBe(200);
  return response.body.token as string;
};
