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

export const localUrls = (): LocalUrls => Effect.runSync(deployed) as LocalUrls;

let seq = 0;

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

const PROXY_BLIP_ATTEMPTS = 6;

const proxyBlipBackoffMs = (attempt: number): number => 50 * 2 ** attempt;

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

const lastExchangeAt = new Map<string, number>();

const originIdleMs = (origin: string, now: number): number | undefined => {
  const previous = lastExchangeAt.get(origin);
  return previous === undefined ? undefined : now - previous;
};

const noteOriginActivity = (origin: string): void => {
  lastExchangeAt.set(origin, Date.now());
};

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

const PRE_RESPONSE_ATTEMPTS = 3;

const PRE_RESPONSE_ATTEMPT_DEADLINE_MS = 10_000;

export const json = async (
  base: string,
  path: string,
  init: RequestInit & {
    token?: string;

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

    if (fresh) attemptHeaders.set("connection", "close");
    const res = await fetch(url, {
      ...rest,
      headers: attemptHeaders,
      ...(signal === undefined ? {} : { signal }),
    });

    return { res, text: await res.text() };
  };

  let fresh = process.env.RAMOSE_FORCE_FRESH === "1" && retryPreResponse;
  for (let attempt = 0; ; attempt++) {
    const origin = new URL(url).origin;
    const startedAt = Date.now();
    const idleBefore = originIdleMs(origin, startedAt);
    let res: Response;
    let text: string;
    try {

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
