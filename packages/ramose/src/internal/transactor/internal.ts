/**
 * Worker→DO shared secret. The Transactor and QueryReplica objects are only
 * ever reached from the peer Worker; when `RAMOSE_INTERNAL_SECRET` is set every
 * internal fetch (including `/subscribe`) must carry it. Unset = no gate.
 */

import type { RamoseEnv } from "./env.ts";

export const INTERNAL_HEADER = "x-ramose-internal";

type SecretEnv = Pick<RamoseEnv, "RAMOSE_INTERNAL_SECRET">;

/** The header to put on a Worker→DO (or DO→DO) fetch; empty when no secret is configured. */
export function internalHeaders(env: SecretEnv): Record<string, string> {
  const secret = env.RAMOSE_INTERNAL_SECRET;
  return secret ? { [INTERNAL_HEADER]: secret } : {};
}

/** Constant-time-ish compare (lengths differ → false; no early exit on content). */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Does this request carry the internal secret (always true when none is configured)? */
export function isInternal(env: SecretEnv, request: Request): boolean {
  const secret = env.RAMOSE_INTERNAL_SECRET;
  if (!secret) return true;
  return same(request.headers.get(INTERNAL_HEADER) ?? "", secret);
}

/** 401 when the gate is armed and the request did not present the secret. */
export function internalGate(env: SecretEnv, request: Request): Response | undefined {
  if (isInternal(env, request)) return undefined;
  return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
}
