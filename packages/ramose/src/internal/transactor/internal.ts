import type { RamoseEnv } from "./env.ts";

export const INTERNAL_HEADER = "x-ramose-internal";

type SecretEnv = Pick<RamoseEnv, "RAMOSE_INTERNAL_SECRET">;

export function internalHeaders(env: SecretEnv): Record<string, string> {
  const secret = env.RAMOSE_INTERNAL_SECRET;
  return secret ? { [INTERNAL_HEADER]: secret } : {};
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isInternal(env: SecretEnv, request: Request): boolean {
  const secret = env.RAMOSE_INTERNAL_SECRET;
  if (!secret) return false;
  return same(request.headers.get(INTERNAL_HEADER) ?? "", secret);
}

export function internalGate(env: SecretEnv, request: Request): Response | undefined {
  if (isInternal(env, request)) return undefined;
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}
