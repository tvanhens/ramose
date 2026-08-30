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

const isProxyBlip = (status: number, body: unknown): boolean => {
  if (status !== 502) return false;
  if (body === null || typeof body !== "object") return true;
  const err = (body as { error?: { _tag?: string } }).error;
  return err?._tag === "ProxyError" || err === undefined;
};

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

const STREAM_ATTEMPTS = 3;

/**
 * Open a long-lived streaming read (`/replicate`, `/live`) through the dev
 * proxy.
 *
 * `json` cannot serve these: it drains the body to inspect it, and these
 * responses are streams the caller must consume frame by frame. The retry is
 * deliberately narrower than `json`'s, and covers only failures that prove
 * the Worker never answered:
 *
 *   - HTTP 502 — the proxy's own gateway failure. These routes answer 200,
 *     401, 403 or 409, never 502, so a 502 is always the proxy.
 *   - a `fetch` rejection carrying a transport code — nothing was read, so
 *     re-issuing loses no frame. A reset *inside* an open stream surfaces on
 *     the body reader and is never retried here.
 *
 * Bounded at three attempts. Any status the Worker actually produced is
 * returned untouched on the first attempt, so no product answer can be
 * masked. Only read-only openers may use this: re-issuing a request that
 * commits would double-apply it.
 */
export const openStream = async (
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> => {
  let last: unknown;
  for (let attempt = 0; attempt < STREAM_ATTEMPTS; attempt++) {
    if (attempt > 0) await Bun.sleep(50 * attempt);
    init.signal?.throwIfAborted();
    try {
      const response = await fetch(url, init);
      if (response.status !== 502) return response;
      await response.body?.cancel();
      last = new Error(`${label}: dev proxy answered 502`);
    } catch (error) {
      if (!isPreResponseFailure(error)) throw error;
      last = error;
    }
  }
  throw last;
};

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
    const res = await fetch(url, { ...rest, headers });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (attempt < 2 && isProxyBlip(res.status, body)) {
      await Bun.sleep(50 * (attempt + 1));
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
