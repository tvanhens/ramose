/**
 * Durable, transport-neutral receipts for authoritative operation invocations.
 *
 * The per-database Transactor owns persistence and execution. This module owns
 * only the canonical identity, pure state machine, replay decision, and sealed
 * public projection shared by every transport that invokes that writer.
 */

import * as Effect from "effect/Effect";
import { InvalidRequest } from "../../db/Errors.ts";
import { sha256Hex } from "../core/bytes.ts";
import { toJson } from "../core/json.ts";
import { canonicalizeJson } from "./canonical-json.ts";
import type { JsonValue } from "./json.ts";
import type { OperationInvocation } from "./operations-runtime.ts";

export const INVOCATION_RECEIPT_VERSION = 1 as const;
export const MAX_INVOCATION_ID_LENGTH = 256;

/** Receipt wrapper around the existing authoritative operation input. */
export type AuthoritativeOperationInvocation = OperationInvocation & {
  readonly invocationId: string;
};

const INVOCATION_SCOPE_DIGEST_DOMAIN =
  "ramose/authoritative-invocation-scope/v1\0";
const INVOCATION_DIGEST_DOMAIN = "ramose/authoritative-invocation/v1\0";
const UTF8 = new TextEncoder();
const DIGEST_RE = /^[0-9a-f]{64}$/;

export type InvocationReceiptStatus =
  | "completed"
  | "rejected"
  | "failed"
  | "indeterminate";

/** The complete receipt visible to callers. Internal scope and digests stay sealed. */
export type PublicInvocationReceiptV1 = {
  readonly version: typeof INVOCATION_RECEIPT_VERSION;
  readonly invocationId: string;
  readonly status: InvocationReceiptStatus;
};

/** A deterministic caller-visible refusal, stored without private engine detail. */
export type SealedInvocationRejection =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "invalid_request" }
  | { readonly kind: "request_rejected" }
  | {
    readonly kind: "operation_rejected";
    readonly message: string;
    readonly operation: string;
    readonly step?: string;
    readonly reason?: string;
  };

type InvocationReceiptIdentity = {
  readonly version: typeof INVOCATION_RECEIPT_VERSION;
  /** Stable verified JWT subject. The database is supplied by the owning DO. */
  readonly principalId: string;
  readonly invocationId: string;
  /**
   * Database, graph derivation, verified subject/attrs, and classes. Renewable
   * JWT envelope metadata (token, key, issuer, audience, iat, exp) is excluded.
   */
  readonly scopeDigest: string;
  /** Operation identity/version, target, input, and deployed-catalog preconditions. */
  readonly invocationDigest: string;
};

export type ClaimedInvocationReceipt = InvocationReceiptIdentity & {
  readonly status: "claimed";
};

export type CompletedInvocationReceipt = InvocationReceiptIdentity & {
  readonly status: "completed";
  /** Private writer position used only for cache invalidation. Never public. */
  readonly committedT: number;
  /** Exact JSON output materialized by the deployed operation codec before commit. */
  readonly output: unknown;
};

export type RejectedInvocationReceipt = InvocationReceiptIdentity & {
  readonly status: "rejected";
  readonly rejection: SealedInvocationRejection;
};

export type FailedInvocationReceipt = InvocationReceiptIdentity & {
  readonly status: "failed";
};

export type IndeterminateInvocationReceipt = InvocationReceiptIdentity & {
  readonly status: "indeterminate";
};

export type TerminalInvocationReceipt =
  | CompletedInvocationReceipt
  | RejectedInvocationReceipt
  | FailedInvocationReceipt
  | IndeterminateInvocationReceipt;

export type StoredInvocationReceipt =
  | ClaimedInvocationReceipt
  | TerminalInvocationReceipt;

export type PreparedInvocationReceipt = InvocationReceiptIdentity;

export type InvocationReceiptDecision =
  | {
    readonly _tag: "Claim";
    readonly receipt: ClaimedInvocationReceipt;
  }
  | {
    readonly _tag: "Replay";
    readonly receipt: TerminalInvocationReceipt;
  }
  | {
    readonly _tag: "Recover";
    readonly receipt: IndeterminateInvocationReceipt;
  }
  | { readonly _tag: "Conflict" };

