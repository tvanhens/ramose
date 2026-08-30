/**
 * Durable, transport-neutral receipts for authoritative operation invocations.
 *
 * The per-database Transactor owns persistence and execution. This module owns
 * only the canonical identity, pure state machine, replay decision, and sealed
 * public projection shared by every transport that invokes that writer.
 */

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

/**
 * Durable receipt generation. v2 scopes invocation compatibility to the
 * operation-scoped {@link OperationVersion} instead of the deployment-wide
 * catalog key and unit hash that v1 digested (#487).
 */
export const INVOCATION_RECEIPT_VERSION = 2 as const;
/** Pre-correction rows. Never re-executed, never silently cleared. */
export const LEGACY_INVOCATION_RECEIPT_VERSIONS: readonly number[] = [1];
export const MAX_INVOCATION_ID_LENGTH = 256;
/**
 * A bound on a stored sealed handle, not a format decision. The v1 envelope is
 * 55 characters; this is far above anything a future codec would plausibly
 * produce, so widening the codec never has to revisit it.
 */
const MAX_SEALED_HANDLE_LENGTH = 4096;

/** Receipt wrapper around the existing authoritative operation input. */
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

/**
 * The complete receipt visible to callers. Internal scope, operation version,
 * and digests stay sealed; `version` is the durable receipt generation.
 */
export type PublicInvocationReceipt = {
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
  /**
   * Operation-scoped compatibility version this receipt was claimed under.
   * Stored beside the digest so a later operation change is a deterministic
   * `OperationChanged`, never an indistinguishable digest conflict.
   */
  readonly operationVersion: OperationVersion;
  /** Operation version, owner/local name, target, and input. No deployment identity. */
  readonly invocationDigest: string;
};

export type ClaimedInvocationReceipt = InvocationReceiptIdentity & {
  readonly status: "claimed";
};

export type InvocationReplayFenceV1 = {
  readonly version: 1;
  /** Original resolved target plus its exact post-commit admission state. */
  readonly target?: {
    readonly eid: number;
    readonly type: string;
    /** Resolution of the original numeric/ident/lookup ref after the commit. */
    readonly referenceEid: number | null;
    readonly postCommit:
      | { readonly kind: "visible" }
      | {
        readonly kind: "absent";
        readonly authorizationDigest: string;
        /** Non-target policy observations admitted before self-deletion. */
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
        /** Digest of every database observation used by read-policy denial. */
        readonly authorizationDigest: string;
      };
  };
  /** Original input-ref slots made absent by this invocation. */
  readonly consumedRefs: readonly {
    readonly path: readonly (string | number)[];
    readonly eid: number;
    readonly type: string;
  }[];
};

/**
 * Exact `{ clientRef, entityId }` mappings for the named allocation slots this
 * invocation declared (#475).
 *
 * A *versioned extension* of the one durable receipt: same table, same key,
 * same state machine, same replay path. It is present only on a completed
 * receipt for an invocation that actually bound slots, so every receipt written
 * before this extension existed parses unchanged and replays unchanged.
 *
 * Handles are sealed. A numeric eid never reaches a receipt, a replay, or any
 * public projection of either.
 */
export type InvocationAllocationMappingsV1 = {
  readonly version: 1;
  /**
   * The sealing key epoch and the stable scope these handles were minted
   * under.
   *
   * The receipt's own identity cannot stand in for them. Its scope digest
   * covers the database and the verified claims, but not the public origin the
   * request arrived on and not the server sealing key — both of which the
   * sealed handle *is* bound to. Without these, a replay after a key rotation,
   * or through a second origin, would hand back handles that cannot be opened
   * in the caller's current scope and the client would durably persist client
   * ref mappings it can never resolve. Replay compares them and quarantines
   * instead.
   */
  readonly keyId: string;
  readonly scope: {
    readonly server: string;
    readonly principal: string;
    readonly database: string;
  };
  readonly entries: readonly {
    readonly slot: string;
    readonly clientRef: string;
    /** The sealed public handle. Never a numeric eid. */
    readonly entityId: string;
  }[];
};

