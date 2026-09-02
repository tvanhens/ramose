import * as Effect from "effect/Effect";
import { isAllocationSlotName } from "../../db/allocations.ts";
import { InvalidRequest } from "../../db/Errors.ts";
import {
  ENTITY_ID_CODEC,
  entityIdEnvelope,
  isClientRef,
  isEntityId,
} from "../../db/refs.ts";
import { sameEpochScope, type EpochBoundScope } from "./entity-targets.ts";
import { sha256Hex } from "../core/bytes.ts";
import { toJson } from "../core/json.ts";
import { canonicalizeJson } from "./canonical-json.ts";
import { OperationVersion } from "./identities.ts";
import type { JsonValue } from "./json.ts";
import type { OperationInvocation } from "./operations-runtime.ts";

export const INVOCATION_RECEIPT_VERSION = 2 as const;
export const LEGACY_INVOCATION_RECEIPT_VERSIONS: readonly number[] = [1];
export const MAX_INVOCATION_ID_LENGTH = 256;
const MAX_SEALED_HANDLE_LENGTH = 4096;

export type AuthoritativeOperationInvocation = OperationInvocation & {
  readonly invocationId: string;
};

const INVOCATION_SCOPE_DIGEST_DOMAIN =
  "ramose/authoritative-invocation-scope/v2\0";
const INVOCATION_DIGEST_DOMAIN = "ramose/authoritative-invocation/v2\0";
const UTF8 = new TextEncoder();
const DIGEST_RE = /^[0-9a-f]{64}$/;

export type InvocationReceiptStatus =
  | "completed"
  | "rejected"
  | "failed"
  | "indeterminate";

export type PublicInvocationReceipt = {
  readonly version: typeof INVOCATION_RECEIPT_VERSION;
  readonly invocationId: string;
  readonly status: InvocationReceiptStatus;
};

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
  readonly principalId: string;
  readonly invocationId: string;
  readonly scopeDigest: string;
  readonly operationVersion: OperationVersion;
  readonly invocationDigest: string;
};

export type ClaimedInvocationReceipt = InvocationReceiptIdentity & {
  readonly status: "claimed";
};

export type InvocationReplayFenceV1 = {
  readonly version: 1;
  readonly target?: {
    readonly eid: number;
    readonly type: string;
    readonly referenceEid: number | null;
    readonly postCommit:
      | { readonly kind: "visible" }
      | {
        readonly kind: "absent";
        readonly authorizationDigest: string;
        readonly authorizationReadSet: readonly (
          | { readonly kind: "type" | "exists"; readonly eid: number }
          | {
            readonly kind: "field";
            readonly eid: number;
            readonly ident: string;
          }
        )[];
      }
      | {
        readonly kind: "hidden";
        readonly authorizationDigest: string;
      };
  };
  readonly consumedRefs: readonly {
    readonly path: readonly (string | number)[];
    readonly eid: number;
    readonly type: string;
  }[];
};

export type InvocationAllocationMappingsV1 = {
  readonly version: 1;
  readonly keyId: string;
  readonly scope: {
    readonly server: string;
    readonly principal: string;
    readonly database: string;
  };
  readonly entries: readonly {
    readonly slot: string;
    readonly clientRef: string;
    readonly entityId: string;
  }[];
};

export const allocationMappingsResolvable = (
  mappings: InvocationAllocationMappingsV1,
  current: EpochBoundScope,
): boolean =>
  sameEpochScope(mappings, current) &&
  mappings.entries.every((entry) => {
    const envelope = entityIdEnvelope(entry.entityId);
    return envelope !== undefined &&
      envelope.codecVersion === ENTITY_ID_CODEC &&
      envelope.keyId === current.keyId;
  });

