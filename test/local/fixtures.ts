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
  readonly seededUrl: string;
  readonly jwksUrl: string;
  readonly jwksBoundUrl: string;
  readonly jwksUrlOnlyUrl: string;
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

export const json = async (
  base: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any; res: Response }> => {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
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
    return { status: res.status, body, res };
  }
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
  rest: "/r2" | "/checkpoint" | "/abort" | "/transact" | "/query",
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