/**
 * Whether a stored mapping extension is still openable by the caller that is
 * replaying it. A mismatch is not a denial — the receipt is genuine and the
 * caller is authorized — it is the typed, data-free update-required answer.
 *
 * Three ways it can fail, and all three mean the same thing to the caller:
 * the epoch moved, the scope moved, or the handles were written by an
 * entity-id codec this build cannot read. The last is the rollback case: a
 * newer codec wrote the receipt, the service was rolled back, and the stored
 * handles are shaped for a codec this build does not have. Answering
 * update-required is what lets the client mint a fresh invocation instead of
 * retrying forever against a row it can never consume.
 */
export const allocationMappingsResolvable = (
  mappings: InvocationAllocationMappingsV1,
  current: EpochBoundScope,
): boolean =>
  // The same comparison every other participant makes: a stored mapping is an
  // epoch-bound scope like any other, and the receipt records it precisely so
  // this can be asked.
  sameEpochScope(mappings, current) &&
  // And every handle must say so itself. The recorded epoch is not believed on
  // its own — the same rule the client's durable mapping store applies — so a
  // row whose `keyId` was rewritten cannot present handles this build has no
  // key for. The preamble carries both facts, and reading it is what
  // distinguishes "openable" from merely "the right shape": a newer codec may
  // keep this envelope length and change only its version byte, and those
  // handles must quarantine rather than be handed back unusable.
  mappings.entries.every((entry) => {
    const envelope = entityIdEnvelope(entry.entityId);
    return envelope !== undefined &&
      envelope.codecVersion === ENTITY_ID_CODEC &&
      envelope.keyId === current.keyId;
  });

export type CompletedInvocationReceipt = InvocationReceiptIdentity & {
  readonly status: "completed";
  /** Private writer position used only for cache invalidation. Never public. */
  readonly committedT: number;
  /** Exact JSON output materialized by the deployed operation codec before commit. */
  readonly output: unknown;
  /** Private, data-only exemption for absences caused by this exact commit. */
  readonly replayFence: InvocationReplayFenceV1;
  /** Absent when this invocation bound no allocation slots. */
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
    /** The stored row belongs to a different version of this operation. */
    readonly _tag: "OperationChanged";
  }
  | {
    /** A pre-correction row: not replayable, not re-executable, not cleared. */
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
    /** Omitted when this invocation bound no allocation slots (#475). */
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
    /**
     * Exact `{ clientRef, entityId }` mappings, sealed. Present only when this
     * invocation bound allocation slots; an exact replay returns the same
     * mappings without a second commit (#475).
     */
    readonly mappings?: readonly {
      readonly clientRef: string;
      readonly entityId: string;
    }[];
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

/**
 * Transport-neutral refusals that carry no receipt because they had no
 * effect. `OperationChanged` means the supplied or stored
 * {@link OperationVersion} is not the currently deployed one;
 * `UpdateRequired` means a pre-correction receipt row exists and this caller
 * must mint a fresh invocation instead. Both are sealed: neither names the
 * deployed operation, and both are only reachable once admission has already
 * established that this caller may see the operation (#419).
 */
export type AuthoritativeInvocationResult =
  | InvocationReceiptOutcome
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "OperationChanged" }
  | { readonly _tag: "UpdateRequired" };

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

/**
 * Pure authorization claim view; ordinary JWT renewal leaves it unchanged.
 * Class order and duplicates are preserved because trusted operation code sees
 * the first verified class as `op.principal.class`.
 */