export type CompletedInvocationReceipt = InvocationReceiptIdentity & {
  readonly status: "completed";
  readonly committedT: number;
  readonly output: unknown;
  readonly replayFence: InvocationReplayFenceV1;
  readonly allocations?: InvocationAllocationMappingsV1;
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
    readonly _tag: "OperationChanged";
  }
  | {
    readonly _tag: "UpdateRequired";
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
    readonly replayFence: InvocationReplayFenceV1;
    readonly allocations?: InvocationAllocationMappingsV1;
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
    readonly receipt: PublicInvocationReceipt & { readonly status: "completed" };
    readonly committedT: number;
    readonly output: unknown;
    readonly mappings?: readonly {
      readonly clientRef: string;
      readonly entityId: string;
    }[];
    readonly outputRefPaths?: readonly (readonly (string | number)[])[];
  }
  | {
    readonly _tag: "Rejected";
    readonly receipt: PublicInvocationReceipt & { readonly status: "rejected" };
    readonly rejection: SealedInvocationRejection;
  }
  | {
    readonly _tag: "Failed";
    readonly receipt: PublicInvocationReceipt & { readonly status: "failed" };
  }
  | {
    readonly _tag: "Indeterminate";
    readonly receipt: PublicInvocationReceipt & { readonly status: "indeterminate" };
  };

export type AuthoritativeInvocationResult =
  | InvocationReceiptOutcome
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "OperationChanged" }
  | { readonly _tag: "UpdateRequired" };

const invalid = (message: string): InvalidRequest =>
  new InvalidRequest({ message });

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

export const invocationPrincipalId = (
  invocation: Pick<AuthoritativeOperationInvocation, "caller">,
): string => {
  const subject = invocation.caller.claims.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    throw invalid("operation invocation requires a verified principal subject");
  }
  return subject;
};

export const invocationScopeMaterial = (
  invocation: AuthoritativeOperationInvocation,
): JsonValue => ({
  version: INVOCATION_RECEIPT_VERSION,
  database: invocation.database,
  principal: {
    claims: invocation.caller.claims,
    classes: [...invocation.caller.classes],
  },
});

export const invocationDigestMaterial = (
  invocation: AuthoritativeOperationInvocation,
  operationVersion: OperationVersion,
): JsonValue => ({
  version: INVOCATION_RECEIPT_VERSION,
  operation: {
    version: operationVersion,
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
  ...(invocation.allocations === undefined || invocation.allocations.length === 0
    ? {}
    : {
      allocations: invocation.allocations.map((allocation) => ({
        slot: allocation.slot,
        clientRef: allocation.clientRef as string,
      })),
    }),
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

const SCOPE_DIGEST_CACHE_LIMIT = 256;
const scopeDigests = new Map<string, string>();

const scopeDigestFor = async (
  invocation: AuthoritativeOperationInvocation,
): Promise<string> => {
  const canonical = canonicalizeJson(invocationScopeMaterial(invocation));
  const cached = scopeDigests.get(canonical);
  if (cached !== undefined) return cached;
  const digest = await sha256Hex(
    UTF8.encode(`${INVOCATION_SCOPE_DIGEST_DOMAIN}${canonical}`),
  );
  if (scopeDigests.size >= SCOPE_DIGEST_CACHE_LIMIT) {
    scopeDigests.delete(scopeDigests.keys().next().value!);
  }
  scopeDigests.set(canonical, digest);
  return digest;
};

export const prepareInvocationReceiptDirect = async (
  invocation: AuthoritativeOperationInvocation,
  operationVersion: OperationVersion,
): Promise<PreparedInvocationReceipt> => {
  const invocationId = requireInvocationId(invocation.invocationId);
  const principalId = invocationPrincipalId(invocation);
  let scopeDigest: string;
  let invocationDigest: string;
  try {
    [scopeDigest, invocationDigest] = await Promise.all([
      scopeDigestFor(invocation),
      sha256Hex(UTF8.encode(
        `${INVOCATION_DIGEST_DOMAIN}${canonicalizeJson(invocationDigestMaterial(invocation, operationVersion))}`,
      )),
    ]);
  } catch {
    throw invalid("operation invocation must contain canonical JSON data");
  }
  return Object.freeze({
    version: INVOCATION_RECEIPT_VERSION,
    principalId,
    invocationId,
    scopeDigest,
    operationVersion,
    invocationDigest,
  });
};

export const requireSuppliedOperationVersion = (
  value: unknown,
): OperationVersion | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    throw invalid("operationVersion must be a canonical operation version digest");
  }
  return OperationVersion.make(value);
};

export const prepareInvocationReceipt = Effect.fn(
  "Authorization.prepareInvocationReceipt",
)(function* (
  invocation: AuthoritativeOperationInvocation,
  operationVersion: OperationVersion,
): Effect.fn.Return<PreparedInvocationReceipt, InvalidRequest> {
  const invocationId = requireInvocationId(invocation.invocationId);
  const principalId = invocationPrincipalId(invocation);
  const [scopeDigest, invocationDigest] = yield* Effect.all([
    hashCanonical(INVOCATION_SCOPE_DIGEST_DOMAIN, invocationScopeMaterial(invocation)),
    hashCanonical(
      INVOCATION_DIGEST_DOMAIN,
      invocationDigestMaterial(invocation, operationVersion),
    ),
  ]);
  return Object.freeze({
    version: INVOCATION_RECEIPT_VERSION,
    principalId,
    invocationId,
    scopeDigest,
    operationVersion,
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
  stored.operationVersion === prepared.operationVersion &&
  stored.invocationDigest === prepared.invocationDigest;

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key));
};

const isReplayTargetPostCommit = (
  value: unknown,
): value is NonNullable<InvocationReplayFenceV1["target"]>["postCommit"] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "visible") {
    return hasExactKeys(record, ["kind"]);
  }
  if (
    record.kind === "absent" &&
    typeof record.authorizationDigest === "string" &&
    DIGEST_RE.test(record.authorizationDigest) &&
    Array.isArray(record.authorizationReadSet) &&
    isAuthorizationReadSet(record.authorizationReadSet)
  ) {
    return hasExactKeys(record, [
      "kind",
      "authorizationDigest",
      "authorizationReadSet",
    ]);
  }
  return record.kind === "hidden" &&
    typeof record.authorizationDigest === "string" &&
    DIGEST_RE.test(record.authorizationDigest) &&
    hasExactKeys(record, ["kind", "authorizationDigest"]);
};

