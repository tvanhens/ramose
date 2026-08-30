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
      const response = await fetcher(url, init);
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

/**
 * Ceiling on one `json` request/response exchange.
 *
 * Nothing `json` carries is a long poll — the whole suite finishes in under a
 * minute — so anything still outstanding at this point is wedged. Without a
 * ceiling a wedged request silently consumed the caller's entire 90s default
 * test budget and reported only "timed out after 90000ms": that is how a
 * hung `/op` on a parked replication stream (see the PR body) presented, with
 * the request's own identity lost. This is a deadline, never a retry: the
 * request is abandoned and the failure names the path that hung.
 */
const REQUEST_DEADLINE_MS = 45_000;

export const json = async (
  base: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any; text: string; res: Response }> => {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  if (path.startsWith("/__test__/")) {
    headers.set("x-ramose-test-capability", TEST_CAPABILITY);
  }
  const url = `${base.replace(/\/+$/, "")}${path}`;
  for (let attempt = 0; ; attempt++) {
    // Callers never pass their own signal today; honour one if they start to.
    const deadline = rest.signal === undefined
      ? AbortSignal.timeout(REQUEST_DEADLINE_MS)
      : undefined;
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        ...rest,
        headers,
        ...(deadline === undefined ? {} : { signal: deadline }),
      });
      // Inside the same guard: the signal keeps running after the headers
      // arrive, so a body that stalls aborts here rather than hanging, and
      // reports the same way as a request that never answered at all.
      text = await res.text();
    } catch (error) {
      if (deadline?.aborted === true) {
        throw new Error(
          `${rest.method ?? "GET"} ${path} did not answer within ${REQUEST_DEADLINE_MS}ms`,
        );
      }
      throw error;
    }
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
