/**
 * The peer's handshake, selected by `RAMOSE_POLICY`:
 *
 *   unset  legacy — open, or a shared `RAMOSE_TOKEN` if one is set; class `admin`
 *   set    JWT only; `RAMOSE_TOKEN` is not a data-plane principal on `/db/:name`
 *
 * A configured policy makes verification mandatory: a missing JWKS / issuer /
 * audience denies every `/db/*` and logs once, never falls open. Keys come from
 * `RAMOSE_JWKS_URL`, or `RAMOSE_JWKS_JSON` for offline runs.
 */

import {
  type CompiledPolicy,
  type Db,
  type NodeSource,
  type Principal,
  type TxData,
  allows,
  anonymousPrincipal,
  checkTx,
  componentLogger,
  filterDb,
  isAdmin,
} from "../internal/core/index.ts";
import { type Basis, dbFromBasis } from "../internal/replica/basis.ts";
import { type RamoseEnv, envInt, policyOf } from "../internal/transactor/index.ts";
import { type JWTPayload, type JWTVerifyGetKey, createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import { Unauthorized } from "./errors.ts";

/** Verifier algorithms, explicit — never whatever the token's header asks for. */
const ALGS = ["RS256", "ES256", "EdDSA"];
/** Cap on `exp - iat` when `RAMOSE_JWT_MAX_TTL` is unset, in seconds. */
export const DEFAULT_JWT_MAX_TTL = 900;
/** Per-isolate memo lifetime for a verified principal. */
export const PRINCIPAL_MEMO_MS = 60_000;
/** The class a policy must declare for tokenless callers to get in. */
export const ANONYMOUS_CLASS = "anonymous";
/**
 * The `RAMOSE_TOKEN` holder under a policy. Undeclarable as a policy class, so
 * every rule denies it; the routes let it reach `ensure`'s no-op case only.
 */
export const TOKEN_ONLY_CLASS = "$token";

const log = componentLogger("peer");

export interface AuthState {
  /** `RAMOSE_POLICY` is set */
  readonly configured: boolean;
  readonly policy?: CompiledPolicy;
  /** set = deny every `/db/*` (malformed policy, or an incomplete verifier) */
  readonly broken?: string;
  readonly issuers?: readonly string[];
  readonly aud?: string;
  readonly maxTtl: number;
  readonly keys?: JWTVerifyGetKey;
}

type AuthEnv = Pick<
  RamoseEnv,
  "RAMOSE_POLICY" | "RAMOSE_TOKEN" | "RAMOSE_JWKS_URL" | "RAMOSE_JWKS_JSON" | "RAMOSE_JWT_ISS" | "RAMOSE_JWT_AUD" | "RAMOSE_JWT_MAX_TTL" | "RAMOSE_ALLOWED_ORIGINS"
>;

const states = new Map<string, AuthState>();
const complained = new Set<string>();

const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

function keySetOf(env: AuthEnv): JWTVerifyGetKey {
  if (env.RAMOSE_JWKS_URL) return createRemoteJWKSet(new URL(env.RAMOSE_JWKS_URL));
  return createLocalJWKSet(JSON.parse(env.RAMOSE_JWKS_JSON as string));
}

function build(env: AuthEnv): AuthState {
  const parsed = policyOf(env);
  const maxTtl = envInt(env.RAMOSE_JWT_MAX_TTL, DEFAULT_JWT_MAX_TTL);
  if (!parsed.configured) return { configured: false, maxTtl };
  const issuers = csv(env.RAMOSE_JWT_ISS);
  const missing: string[] = [];
  if (parsed.error !== undefined) missing.push(`RAMOSE_POLICY is malformed (${parsed.error})`);
  if (!env.RAMOSE_JWKS_URL && !env.RAMOSE_JWKS_JSON) missing.push("RAMOSE_JWKS_URL is not set");
  if (issuers.length === 0) missing.push("RAMOSE_JWT_ISS is not set");
  if (!env.RAMOSE_JWT_AUD) missing.push("RAMOSE_JWT_AUD is not set");
  let keys: JWTVerifyGetKey | undefined;
  if (missing.length === 0) {
    try {
      keys = keySetOf(env);
    } catch (err) {
      missing.push(`the JWKS is unusable (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (missing.length > 0) return { configured: true, policy: parsed.policy, broken: missing.join("; "), maxTtl };
  return { configured: true, policy: parsed.policy, issuers, aud: env.RAMOSE_JWT_AUD, maxTtl, keys };
}

/** The peer's auth configuration, resolved once per isolate. */
export function authState(env: AuthEnv): AuthState {
  const key = [env.RAMOSE_POLICY, env.RAMOSE_JWKS_URL, env.RAMOSE_JWKS_JSON, env.RAMOSE_JWT_ISS, env.RAMOSE_JWT_AUD, env.RAMOSE_JWT_MAX_TTL].join("|");
  const hit = states.get(key);
  if (hit) return hit;
  const state = build(env);
  if (state.broken !== undefined && !complained.has(key)) {
    complained.add(key);
    log.error("auth.fail-closed", { reason: state.broken });
  }
  if (states.size > 8) states.clear();
  states.set(key, state);
  return state;
}

/** Test hook: forget the resolved config and every memoized principal. */
export function clearAuthCache(): void {
  states.clear();
  complained.clear();
  principals.clear();
  eids.clear();
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

const serviceAdmin = (db: string): Principal => ({ kind: "service", class: "admin", claims: {}, db });
const tokenOnly = (db: string): Principal => ({ kind: "service", class: TOKEN_ONLY_CLASS, claims: {}, db });

/** The `RAMOSE_TOKEN` holder under a policy: no class, no data plane. */
export const isTokenOnly = (p: Principal): boolean => p.class === TOKEN_ONLY_CLASS;

/** Past `exp`? Checked on every use of a memoized principal and on every session frame. */
export function isExpired(p: Principal, now = Date.now()): boolean {
  return p.claims.exp !== undefined && p.claims.exp * 1000 <= now;
}

/** `Authorization: Bearer …`, else `?token=` (a browser cannot set headers on an upgrade). */
export function bearerOf(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) {
    const t = header.slice(7).trim();
    if (t.length > 0) return t;
  }
  try {
    const t = new URL(request.url).searchParams.get("token");
    if (t !== null && t.length > 0) return t;
  } catch {
    // a relative sub-request url: header only
  }
  return undefined;
}

const principals = new Map<string, { principal: Principal; at: number }>();

/** The verified caller for `dbName`. Throws `Unauthorized`; never falls open. */
export function principalOf(env: RamoseEnv, request: Request, dbName: string): Promise<Principal> {
  return principalForToken(env, bearerOf(request), dbName);
}

/** Same, for a token off the wire (the session's `auth` frame). */
export async function principalForToken(env: RamoseEnv, token: string | undefined, dbName: string): Promise<Principal> {
  const st = authState(env);
  if (!st.configured) {
    if (!env.RAMOSE_TOKEN || token === env.RAMOSE_TOKEN) return serviceAdmin(dbName);
    throw new Unauthorized({});
  }
  if (st.broken !== undefined || st.policy === undefined || st.keys === undefined) throw new Unauthorized({});
  if (token === undefined) {
    if (st.policy.classes.includes(ANONYMOUS_CLASS)) return anonymousPrincipal(dbName);
    throw new Unauthorized({});
  }
  if (env.RAMOSE_TOKEN && token === env.RAMOSE_TOKEN) return tokenOnly(dbName);
  return verify(st, token, dbName);
}

function claimObject(x: unknown): Record<string, unknown> | undefined {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
}

async function verify(st: AuthState, token: string, dbName: string): Promise<Principal> {
  const key = `${token}|${dbName}`;
  const now = Date.now();
  const hit = principals.get(key);
  if (hit !== undefined && now - hit.at < PRINCIPAL_MEMO_MS) {
    if (isExpired(hit.principal, now)) {
      principals.delete(key);
      throw new Unauthorized({ message: "token expired" });
    }
    return hit.principal;
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, st.keys as JWTVerifyGetKey, { algorithms: ALGS, issuer: st.issuers as string[], audience: st.aud }));
  } catch {
    throw new Unauthorized({});
  }
  if (typeof payload.exp !== "number") throw new Unauthorized({});
  if (typeof payload.iat === "number" && payload.exp - payload.iat > st.maxTtl) throw new Unauthorized({ message: "token lifetime exceeds this peer's cap" });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Unauthorized({});
  const ramose = claimObject(payload.ramose);
  if (ramose === undefined || typeof ramose.db !== "string" || typeof ramose.class !== "string") throw new Unauthorized({});
  // an undeclared class grants nothing — and says so, rather than being an outage
  if (!(st.policy as CompiledPolicy).classes.includes(ramose.class)) throw new Unauthorized({ message: "token class is not declared by this peer's policy" });
  const attrs = ramose.attrs === undefined ? undefined : claimObject(ramose.attrs);
  if (ramose.attrs !== undefined && attrs === undefined) throw new Unauthorized({});

  const principal: Principal = Object.freeze({
    kind: "user",
    class: ramose.class,
    sub: payload.sub,
    claims: Object.freeze({
      sub: payload.sub,
      iss: payload.iss,
      aud: typeof payload.aud === "string" ? payload.aud : st.aud,
      exp: payload.exp,
      ...(attrs === undefined ? {} : { attrs }),
    }),
    db: ramose.db,
  });
  if (!allows(principal, dbName)) throw new Unauthorized({ message: "token is not valid for this database" });
  if (principals.size > 256) principals.clear();
  principals.set(key, { principal, at: now });
  return principal;
}

// ---------------------------------------------------------------------------
// `sub` → eid
// ---------------------------------------------------------------------------

/** Only *found* entities are cached: a user created moments ago must resolve now. */
const eids = new Map<string, { eid: number; at: number }>();

/** One AVET lookup on the policy's `principal` attribute, memoized when found. */
async function resolveEid(policy: CompiledPolicy, sub: string, dbName: string, ruleDb: Db): Promise<number | undefined> {
  const key = `${sub}|${dbName}`;
  const now = Date.now();
  const hit = eids.get(key);
  if (hit !== undefined && now - hit.at < PRINCIPAL_MEMO_MS) return hit.eid;
  const eid = await ruleDb.entid([policy.principal, sub] as never);
  if (eid === undefined) return undefined;
  if (eids.size > 256) eids.clear();
  eids.set(key, { eid, at: now });
  return eid;
}

/** Resolve the principal entity with one AVET lookup on the policy's `principal` attribute. */
export async function withEid(policy: CompiledPolicy, principal: Principal, ruleDb: Db): Promise<Principal> {
  if (principal.eid !== undefined || principal.sub === undefined || isAdmin(principal)) return principal;
  const eid = await resolveEid(policy, principal.sub, principal.db, ruleDb);
  return eid === undefined ? principal : { ...principal, eid };
}

/**
 * The principal as the wire tells it to its own client — the session `auth`
 * ack and `/info` carry `{ eid, class }`, `eid: null` when the policy's
 * `principal` attribute has no row for this `sub` yet (or there is no policy
 * to resolve one under). Informational, so unlike {@link withEid} it resolves
 * for admins too: an admin is exempt from filtering, not from having a row.
 */
export async function describePrincipal(env: RamoseEnv, principal: Principal, store: NodeSource, basis: Basis): Promise<{ eid: number | null; class: string }> {
  const st = authState(env);
  if (st.policy === undefined || principal.sub === undefined) return { eid: principal.eid ?? null, class: principal.class };
  if (principal.eid !== undefined) return { eid: principal.eid, class: principal.class };
  const eid = await resolveEid(st.policy, principal.sub, principal.db, await dbFromBasis(store, basis));
  return { eid: eid ?? null, class: principal.class };
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

/**
 * The `Db` a read runs against: the data view at the requested `t`, filtered by
 * the rules read from the *current* basis (so history cannot re-grant).
 */
export async function viewDb(
  env: RamoseEnv,
  principal: Principal,
  store: NodeSource,
  basis: Basis,
  opts: { asOf?: number; history?: boolean } = {},
): Promise<Db> {
  const st = authState(env);
  if (st.configured && st.policy === undefined) throw new Unauthorized({});
  const data = await dbFromBasis(store, basis, opts);
  if (st.policy === undefined || isAdmin(principal)) return data;
  const current = opts.asOf === undefined && !opts.history ? data : await dbFromBasis(store, basis);
  return filterDb(data, current, st.policy, await withEid(st.policy, principal, current));
}

/** Every op is a map form carrying `:db/ident` — i.e. an `ensure`. */
function schemaIdents(tx: readonly unknown[]): string[] | undefined {
  if (tx.length === 0) return undefined;
  const out: string[] = [];
  for (const op of tx) {
    if (typeof op !== "object" || op === null || Array.isArray(op)) return undefined;
    const ident = (op as Record<string, unknown>)[":db/ident"];
    if (typeof ident !== "string") return undefined;
    out.push(ident);
  }
  return out;
}

/**
 * `send` carries the ops to forward (preset injections included) and the
 * principal with its entity resolved; `skip` is a no-op `ensure`.
 */
export type WriteCheck = { readonly kind: "send"; readonly tx: unknown[]; readonly principal: Principal } | { readonly kind: "skip" };

/**
 * The ingress pre-check, against the replica's basis. Best effort —
 * the replica lags the writer, so this is a latency optimisation and the
 * transactor's own check is the authority.
 */
export async function checkWrite(env: RamoseEnv, principal: Principal, store: NodeSource, basis: Basis, tx: unknown[]): Promise<WriteCheck> {
  const st = authState(env);
  if (st.policy === undefined || isAdmin(principal)) return { kind: "send", tx, principal };
  const db = await dbFromBasis(store, basis);

  // `ensure` is a schema tx: only `admin` changes schema, and a subset of what
  // is already deployed is skipped silently (frontend deployed before backend).
  const idents = schemaIdents(tx);
  if (idents !== undefined) {
    for (const ident of idents) {
      if (db.attr(ident) === undefined) throw new Unauthorized({ status: 403, message: "schema changes require the admin class", code: "policy", attr: ident });
    }
    return { kind: "skip" };
  }
  if (isTokenOnly(principal)) throw new Unauthorized({});

  const p = await withEid(st.policy, principal, db);
  const res = await checkTx(tx as TxData, db, st.policy, p);
  if (!res.ok) throw new Unauthorized({ status: 403, message: `${res.op} denied on ${res.attr}`, code: res.code, attr: res.attr });
  return { kind: "send", tx: res.ops, principal: p };
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * `access-control-allow-origin` under a policy: `undefined` leaves today's `*`,
 * `null` means send no header at all.
 */
export function allowedOrigin(env: RamoseEnv, request: Request): string | null | undefined {
  if (!authState(env).configured) return undefined;
  const list = csv(env.RAMOSE_ALLOWED_ORIGINS);
  if (list.length === 0) return null;
  const origin = request.headers.get("origin");
  if (origin === null) return list[0];
  return list.includes(origin) ? origin : null;
}
