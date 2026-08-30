import { INVOCATION_RECEIPT_VERSION } from "../internal/authorization/invocation-receipts.ts";
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
    "receipt",
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
const RECEIPT_STATUSES = new Set([
  "completed",
  "rejected",
  "failed",
  "indeterminate",
]);

const publicReceipt = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const receipt = value as Record<string, unknown>;
  if (
    receipt.version !== INVOCATION_RECEIPT_VERSION ||
    typeof receipt.invocationId !== "string" ||
    receipt.invocationId.length === 0 || receipt.invocationId.length > 256 ||
    typeof receipt.status !== "string" ||
    !RECEIPT_STATUSES.has(receipt.status)
  ) return undefined;
  return {
    version: INVOCATION_RECEIPT_VERSION,
    invocationId: receipt.invocationId,
    status: receipt.status,
  };
};

export const publicErrorBody = (
  body: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(body)) {
    if (!ERROR_FIELDS.has(name) || value === undefined) continue;
    if (name === "receipt") {
      const receipt = publicReceipt(value);
      if (receipt !== undefined) out.receipt = receipt;
      continue;
    }
    out[name] = value;
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