export type InvocationReceiptEvent =
  | {
    readonly _tag: "Complete";
    readonly committedT: number;
    readonly output: unknown;
  }
  | {
    readonly _tag: "Reject";
    readonly rejection: SealedInvocationRejection;
  }
  | { readonly _tag: "Fail" }
  | { readonly _tag: "Recover" };

export type InvocationReceiptOutcome =
  | {
    readonly _tag: "Completed";
    readonly receipt: PublicInvocationReceiptV1 & { readonly status: "completed" };
    readonly committedT: number;
    readonly output: unknown;
  }
  | {
    readonly _tag: "Rejected";
    readonly receipt: PublicInvocationReceiptV1 & { readonly status: "rejected" };
    readonly rejection: SealedInvocationRejection;
  }
  | {
    readonly _tag: "Failed";
    readonly receipt: PublicInvocationReceiptV1 & { readonly status: "failed" };
  }
  | {
    readonly _tag: "Indeterminate";
    readonly receipt: PublicInvocationReceiptV1 & { readonly status: "indeterminate" };
  };

export type AuthoritativeInvocationResult =
  | InvocationReceiptOutcome
  | { readonly _tag: "Conflict" };

const invalid = (message: string): InvalidRequest =>
  new InvalidRequest({ message });

/** Invocation IDs are opaque caller data, bounded only for durable key safety. */
export const requireInvocationId = (value: unknown): string => {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_INVOCATION_ID_LENGTH
  ) {
    throw invalid(
      `invocationId must be a non-empty string of at most ${MAX_INVOCATION_ID_LENGTH} characters`,
    );
  }
  return value;
};

/** Verified JWT admission requires this subject; receipts never fall back to roles. */
export const invocationPrincipalId = (
  invocation: Pick<AuthoritativeOperationInvocation, "caller">,
): string => {
  const subject = invocation.caller.claims.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    throw invalid("operation invocation requires a verified principal subject");
  }
  return subject;
};

const canonicalClasses = (classes: readonly string[]): readonly string[] =>
  [...new Set(classes)].sort();

/** Pure authorization claim view; ordinary JWT renewal leaves it unchanged. */
export const invocationScopeMaterial = (
  invocation: AuthoritativeOperationInvocation,
): JsonValue => ({
  version: INVOCATION_RECEIPT_VERSION,
  database: invocation.database,
  principal: {
    claims: invocation.caller.claims,
    classes: canonicalClasses(invocation.caller.classes),
  },
  graph: invocation.routeDerivation === undefined
    ? null
    : {
      rootDatabase: invocation.routeDerivation.rootDatabase,
      graphs: invocation.routeDerivation.graphs.map((graph) => ({
        graphEntity: graph.graphEntity,
        catalogKey: graph.catalogKey,
      })),
    },
});

/** Pure canonical invocation material. No callback/source/executable can enter it. */
export const invocationDigestMaterial = (
  invocation: AuthoritativeOperationInvocation,
): JsonValue => ({
  version: INVOCATION_RECEIPT_VERSION,
  operation: {
    catalogKey: invocation.catalogKey,
    unitHash: invocation.unitHash,
    owner: {
      kind: invocation.owner.kind,
      name: invocation.owner.name,
    },
    localName: invocation.localName,
  },
  target: invocation.target === undefined
    ? null
    : toJson(invocation.target) as JsonValue,
  input: invocation.input === undefined
    ? { present: false }
    : { present: true, value: invocation.input as JsonValue },
});

const hashCanonical = Effect.fn("Authorization.hashInvocationReceiptMaterial")(
  function* (domain: string, material: JsonValue) {
    return yield* Effect.tryPromise({
      try: () => sha256Hex(
        UTF8.encode(`${domain}${canonicalizeJson(material)}`),
      ),
      catch: () => invalid("operation invocation must contain canonical JSON data"),
    });
  },
);

