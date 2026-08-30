/**
 * The experimental MCP wire contract (#484 S1).
 *
 * Pure, transport-free vocabulary shared by the kernel tools: the public
 * error envelope, the opaque public projection of the merged operation-scoped
 * `OperationVersion` (#487), and validation of the three tools' arguments
 * including the minimal query document.
 *
 * ## Experimental
 *
 * This surface makes no compatibility promise. Codes may be added, shapes may
 * change, and clients must not switch exhaustively on either. What is *not*
 * negotiable at any point: nothing here mints an identity, a digest, or a
 * receipt of its own, and no internal id, digest, catalog key, unit hash, or
 * transaction id may appear in any value this module produces.
 */

import { MAX_INVOCATION_ID_LENGTH } from "../internal/authorization/invocation-receipts.ts";
import { OperationVersion } from "../internal/authorization/identities.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Recoverable public failure codes. The set is **open** while the surface is
 * experimental — a client should treat an unknown code as a plain failure.
 */
export const ERROR_CODES = Object.freeze([
  /** The query document is not a well-formed, in-bound query. */
  "invalid_query",
  /** Tool arguments failed the published input schema or a bound. */
  "invalid_input",
  /** Hidden, missing, or unauthorized — deliberately indistinguishable. */
  "inaccessible",
  /** The pinned operation version is not the deployed one. No effect occurred. */
  "operation_changed",
  /** This invocationId already names a different invocation. */
  "invocation_conflict",
  /** A pre-correction receipt exists; mint a fresh invocationId. */
  "invocation_update_required",
  /** The invocation's effect is not yet decidable. Retry the same id. */
  "invocation_indeterminate",
  /** The operation itself refused: a precondition or policy said no. */
  "operation_rejected",
  /** The request exceeded a declared read budget. Nothing was truncated. */
  "query_budget_exceeded",
  /** Something on the server failed. No public detail is available. */
  "internal_error",
] as const);
export type ErrorCodeV1 = (typeof ERROR_CODES)[number];

/** Whether attempting the same intent again can succeed. A hint, never authority. */
const RETRYABLE: Readonly<Record<ErrorCodeV1, boolean>> = Object.freeze({
  invalid_query: false,
  invalid_input: false,
  inaccessible: false,
  operation_changed: true,
  invocation_conflict: false,
  invocation_update_required: true,
  invocation_indeterminate: true,
  operation_rejected: false,
  query_budget_exceeded: true,
  internal_error: true,
});

/** The one structured failure shape every kernel tool shares. */
export type ErrorEnvelopeV1 = {
  readonly code: ErrorCodeV1;
  readonly message: string;
  readonly retryable: boolean;
};

const MAX_MESSAGE_LENGTH = 512;

export const errorEnvelope = (
  code: ErrorCodeV1,
  message: string,
): ErrorEnvelopeV1 =>
  Object.freeze({
    code,
    message: message.slice(0, MAX_MESSAGE_LENGTH),
    retryable: RETRYABLE[code],
  });

/**
 * A recoverable tool failure. Thrown inside a tool body and restated as a
 * completed `isError: true` result; it never becomes a protocol error.
 */
export class McpToolFailure extends Error {
  readonly envelope: ErrorEnvelopeV1;
  constructor(envelope: ErrorEnvelopeV1) {
    super(envelope.message);
    this.name = "McpToolFailure";
    this.envelope = envelope;
  }
}

export const toolFailure = (
  code: ErrorCodeV1,
  message: string,
): McpToolFailure => new McpToolFailure(errorEnvelope(code, message));

// ---------------------------------------------------------------------------
// The public operation version token
// ---------------------------------------------------------------------------

const PREFIX = "ov_";
const HEX_DIGEST = /^[0-9a-f]{64}$/;
/** 32 bytes as unpadded base64url is exactly 43 characters. */
const TOKEN = /^ov_[A-Za-z0-9_-]{43}$/;

/**
 * Project the merged {@link OperationVersion} into its opaque public token.
 *
 * This is a re-encoding of one existing value, never a second digest: an
 * `ov_`-prefixed unpadded base64url string is structurally not a hex digest,
 * so it cannot be confused with — or substituted for — an internal identifier
 * on the wire. It is a bijection, which is what makes `operation_changed`
 * decidable at the boundary.
 */