const isAuthorizationReadSet = (value: readonly unknown[]): boolean => {
  const keys = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }
    const record = item as Record<string, unknown>;
    if (!Number.isSafeInteger(record.eid) || (record.eid as number) < 0) {
      return false;
    }
    let key: string;
    if (record.kind === "type" || record.kind === "exists") {
      if (!hasExactKeys(record, ["kind", "eid"])) return false;
      key = `${record.kind}:${record.eid as number}`;
    } else if (
      record.kind === "field" && typeof record.ident === "string" &&
      record.ident.length > 0 && hasExactKeys(record, ["kind", "eid", "ident"])
    ) {
      key = `field:${record.eid as number}:${record.ident}`;
    } else {
      return false;
    }
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
};

const isFenceEntity = (value: unknown): value is NonNullable<
  InvocationReplayFenceV1["target"]
> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.eid) && (record.eid as number) >= 0 &&
    typeof record.type === "string" && record.type.length > 0 &&
    (record.referenceEid === null ||
      (Number.isSafeInteger(record.referenceEid) &&
        (record.referenceEid as number) >= 0)) &&
    isReplayTargetPostCommit(record.postCommit) &&
    hasExactKeys(record, ["eid", "type", "referenceEid", "postCommit"]);
};

const isInvocationReplayFence = (
  value: unknown,
): value is InvocationReplayFenceV1 => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 || !Array.isArray(record.consumedRefs) ||
    (record.target !== undefined && !isFenceEntity(record.target)) ||
    !hasExactKeys(record, [
      "version",
      ...(record.target === undefined ? [] : ["target"]),
      "consumedRefs",
    ])
  ) return false;
  const paths = new Set<string>();
  for (const item of record.consumedRefs) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }
    const consumed = item as Record<string, unknown>;
    if (
      !Array.isArray(consumed.path) ||
      !consumed.path.every((segment) =>
        (typeof segment === "string" && segment.length > 0) ||
        (typeof segment === "number" &&
          Number.isSafeInteger(segment) && segment >= 0)
      ) ||
      !Number.isSafeInteger(consumed.eid) || (consumed.eid as number) < 0 ||
      typeof consumed.type !== "string" || consumed.type.length === 0 ||
      !hasExactKeys(consumed, ["path", "eid", "type"])
    ) return false;
    const key = JSON.stringify(consumed.path);
    if (paths.has(key)) return false;
    paths.add(key);
  }
  return true;
};