/** Canonicalize and hash the exact scope and invocation before a durable claim. */
export const prepareInvocationReceipt = Effect.fn(
  "Authorization.prepareInvocationReceipt",
)(function* (
  invocation: AuthoritativeOperationInvocation,
): Effect.fn.Return<PreparedInvocationReceipt, InvalidRequest> {
  const invocationId = requireInvocationId(invocation.invocationId);
  const principalId = invocationPrincipalId(invocation);
  const [scopeDigest, invocationDigest] = yield* Effect.all([
    hashCanonical(INVOCATION_SCOPE_DIGEST_DOMAIN, invocationScopeMaterial(invocation)),
    hashCanonical(INVOCATION_DIGEST_DOMAIN, invocationDigestMaterial(invocation)),
  ]);
  return Object.freeze({
    version: INVOCATION_RECEIPT_VERSION,
    principalId,
    invocationId,
    scopeDigest,
    invocationDigest,
  });
});

const sameIdentity = (
  stored: StoredInvocationReceipt,
  prepared: PreparedInvocationReceipt,
): boolean =>
  stored.version === prepared.version &&
  stored.principalId === prepared.principalId &&
  stored.invocationId === prepared.invocationId &&
  stored.scopeDigest === prepared.scopeDigest &&
  stored.invocationDigest === prepared.invocationDigest;

/** Pure claim/replay/conflict/recovery decision for one durable key. */
export const decideInvocationReceipt = (
  stored: StoredInvocationReceipt | undefined,
  prepared: PreparedInvocationReceipt,
): InvocationReceiptDecision => {
  if (stored === undefined) {
    return {
      _tag: "Claim",
      receipt: Object.freeze({ ...prepared, status: "claimed" }),
    };
  }
  if (!sameIdentity(stored, prepared)) return { _tag: "Conflict" };
  if (stored.status === "claimed") {
    return {
      _tag: "Recover",
      receipt: Object.freeze({ ...stored, status: "indeterminate" }),
    };
  }
  return { _tag: "Replay", receipt: stored };
};

/**
 * Apply one receipt event. Terminal receipts are sealed: later events return
 * the exact existing value instead of changing a completed decision.
 */
export const transitionInvocationReceipt = (
  receipt: StoredInvocationReceipt,
  event: InvocationReceiptEvent,
): TerminalInvocationReceipt => {
  if (receipt.status !== "claimed") return receipt;
  switch (event._tag) {
    case "Complete":
      if (!Number.isSafeInteger(event.committedT) || event.committedT < 0) {
        throw new TypeError("completed invocation receipt needs a valid writer position");
      }
      return Object.freeze({
        ...receipt,
        status: "completed",
        committedT: event.committedT,
        output: event.output,
      });
    case "Reject":
      return Object.freeze({
        ...receipt,
        status: "rejected",
        rejection: event.rejection,
      });
    case "Fail":
      return Object.freeze({ ...receipt, status: "failed" });
    case "Recover":
      return Object.freeze({ ...receipt, status: "indeterminate" });
  }
};

export const publicInvocationReceipt = (
  receipt: TerminalInvocationReceipt,
): PublicInvocationReceiptV1 => Object.freeze({
  version: INVOCATION_RECEIPT_VERSION,
  invocationId: receipt.invocationId,
  status: receipt.status,
});

/** Project a durable terminal record into the one transport-neutral outcome. */
export const invocationReceiptOutcome = (
  receipt: TerminalInvocationReceipt,
): InvocationReceiptOutcome => {
  const publicReceipt = publicInvocationReceipt(receipt);
  switch (receipt.status) {
    case "completed":
      return {
        _tag: "Completed",
        receipt: publicReceipt as PublicInvocationReceiptV1 & {
          readonly status: "completed";
        },
        committedT: receipt.committedT,
        output: receipt.output,
      };
    case "rejected":
      return {
        _tag: "Rejected",
        receipt: publicReceipt as PublicInvocationReceiptV1 & {
          readonly status: "rejected";
        },
        rejection: receipt.rejection,
      };
    case "failed":
      return {
        _tag: "Failed",
        receipt: publicReceipt as PublicInvocationReceiptV1 & {
          readonly status: "failed";
        },
      };
    case "indeterminate":
      return {
        _tag: "Indeterminate",
        receipt: publicReceipt as PublicInvocationReceiptV1 & {
          readonly status: "indeterminate";
        },
      };
  }
};