export const invocationScopeMaterial = (
  invocation: AuthoritativeOperationInvocation,
): JsonValue => ({
  version: INVOCATION_RECEIPT_VERSION,
  database: invocation.database,
  principal: {
    claims: invocation.caller.claims,
    classes: [...invocation.caller.classes],
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

/**
 * Pure canonical invocation material. No callback/source/executable can enter
 * it, and neither can deployment identity: the operation is named by its
 * operation-scoped {@link OperationVersion}, so an identical invocation stays
 * compatible across redeploys and unrelated catalog changes. The deployed
 * `catalogKey`/`unitHash` remain a separate private execution fence.
 */
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
  // The ordered `{ slot, clientRef }` binding this invocation supplied (#475).
  // The *declaration* — slot names and their output paths — is already covered
  // through `operationVersion` by descriptor generation 2; this covers which
  // durable client identity each slot was promised to, so the same invocation
  // id reused with a different binding is an ordinary conflict rather than a
  // silent rebinding of a durable client ref to a different entity.
  //
  // Omitted entirely when nothing is bound, so an invocation that allocates
  // nothing digests exactly as it did before this field existed and every
  // receipt already stored stays replayable.
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

/**
 * A caller may pin the operation version its invocation was minted against.
 * Anything that is not a canonical digest is an ordinary invalid request, not
 * a compatibility answer.
 */
export const requireSuppliedOperationVersion = (
  value: unknown,
): OperationVersion | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    throw invalid("operationVersion must be a canonical operation version digest");
  }
  return OperationVersion.make(value);
};

/**
 * Canonicalize and hash the exact scope and invocation before a durable
 * claim. `operationVersion` is the version of the *currently deployed*
 * operation, resolved by the caller before preparing.
 */
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

/**
 * Strict validation of the mapping extension, applied on the way in *and* on
 * the way out of durable storage.
 *
 * Slots and client refs are both unique: a slot names exactly one entity and a
 * client ref names exactly one entity, so either duplicate would make the
 * durable mapping ambiguous in precisely the way this design exists to
 * prevent. Handles are checked for the sealed wire shape, so a numeric eid can
 * never be written into a receipt even by a defect above this line.
 */
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
      // A *string* handle, deliberately not this codec's envelope shape. The
      // row is our own writing, so shape strictness here buys nothing and
      // costs forward compatibility: a receipt written by a newer entity-id
      // codec and then read after a rollback must be recognized and answered
      // `update-required` by {@link allocationMappingsResolvable}, not thrown
      // away as corruption before the replay decision can be reached. The
      // type check is what keeps a numeric eid out, and that is the guarantee
      // that matters here.
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

/**
 * Pure claim/replay/conflict/recovery decision for one durable key.
 *
 * Order matters. A pre-correction row is `UpdateRequired` before anything
 * else, so it is never cleared and never re-executed under the corrected
 * digest. A row claimed under a different operation version is
 * `OperationChanged` rather than a bare conflict, because the caller's
 * invocation is still well-formed — the operation moved underneath it.
 */
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

/** Project a durable terminal record into the one transport-neutral outcome. */
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
        // The slot name stays private to the durable row: the caller supplied
        // the `{ slot, clientRef }` binding, so `clientRef` is the half it
        // needs back, and the mapping is exactly what a replay returns again.
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

/**
 * A durable row written before the operation-scoped correction. It is
 * recognized, never rewritten, and never re-executed; a replay that reaches
 * one is `UpdateRequired`.
 */
export type LegacyInvocationReceiptRow = {
  readonly _tag: "LegacyInvocationReceipt";
  readonly version: number;
};

/** Durable rows are either the current generation or a recognized legacy one. */
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

/** Fail closed on malformed durable rows; never reinterpret corruption as a miss. */
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
    // Absent on every receipt written before the extension existed, and on
    // every invocation that binds no slots. Present but malformed is a
    // corrupt row, never an absent mapping.
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

/**
 * The public mapping projection, validated on the Worker side of the internal
 * hop. Sealed handles only: a numeric eid crossing this boundary is a rejected
 * result, not a coerced one.
 */
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
    hasExactKeys(result, [
      "_tag",
      "receipt",
      "committedT",
      "output",
      ...(result.mappings === undefined ? [] : ["mappings"]),
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
