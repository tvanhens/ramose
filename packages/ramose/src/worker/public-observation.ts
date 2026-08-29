/**
 * The complete public HTTP observation allowlist.
 *
 * Route code may return application results, but framework metadata, error
 * fields, and response headers must be selected here.  Rich diagnostics stay
 * in logs and on internal Durable Object responses.
 */

import type { RamoseEnv } from "../RamoseEnv.ts";

export const PUBLIC_OBSERVATION_ALLOWLIST = Object.freeze({
  healthFields: Object.freeze(["ok", "service"] as const),
  errorFields: Object.freeze([
    "error",
    "tag",
    "message",
    "operation",
    "step",
    "reason",
    "code",
  ] as const),
  responseHeaders: Object.freeze([
    "content-type",
    "cache-control",
    "retry-after",
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-expose-headers",
    "vary",
  ] as const),
  requestHeaders: Object.freeze([
    "content-type",
    "authorization",
    "x-ramose-catalog",
    "x-ramose-unit-hash",
  ] as const),
});

const RESPONSE_HEADERS = new Set<string>(
  PUBLIC_OBSERVATION_ALLOWLIST.responseHeaders,
);
const ERROR_FIELDS = new Set<string>(
  PUBLIC_OBSERVATION_ALLOWLIST.errorFields,
);

/** Defense-in-depth field selection for every framework-generated error. */
export const publicErrorBody = (
  body: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(body)) {
    if (ERROR_FIELDS.has(name) && value !== undefined) out[name] = value;
  }
  return out;
};

export const publicResponseHeaders = (
  headers: Headers | Record<string, string> | undefined,
): Record<string, string> => {
  if (headers === undefined) return {};
  const entries = headers instanceof Headers
    ? headers.entries()
    : Object.entries(headers);
  const out: Record<string, string> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (RESPONSE_HEADERS.has(name)) out[name] = value;
  }
  return out;
};

const configuredOrigins = (env: Pick<RamoseEnv, "RAMOSE_ALLOWED_ORIGINS">): readonly string[] =>
  (env.RAMOSE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

/** CORS metadata selected only from the server-owned origin allowlist. */
export const publicCorsHeaders = (
  request?: Request,
  env?: Pick<RamoseEnv, "RAMOSE_ALLOWED_ORIGINS">,
): Record<string, string> => {
  const configured = configuredOrigins(env ?? {});
  const origin = request?.headers.get("origin") ?? undefined;
  const allowedOrigin = configured.length === 0
    ? "*"
    : origin !== undefined && configured.includes(origin)
      ? origin
      : undefined;
  return {
    ...(allowedOrigin === undefined
      ? {}
      : { "access-control-allow-origin": allowedOrigin }),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      PUBLIC_OBSERVATION_ALLOWLIST.requestHeaders.join(","),
    "access-control-expose-headers": "retry-after",
    ...(configured.length === 0 ? {} : { vary: "origin" }),
  };
};

export const PUBLIC_HEALTH = Object.freeze({
  ok: true,
  service: "ramose",
});