const snapshotInvocationReplayFence = (
  value: InvocationReplayFenceV1,
): InvocationReplayFenceV1 => {
  if (!isInvocationReplayFence(value)) {
    throw new TypeError("completed invocation receipt needs a valid replay fence");
  }
  return Object.freeze({
    version: 1,
    ...(value.target === undefined
      ? {}
      : {
        target: Object.freeze({
          eid: value.target.eid,
          type: value.target.type,
          referenceEid: value.target.referenceEid,
          postCommit: value.target.postCommit.kind === "absent"
            ? Object.freeze({
              kind: "absent" as const,
              authorizationDigest: value.target.postCommit.authorizationDigest,
              authorizationReadSet: Object.freeze(
                value.target.postCommit.authorizationReadSet.map((entry) =>
                  Object.freeze({ ...entry })
                ),
              ),
            })
            : Object.freeze({ ...value.target.postCommit }),
        }),
      }),
    consumedRefs: Object.freeze(value.consumedRefs.map((ref) =>
      Object.freeze({
        path: Object.freeze([...ref.path]),
        eid: ref.eid,
        type: ref.type,
      })
    )),
  });
};

const isScope = (
  value: unknown,
): value is InvocationAllocationMappingsV1["scope"] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.server === "string" && record.server.length > 0 &&
    typeof record.principal === "string" && record.principal.length > 0 &&
    typeof record.database === "string" && record.database.length > 0 &&
    hasExactKeys(record, ["server", "principal", "database"]);
};

const isAllocationMappings = (
  value: unknown,
): value is InvocationAllocationMappingsV1 => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 || !Array.isArray(record.entries) ||
    typeof record.keyId !== "string" || record.keyId.length === 0 ||
    !isScope(record.scope) ||
    !hasExactKeys(record, ["version", "keyId", "scope", "entries"])
  ) return false;
  const slots = new Set<string>();
  const refs = new Set<string>();
  for (const entry of record.entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const mapping = entry as Record<string, unknown>;
    if (
      !isAllocationSlotName(mapping.slot) || !isClientRef(mapping.clientRef) ||
      typeof mapping.entityId !== "string" || mapping.entityId.length === 0 ||
      mapping.entityId.length > MAX_SEALED_HANDLE_LENGTH ||
      !hasExactKeys(mapping, ["slot", "clientRef", "entityId"])
    ) return false;
    if (slots.has(mapping.slot) || refs.has(mapping.clientRef)) return false;
    slots.add(mapping.slot);
    refs.add(mapping.clientRef);
  }
  return true;
};

const snapshotAllocationMappings = (
  value: InvocationAllocationMappingsV1,
): InvocationAllocationMappingsV1 => {
  if (!isAllocationMappings(value)) {
    throw new TypeError("completed invocation receipt has invalid allocation mappings");
  }
  return Object.freeze({
    version: 1,
    keyId: value.keyId,
    scope: Object.freeze({
      server: value.scope.server,
      principal: value.scope.principal,
      database: value.scope.database,
    }),
    entries: Object.freeze(value.entries.map((entry) =>
      Object.freeze({
        slot: entry.slot,
        clientRef: entry.clientRef,
        entityId: entry.entityId,
      })
    )),
  });
};

export const decideInvocationReceipt = (
  stored: StoredInvocationReceipt | LegacyInvocationReceiptRow | undefined,
  prepared: PreparedInvocationReceipt,
): InvocationReceiptDecision => {
  if (stored !== undefined && isLegacyInvocationReceiptRow(stored)) {
    return { _tag: "UpdateRequired" };
  }
  if (stored !== undefined && stored.operationVersion !== prepared.operationVersion) {
    return { _tag: "OperationChanged" };
  }
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
        replayFence: snapshotInvocationReplayFence(event.replayFence),
        ...(event.allocations === undefined ? {} : {
          allocations: snapshotAllocationMappings(event.allocations),
        }),
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
): PublicInvocationReceipt => Object.freeze({
  version: INVOCATION_RECEIPT_VERSION,
  invocationId: receipt.invocationId,
  status: receipt.status,
});