const isIdentity = (value: Record<string, unknown>): boolean =>
  value.version === INVOCATION_RECEIPT_VERSION &&
  typeof value.principalId === "string" && value.principalId.length > 0 &&
  typeof value.invocationId === "string" && value.invocationId.length > 0 &&
  typeof value.scopeDigest === "string" && DIGEST_RE.test(value.scopeDigest) &&
  typeof value.invocationDigest === "string" &&
  DIGEST_RE.test(value.invocationDigest);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key));
};

const IDENTITY_KEYS = Object.freeze([
  "version",
  "principalId",
  "invocationId",
  "scopeDigest",
  "invocationDigest",
  "status",
] as const);

const isRejection = (value: unknown): value is SealedInvocationRejection => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.kind === "unauthorized" || record.kind === "invalid_request" ||
    record.kind === "request_rejected"
  ) return hasExactKeys(record, ["kind"]);
  return record.kind === "operation_rejected" &&
    typeof record.message === "string" &&
    typeof record.operation === "string" &&
    (record.step === undefined || typeof record.step === "string") &&
    (record.reason === undefined || typeof record.reason === "string") &&
    hasExactKeys(record, [
      "kind",
      "message",
      "operation",
      ...(record.step === undefined ? [] : ["step"]),
      ...(record.reason === undefined ? [] : ["reason"]),
    ]);
};

/** Fail closed on malformed durable rows; never reinterpret corruption as a miss. */
export const parseStoredInvocationReceipt = (
  value: unknown,
): StoredInvocationReceipt => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid durable invocation receipt");
  }
  const record = value as Record<string, unknown>;
  if (!isIdentity(record)) throw new TypeError("invalid durable invocation receipt");
  if (
    (record.status === "claimed" || record.status === "failed" ||
      record.status === "indeterminate") &&
    hasExactKeys(record, IDENTITY_KEYS)
  ) {
    return record as StoredInvocationReceipt;
  }
  if (
    record.status === "completed" &&
    Number.isSafeInteger(record.committedT) && (record.committedT as number) >= 0 &&
    Object.hasOwn(record, "output") &&
    hasExactKeys(record, [...IDENTITY_KEYS, "committedT", "output"])
  ) return record as StoredInvocationReceipt;
  if (
    record.status === "rejected" && isRejection(record.rejection) &&
    hasExactKeys(record, [...IDENTITY_KEYS, "rejection"])
  ) {
    return record as StoredInvocationReceipt;
  }
  throw new TypeError("invalid durable invocation receipt");
};

const hasPublicReceipt = (
  value: unknown,
  invocationId: string,
  status: InvocationReceiptStatus,
): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  return receipt.version === INVOCATION_RECEIPT_VERSION &&
    receipt.invocationId === invocationId && receipt.status === status &&
    Object.keys(receipt).length === 3;
};

/** Validate the private Transactor result without admitting extra metadata. */
export const parseAuthoritativeInvocationResult = (
  value: unknown,
  invocationId: string,
): AuthoritativeInvocationResult => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid authoritative invocation result");
  }
  const result = value as Record<string, unknown>;
  if (
    result._tag === "Conflict" && hasExactKeys(result, ["_tag"])
  ) return { _tag: "Conflict" };
  if (
    result._tag === "Completed" &&
    hasPublicReceipt(result.receipt, invocationId, "completed") &&
    Number.isSafeInteger(result.committedT) && (result.committedT as number) >= 0 &&
    Object.hasOwn(result, "output") &&
    hasExactKeys(result, ["_tag", "receipt", "committedT", "output"])
  ) return result as AuthoritativeInvocationResult;
  if (
    result._tag === "Rejected" &&
    hasPublicReceipt(result.receipt, invocationId, "rejected") &&
    isRejection(result.rejection) &&
    hasExactKeys(result, ["_tag", "receipt", "rejection"])
  ) return result as AuthoritativeInvocationResult;
  if (
    result._tag === "Failed" &&
    hasPublicReceipt(result.receipt, invocationId, "failed") &&
    hasExactKeys(result, ["_tag", "receipt"])
  ) return result as AuthoritativeInvocationResult;
  if (
    result._tag === "Indeterminate" &&
    hasPublicReceipt(result.receipt, invocationId, "indeterminate") &&
    hasExactKeys(result, ["_tag", "receipt"])
  ) return result as AuthoritativeInvocationResult;
  throw new TypeError("invalid authoritative invocation result");
};
