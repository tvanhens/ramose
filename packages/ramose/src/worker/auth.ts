/**
 * External database admission (AUTH-1).
 *
 * Verified JWT principals plus compiled policy are the only access model.
 * Open mode, RAMOSE_TOKEN, anonymous class, shared secrets, and seed-token
 * bypasses are gone. Until #344 / #339 / #343 wire verification and
 * authorized snapshots, every configured-database path fails closed
 * through {@link closeConfiguredAccess}.
 */

import * as Effect from "effect/Effect";
import { Unauthorized } from "./errors.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import type { WritesMode } from "../writes.ts";

export { DEFAULT_JWT_MAX_TTL } from "../Auth.ts";

/** Per-isolate memo lifetime reserved for #344 verified principals. */
export const PRINCIPAL_MEMO_MS = 60_000;

/**
 * Request-scoped caller metadata on the session/transactor wire.
 * Not an authorization decision. No anonymous or service-admin kind.
 */
export interface Principal {
  readonly kind: "user";
  readonly class: string;
  readonly classes?: readonly string[];
  readonly sub?: string;
  readonly eid?: number;
  readonly claims: {
    readonly sub?: string;
    readonly iss?: string;
    readonly aud?: string;
    readonly exp?: number;
    readonly attrs?: Readonly<Record<string, unknown>>;
  };
  readonly db: string;
}

export interface AuthState {
  /** Always true: there is no open/unconfigured data plane. */
  readonly configured: true;
}

const CLOSED: AuthState = { configured: true };

export function authState(_env: Pick<RamoseEnv, never>): AuthState {
  return CLOSED;
}

export const isTokenOnly = (_p: Principal): boolean => false;

export function isExpired(p: Principal, now = Date.now()): boolean {
  return p.claims.exp !== undefined && p.claims.exp * 1000 <= now;
}

/** Uniform 401. Must not reveal whether the database exists (AUTH-5). */
export const denyDatabaseAccess = (): never => {
  throw new Unauthorized({});
};

export async function principalOf(
  _env: RamoseEnv,
  _request: Request,
  _dbName: string,
): Promise<Principal> {
  return denyDatabaseAccess();
}

export async function principalForToken(
  _env: RamoseEnv,
  _token: string | undefined,
  _dbName: string,
): Promise<Principal> {
  return denyDatabaseAccess();
}

export function rememberProvisioned(principal: Principal, _eid: number): Principal {
  return principal;
}

export function cachedProvision(_principal: Principal): number | undefined {
  return undefined;
}

export async function withEid(
  _policy: unknown,
  principal: Principal,
  _ruleDb: unknown,
): Promise<Principal> {
  return principal;
}

export async function describePrincipal(
  _env: RamoseEnv,
  _principal: Principal,
  _store: unknown,
  _basis: unknown,
): Promise<{ eid: number | null; class: string }> {
  return denyDatabaseAccess();
}

export async function viewDb(
  _env: RamoseEnv,
  _principal: Principal,
  _store: unknown,
  _basis: unknown,
  _opts?: { asOf?: number; history?: boolean },
): Promise<never> {
  return denyDatabaseAccess();
}

export function allowsRawTransact(
  _writes: WritesMode,
  _principal: Principal | undefined,
  _tx: unknown,
  _policy?: unknown,
): boolean {
  return false;
}

export type WriteCheck =
  | { readonly kind: "send"; readonly tx: unknown[]; readonly principal: Principal }
  | { readonly kind: "skip" };

export async function checkWrite(
  _env: RamoseEnv,
  _principal: Principal,
  _store: unknown,
  _basis: unknown,
  _tx: unknown[],
): Promise<WriteCheck> {
  return { kind: "skip" };
}

export function shouldProvision(_principal: Principal): boolean {
  return false;
}

export function allowedOrigin(_env: RamoseEnv, _request: Request): string | undefined {
  return undefined;
}

/** Effect form of the outer close. */
export const closeDatabaseRequest: Effect.Effect<never, Unauthorized> = Effect.fail(
  new Unauthorized({}),
);