export const encodeOperationVersionToken = (version: string): string => {
  if (!HEX_DIGEST.test(version)) {
    throw new TypeError("ramose/mcp: not a canonical operation version");
  }
  let binary = "";
  for (let index = 0; index < 32; index++) {
    binary += String.fromCharCode(
      Number.parseInt(version.slice(index * 2, index * 2 + 2), 16),
    );
  }
  const base64 = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${PREFIX}${base64}`;
};

/** Recover the pinned {@link OperationVersion}, or `undefined` if malformed. */
export const decodeOperationVersionToken = (
  token: string,
): OperationVersion | undefined => {
  if (!TOKEN.test(token)) return undefined;
  let binary: string;
  try {
    binary = atob(
      `${token.slice(PREFIX.length).replaceAll("-", "+").replaceAll("_", "/")}=`,
    );
  } catch {
    return undefined;
  }
  if (binary.length !== 32) return undefined;
  let hex = "";
  for (let index = 0; index < 32; index++) {
    hex += binary.charCodeAt(index).toString(16).padStart(2, "0");
  }
  // Base64 leaves four unused trailing bits. Requiring the token to be the
  // exact encoding of what it decoded to rejects the non-canonical spellings,
  // so no two tokens can ever name one version.
  return encodeOperationVersionToken(hex) === token
    ? OperationVersion.make(hex)
    : undefined;
};

// ---------------------------------------------------------------------------
// Tool arguments
// ---------------------------------------------------------------------------

/** Bounds. Deliberately small: this slice has no pagination to fall back on. */
export const MAX_AT_SEGMENTS = 16;
export const MAX_SEGMENT_LENGTH = 256;
export const MAX_WHERE_KEYS = 16;
export const MAX_SELECT_FIELDS = 64;
export const MAX_QUERY_LIMIT = 200;
export const DEFAULT_QUERY_LIMIT = 50;
/** Fixed cap on every `describe` list. Honest truncation, not pagination. */
export const MAX_DESCRIBE_ITEMS = 200;

export type QueryScalar = string | number | boolean;

export type QueryDocumentV1 = {
  readonly version: 1;
  readonly from: { readonly entity: string };
  readonly where?: Readonly<Record<string, QueryScalar>>;
  readonly select?: readonly string[];
  readonly limit?: number;
};

export type OperationRefV1 = {
  readonly owner: { readonly kind: "entity" | "trait"; readonly name: string };
  readonly name: string;
  readonly version: string;
};

export type MutateArgsV1 = {
  readonly at: readonly string[];
  readonly operation: OperationRefV1;
  readonly input: Record<string, unknown>;
  readonly invocationId: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidInput = (message: string): never => {
  throw toolFailure("invalid_input", message);
};

const invalidQuery = (message: string): never => {
  throw toolFailure("invalid_query", message);
};

export const requireArgs = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : invalidInput("arguments must be an object");

/** `at` is the caller-visible graph path relative to their authorized root. */
export const parseAt = (value: unknown): readonly string[] => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_AT_SEGMENTS) {
    return invalidInput("at must be an array of at most 16 graph names");
  }
  const segments: string[] = [];
  for (const segment of value) {
    if (
      typeof segment !== "string" ||
      segment.length === 0 ||
      segment.length > MAX_SEGMENT_LENGTH
    ) {
      return invalidInput("at segments must be bounded, non-empty strings");
    }
    segments.push(segment);
  }
  return Object.freeze(segments);
};

const parseScalar = (value: unknown, key: string): QueryScalar => {
  if (typeof value === "string") {
    if (value.length > MAX_SEGMENT_LENGTH) {
      return invalidQuery(`where.${key} exceeds the string bound`);
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return invalidQuery(`where.${key} must be a string, number, or boolean`);
};

/**
 * The minimal query document: an entity root, equality filters on visible
 * fields, a field projection, and a row limit. No expressions, bindings,
 * ordering, cursors, aggregates, or nested projections in this slice.
 */
export const parseQueryDocument = (value: unknown): QueryDocumentV1 => {
  if (!isRecord(value)) return invalidQuery("query must be an object");
  if (value.version !== 1) return invalidQuery("query.version must be 1");
  const from = value.from;
  if (
    !isRecord(from) ||
    typeof from.entity !== "string" ||
    from.entity.length === 0 ||
    from.entity.length > MAX_SEGMENT_LENGTH
  ) {
    return invalidQuery("query.from must be { entity: <name> }");
  }
  let where: Record<string, QueryScalar> | undefined;
  if (value.where !== undefined) {
    if (!isRecord(value.where)) return invalidQuery("query.where must be an object");
    const entries = Object.entries(value.where);
    if (entries.length > MAX_WHERE_KEYS) {
      return invalidQuery("query.where exceeds the clause bound");
    }
    // `Object.fromEntries` creates every key as an *own* data property.
    // Assigning into a plain `{}` would instead hit the inherited `__proto__`
    // setter, which silently swallows that key — and a swallowed filter is an
    // unfiltered query, so the caller would get back every visible row.
    where = Object.fromEntries(
      entries.map(([key, entry]) => [key, parseScalar(entry, key)] as const),
    );
  }
  let select: readonly string[] | undefined;
  if (value.select !== undefined) {
    if (!Array.isArray(value.select) || value.select.length > MAX_SELECT_FIELDS) {
      return invalidQuery("query.select must be an array of at most 64 names");
    }
    for (const field of value.select) {
      if (typeof field !== "string" || field.length === 0) {
        return invalidQuery("query.select entries must be non-empty strings");
      }
    }
    select = Object.freeze([...(value.select as string[])]);
  }
  let limit: number | undefined;
  if (value.limit !== undefined) {
    if (
      typeof value.limit !== "number" ||
      !Number.isSafeInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > MAX_QUERY_LIMIT
    ) {
      return invalidQuery(`query.limit must be an integer in 1..${MAX_QUERY_LIMIT}`);
    }
    limit = value.limit;
  }
  return Object.freeze({
    version: 1 as const,
    from: Object.freeze({ entity: from.entity }),
    ...(where === undefined ? {} : { where: Object.freeze(where) }),
    ...(select === undefined ? {} : { select }),
    ...(limit === undefined ? {} : { limit }),
  });
};

export const parseMutateArgs = (value: unknown): MutateArgsV1 => {
  const args = requireArgs(value);
  const at = parseAt(args.at);
  const operation = args.operation;
  if (!isRecord(operation)) {
    return invalidInput("operation must be { owner, name, version }");
  }
  const owner = operation.owner;
  if (
    !isRecord(owner) ||
    (owner.kind !== "entity" && owner.kind !== "trait") ||
    typeof owner.name !== "string" ||
    owner.name.length === 0 ||
    owner.name.length > MAX_SEGMENT_LENGTH
  ) {
    return invalidInput("operation.owner must be { kind: entity|trait, name }");
  }
  if (
    typeof operation.name !== "string" ||
    operation.name.length === 0 ||
    operation.name.length > MAX_SEGMENT_LENGTH
  ) {
    return invalidInput("operation.name must be a bounded, non-empty string");
  }
  if (
    typeof operation.version !== "string" ||
    decodeOperationVersionToken(operation.version) === undefined
  ) {
    return invalidInput("operation.version must be a version discovery returned");
  }
  if (
    typeof args.invocationId !== "string" ||
    args.invocationId.length === 0 ||
    args.invocationId.length > MAX_INVOCATION_ID_LENGTH
  ) {
    return invalidInput("invocationId must be a bounded, non-empty string");
  }
  if (!isRecord(args.input)) {
    // Non-object operation inputs are a later slice; refusing is honest.
    return invalidInput("input must be an object");
  }
  return Object.freeze({
    at,
    operation: Object.freeze({
      owner: Object.freeze({ kind: owner.kind, name: owner.name }),
      name: operation.name,
      version: operation.version,
    }),
    input: args.input,
    invocationId: args.invocationId,
  });
};