export const invocationReceiptOutcome = (
  receipt: TerminalInvocationReceipt,
): InvocationReceiptOutcome => {
  const publicReceipt = publicInvocationReceipt(receipt);
  switch (receipt.status) {
    case "completed":
      return {
        _tag: "Completed",
        receipt: publicReceipt as PublicInvocationReceipt & {
          readonly status: "completed";
        },
        committedT: receipt.committedT,
        output: receipt.output,
        ...(receipt.allocations === undefined ? {} : {
          mappings: Object.freeze(receipt.allocations.entries.map((entry) =>
            Object.freeze({
              clientRef: entry.clientRef,
              entityId: entry.entityId,
            })
          )),
        }),
      };
    case "rejected":
      return {
        _tag: "Rejected",
        receipt: publicReceipt as PublicInvocationReceipt & {
          readonly status: "rejected";
        },
        rejection: receipt.rejection,
      };
    case "failed":
      return {
        _tag: "Failed",
        receipt: publicReceipt as PublicInvocationReceipt & {
          readonly status: "failed";
        },
      };
    case "indeterminate":
      return {
        _tag: "Indeterminate",
        receipt: publicReceipt as PublicInvocationReceipt & {
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
  typeof value.operationVersion === "string" &&
  DIGEST_RE.test(value.operationVersion) &&
  typeof value.invocationDigest === "string" &&
  DIGEST_RE.test(value.invocationDigest);

const IDENTITY_KEYS = Object.freeze([
  "version",
  "principalId",
  "invocationId",
  "scopeDigest",
  "operationVersion",
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

export type LegacyInvocationReceiptRow = {
  readonly _tag: "LegacyInvocationReceipt";
  readonly version: number;
};

export const isLegacyInvocationReceiptRow = (
  value: StoredInvocationReceipt | LegacyInvocationReceiptRow,
): value is LegacyInvocationReceiptRow =>
  (value as Partial<LegacyInvocationReceiptRow>)._tag === "LegacyInvocationReceipt";

const isLegacyInvocationReceipt = (
  record: Record<string, unknown>,
): boolean =>
  typeof record.version === "number" &&
  LEGACY_INVOCATION_RECEIPT_VERSIONS.includes(record.version) &&
  typeof record.principalId === "string" && record.principalId.length > 0 &&
  typeof record.invocationId === "string" && record.invocationId.length > 0 &&
  typeof record.status === "string";

export const parseStoredInvocationReceipt = (
  value: unknown,
): StoredInvocationReceipt | LegacyInvocationReceiptRow => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid durable invocation receipt");
  }
  const record = value as Record<string, unknown>;
  if (isLegacyInvocationReceipt(record)) {
    return Object.freeze({
      _tag: "LegacyInvocationReceipt" as const,
      version: record.version as number,
    });
  }
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
    isInvocationReplayFence(record.replayFence) &&
    (record.allocations === undefined || isAllocationMappings(record.allocations)) &&
    hasExactKeys(record, [
      ...IDENTITY_KEYS,
      "committedT",
      "output",
      "replayFence",
      ...(record.allocations === undefined ? [] : ["allocations"]),
    ])
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

const isPublicMappings = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false;
  const refs = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const mapping = entry as Record<string, unknown>;
    if (
      !isClientRef(mapping.clientRef) || !isEntityId(mapping.entityId) ||
      !hasExactKeys(mapping, ["clientRef", "entityId"])
    ) return false;
    if (refs.has(mapping.clientRef)) return false;
    refs.add(mapping.clientRef);
  }
  return true;
};

const isOutputRefPaths = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every((path) =>
    Array.isArray(path) && path.every((segment) =>
      (typeof segment === "string" && segment.length > 0) ||
      (typeof segment === "number" && Number.isSafeInteger(segment) &&
        segment >= 0)
    )
  );

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
    result._tag === "OperationChanged" && hasExactKeys(result, ["_tag"])
  ) return { _tag: "OperationChanged" };
  if (
    result._tag === "UpdateRequired" && hasExactKeys(result, ["_tag"])
  ) return { _tag: "UpdateRequired" };
  if (
    result._tag === "Completed" &&
    hasPublicReceipt(result.receipt, invocationId, "completed") &&
    Number.isSafeInteger(result.committedT) && (result.committedT as number) >= 0 &&
    Object.hasOwn(result, "output") &&
    (result.mappings === undefined || isPublicMappings(result.mappings)) &&
    (result.outputRefPaths === undefined ||
      isOutputRefPaths(result.outputRefPaths)) &&
    hasExactKeys(result, [
      "_tag",
      "receipt",
      "committedT",
      "output",
      ...(result.mappings === undefined ? [] : ["mappings"]),
      ...(result.outputRefPaths === undefined ? [] : ["outputRefPaths"]),
    ])
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
