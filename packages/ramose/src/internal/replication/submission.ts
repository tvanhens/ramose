/**
 * Per-database FIFO submission of the durable outbox (#475 slice 2).
 *
 * ## What submission is allowed to change
 *
 * Nothing durable, until an acknowledgement arrives. A queued record naming an
 * unmapped {@link ClientRef} waits exactly where it is; once its mapping lands,
 * the *submitted* body carries the sealed handle in that position. The durable
 * row is never rewritten — history stays what the client actually intended, and
 * the substitution is a projection of it, computed fresh from the mappings that
 * exist at the moment of submission. A rewrite would make the durable record
 * and the invocation digest disagree the moment a mapping changed, and the
 * whole point of the digest is that they cannot.
 *
 * ## Ordering
 *
 * One head per receiver database per pass, and only the head. That is FIFO, and
 * it is why a blocked, quarantined, or unreadable head holds its own database
 * and no other: every database's head is decided from its own plan, and the
 * databases are driven concurrently.
 *
 * ## Acknowledgement
 *
 * Every terminal answer is persisted in exactly one client transaction — the
 * receipt with its output and mappings, the removal of the submitted outbox
 * row, and, for a commit, the internal `committed-unobserved` marker. A crash
 * cut anywhere in that transaction leaves the invocation queued, and the next
 * pass resubmits it and consumes #487's exact replay: the same receipt, the
 * same mappings, no second commit.
 *
 * A non-terminal answer changes nothing durable and is reported as a typed
 * queue state. `operation_changed` and `invocation_update_required` are never
 * silent drops: the record stays queued and the caller is told why.
 */

import type { JsonValue } from "../authorization/json.ts";
import type { AllocationPathSegment } from "../../db/allocations.ts";
import {
  isClientRef,
  isEntityId,
  type ClientRef,
  type EntityId,
  type InvocationId,
} from "../../db/refs.ts";
import type { ReplicaDatabaseScope } from "./replica-lifecycle.ts";
import {
  mappingKey,
  type OutboxPartitionPlan,
  type OutboxRecord,
  type QueuedMapping,
  type QuarantineReason,
} from "./outbox.ts";

/**
 * Everything the live session knows about one receiver database that a durable
 * queue record deliberately does not persist: where it is, who this client is
 * to it, and which deployed catalog unit is currently answering.
 *
 * The unit hash rotates on every deploy, so persisting it would expire an
 * offline queue for no semantic reason — the durable record pins the
 * operation-scoped {@link OperationVersion} instead, and that is what the
 * server compares.
 */
export type MutationEndpoint = {
  readonly origin: string;
  /** The public root database name, as the URL spells it. */
  readonly database: string;
  /** Graph path from that root to the receiver; empty for the root itself. */
  readonly graphPath: readonly string[];
  readonly credential: string;
  /** The currently deployed catalog proof this session is authenticated for. */
  readonly catalog: string;
  readonly unitHash: string;
};

/**
 * Resolve one receiver's endpoint, or `undefined` when this client has no live
 * session for it. `undefined` is ordinary: it means offline, and the queue
 * simply holds.
 */
export type MutationEndpointResolver = (
  receiver: ReplicaDatabaseScope,
) => MutationEndpoint | undefined;

/** The exact `/op` request one queued record submits. */
export type MutationRequest = {
  readonly endpoint: MutationEndpoint;
  readonly body: Readonly<Record<string, unknown>>;
};

/** The raw answer, however it arrived. A transport failure is not a status. */
export type MutationResponse =
  | { readonly _tag: "Response"; readonly status: number; readonly body: unknown }
  | { readonly _tag: "Unreachable" };

export type MutationTransport = (
  request: MutationRequest,
  signal?: AbortSignal,
) => Promise<MutationResponse>;

/**
 * Write one value at a declared position of a JSON snapshot, structurally.
 *
 * The declared positions were validated against this exact snapshot when the
 * record was built, so the path exists; anything else is refused rather than
 * created, because inventing a position would submit an input the durable
 * record never described.
 */
const writeAtPath = (
  value: JsonValue,
  path: readonly AllocationPathSegment[],
  replacement: JsonValue,
): JsonValue => {
  const [head, ...rest] = path;
  if (head === undefined) return replacement;
  if (typeof head === "number") {
    if (!Array.isArray(value) || head >= value.length) {
      throw new TypeError("declared input position is not an array index");
    }
    const copy = [...value];
    copy[head] = writeAtPath(value[head]!, rest, replacement);
    return copy;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("declared input position is not an object property");
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  if (!Object.hasOwn(record, head)) {
    throw new TypeError("declared input position is absent");
  }
  return { ...record, [head]: writeAtPath(record[head]!, rest, replacement) };
};

/** The resolved handle a client ref maps to, or `undefined` while unmapped. */
export type MappedHandles = ReadonlyMap<string, EntityId>;

export type SubstitutedInvocation = {
  readonly target: EntityId | undefined;
  readonly input: JsonValue;
};

/**
 * Replace every {@link ClientRef} this record depends on with the sealed
 * handle it now maps to, in the target and at each declared input position.
 *
 * Returns `undefined` when any dependency is still unmapped — the record is
 * blocked and must not be submitted. A ref already carrying a sealed handle is
 * left exactly as the durable row holds it.
 */
export const substituteMutationRefs = (
  record: OutboxRecord,
  handles: MappedHandles,
): SubstitutedInvocation | undefined => {
  const resolve = (ref: ClientRef): EntityId | undefined =>
    handles.get(mappingKey(record.partition, ref));
  let target: EntityId | undefined;
  if (record.target.type === "entity") {
    target = record.target.entityId;
  } else if (record.target.type === "client-ref") {
    target = resolve(record.target.clientRef);
    if (target === undefined) return undefined;
  }
  let input = record.input;
  for (const use of record.inputRefs) {
    if (!isClientRef(use.ref)) continue;
    const handle = resolve(use.ref);
    if (handle === undefined) return undefined;
    input = writeAtPath(input, use.path, handle);
  }
  return Object.freeze({ target, input });
};

/** Build the exact `/op` body for one ready record. */
export const buildMutationRequest = (
  record: OutboxRecord,
  endpoint: MutationEndpoint,
  substituted: SubstitutedInvocation,
): MutationRequest => Object.freeze({
  endpoint,
  body: Object.freeze({
    // The proof of the deployment currently answering, from the live session.
    catalog: endpoint.catalog,
    unitHash: endpoint.unitHash,
    ...(endpoint.graphPath.length === 0
      ? {}
      : { path: [...endpoint.graphPath] }),
    invocationId: record.invocation,
    // Pinned, so a changed operation contract is a deterministic
    // `operation_changed` rather than an execution against other semantics.
    operationVersion: record.operationVersion,
    operation: {
      owner: { kind: record.operation.owner.kind, name: record.operation.owner.name },
      localName: record.operation.localName,
    },
    ...(substituted.target === undefined ? {} : { target: substituted.target }),
    ...(record.allocations.length === 0 ? {} : {
      allocations: record.allocations.map((allocation) => ({
        slot: allocation.slot,
        clientRef: allocation.clientRef,
      })),
    }),
    input: substituted.input,
  }),
});

/**
 * The typed answer one submission produced.
 *
 * Only `Committed` and `Rejected` are terminal and therefore durable. The other
 * two change nothing: the record stays queued at the head of its database, and
 * the reason is reported rather than swallowed.
 */
export type MutationAcknowledgement =
  | {
    readonly _tag: "Committed";
    readonly output: JsonValue | null;
    readonly mappings: readonly QueuedMapping[];
  }
  | { readonly _tag: "Rejected"; readonly code: string }
  /**
   * The server refused this invocation with no durable receipt bound to it at
   * all — a refusal decided before the claim, so nothing committed and nothing
   * may be recorded as rejected.
   *
   * Deliberately non-terminal: an older client must never destroy durable work
   * because a newer server named a 409 outcome it has not heard of, so the
   * record stays queued and the next pass presents it again. Deliberately not
   * `Retry` either — a pre-claim admission refusal answers the identical
   * request identically, and reporting it as an ordinary retry makes that loop
   * silent, with nothing naming what has to change: the invocation, the
   * caller's authorization, or the deployed operation.
   */
  | { readonly _tag: "Refused"; readonly code: string | undefined }
  | {
    readonly _tag: "UpdateRequired";
    readonly reason: "operation-changed" | "invocation-update-required";
  }
  | {
    readonly _tag: "Retry";
    readonly reason: "unreachable" | "unavailable" | "indeterminate" | "malformed";
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const RETRY = (
  reason: Extract<MutationAcknowledgement, { _tag: "Retry" }>["reason"],
): MutationAcknowledgement => Object.freeze({ _tag: "Retry", reason });

const REJECTED = (code: string): MutationAcknowledgement =>
  Object.freeze({ _tag: "Rejected", code });

/**
 * Read the authoritative mappings out of a completed response.
 *
 * Every slot this record declared must come back with a sealed handle. A
 * missing, duplicated, or non-sealed mapping is not "no mapping": it would
 * leave a client ref this device already registered permanently unresolvable,
 * so the answer is refused as malformed and the record stays queued.
 */
const readMappings = (
  record: OutboxRecord,
  value: unknown,
): readonly QueuedMapping[] | undefined => {
  const expected = new Set(record.allocations.map((allocation) => allocation.clientRef));
  if (value === undefined) return expected.size === 0 ? [] : undefined;
  if (!Array.isArray(value) || value.length !== expected.size) return undefined;
  const mappings: QueuedMapping[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (!isClientRef(entry.clientRef) || !isEntityId(entry.entityId)) return undefined;
    if (!expected.delete(entry.clientRef)) return undefined;
    mappings.push(
      Object.freeze({ clientRef: entry.clientRef, entityId: entry.entityId }),
    );
  }
  return expected.size === 0 ? Object.freeze(mappings) : undefined;
};

/**
 * The durable receipt generation this client understands. A receipt naming
 * another generation is not proof of anything this build can reason about.
 */
const RECEIPT_VERSION = 2;

/**
 * Whether this answer carries a durable receipt for this exact invocation in
 * one of the given states.
 *
 * It is the client's only proof that the server reached a decision it will
 * keep — in *either* direction. Without it a refusal may have been decided
 * before any receipt was written, and a 200 may not be an authoritative commit
 * at all. The queue must not act irreversibly on the strength of a status code
 * alone.
 */
const hasReceipt = (
  record: OutboxRecord,
  body: Record<string, unknown> | undefined,
  states: readonly string[],
): boolean => {
  const receipt = body?.receipt;
  if (!isRecord(receipt)) return false;
  return receipt.version === RECEIPT_VERSION &&
    receipt.invocationId === record.invocation &&
    typeof receipt.status === "string" && states.includes(receipt.status);
};

/** The typed failure a receipt-backed refusal is recorded under. */
const rejectionCode = (
  status: number,
  body: Record<string, unknown> | undefined,
): string => {
  if (typeof body?.code === "string") return body.code;
  if (body?.tag === "OperationRejected") return "operation_rejected";
  if (status === 400) return "invalid_request";
  if (status === 401 || status === 403) return "unauthorized";
  return "request_rejected";
};

/**
 * Classify one `/op` answer into the queue's own vocabulary.
 *
 * Fail-open is not an option in either direction: an answer this build cannot
 * interpret is `Retry`, never a silent commit and never a silent drop.
 *
 * **Every terminal answer needs proof.** Acting on one is irreversible: it
 * removes the durable outbox row, and for an allocating invocation it is also
 * the only chance to recover the authoritative mappings — miss it and every
 * dependent record blocks on a ref nothing can ever resolve. So a commit is
 * accepted only with the durable `completed` receipt for this exact
 * invocation, and only two things are terminal refusals: one the server bound
 * to a durable receipt, and `invocation_conflict`, which says a *different*
 * receipt already owns this id. A status code on its own is never enough in
 * either direction.
 *
 * That matters most for a bare 403. The Worker deliberately answers one, with
 * no receipt, when the caller's lease expires between the authoritative commit
 * and the response — the invocation *did* commit. Treating it as terminal
 * would delete the row and lose the mappings the exact replay would have
 * returned.
 *
 * A 409 code this build does not know is non-terminal for the same reason: a
 * newer server may name a compatibility or indeterminate outcome this client
 * has never heard of, and an older client must not answer that by destroying
 * durable work.
 */
export const classifyMutationResponse = (
  record: OutboxRecord,
  response: MutationResponse,
): MutationAcknowledgement => {
  if (response._tag === "Unreachable") return RETRY("unreachable");
  const { status } = response;
  const body = isRecord(response.body) ? response.body : undefined;
  const code = typeof body?.code === "string" ? body.code : undefined;
  if (status === 200) {
    if (body === undefined) return RETRY("malformed");
    // A commit needs proof exactly as a rejection does. The server's completed
    // answer always carries the durable receipt for this invocation, so a
    // missing, mismatched, or non-completed one means this 200 is not evidence
    // that anything committed — an incompatible server mid-rollout, a proxy, a
    // captive portal. Acknowledging it would irreversibly remove the outbox
    // row for work that may never have happened.
    if (!hasReceipt(record, body, ["completed"])) return RETRY("malformed");
    const mappings = readMappings(record, body.mappings);
    if (mappings === undefined) return RETRY("malformed");
    // An absent `result` is not a spelling of `null`. The completed answer
    // always carries one, and the writer materialized it as exact JSON before
    // the commit, so a missing field means an intermediary or an incompatible
    // server dropped it. Recording `null` as the authoritative output and then
    // removing the only durable copy of the request would corrupt the result
    // with no way left to replay for the real one.
    if (!Object.hasOwn(body, "result")) return RETRY("malformed");
    return Object.freeze({
      _tag: "Committed",
      output: body.result as JsonValue,
      mappings,
    });
  }
  if (status === 409) {
    switch (code) {
      case "operation_changed":
        return Object.freeze({
          _tag: "UpdateRequired",
          reason: "operation-changed",
        });
      case "invocation_update_required":
        return Object.freeze({
          _tag: "UpdateRequired",
          reason: "invocation-update-required",
        });
      // The server does not know yet whether the invocation committed. It is
      // the one answer that must be asked again rather than decided.
      case "invocation_indeterminate":
        return RETRY("indeterminate");
      // The same id already belongs to a different intent. The durable receipt
      // that exists is the authoritative one and this record can never become
      // it, so no retry can change the answer — the one terminal refusal that
      // legitimately carries no receipt of its own.
      case "invocation_conflict":
        return REJECTED("invocation_conflict");
    }
  }
  if (hasReceipt(record, body, ["rejected", "failed"])) {
    return REJECTED(rejectionCode(status, body));
  }
  // A 409 carrying no receipt at all is a refusal decided *before* the claim:
  // the request never reached the one authoritative state machine, so it
  // committed nothing and it will answer the identical request identically.
  // Reported as itself rather than as `Retry`, which would loop forever
  // without ever naming what has to change. A 409 that *does* carry a receipt
  // this build will not act on is a different problem — an answer this client
  // cannot interpret — and stays `Retry`.
  if (status === 409 && body?.receipt === undefined) {
    return Object.freeze({ _tag: "Refused", code });
  }
  if (status === 429 || status >= 500) return RETRY("unavailable");
  // Including a receipt-free 400/401/403: the server may have decided nothing,
  // or may have committed and merely refused to say so.
  return RETRY("malformed");
};

/** What one pass did to one receiver database's queue. */
export type QueueProgress = {
  readonly partition: string;
  readonly receiver: ReplicaDatabaseScope;
  readonly state:
    | { readonly _tag: "Empty" }
    /** No live session for this receiver. The queue holds; nothing is lost. */
    | { readonly _tag: "Offline" }
    | { readonly _tag: "Blocked"; readonly missing: readonly ClientRef[] }
    | {
      readonly _tag: "UpdateRequired";
      readonly invocation: InvocationId;
      readonly reason: QuarantineReason | "operation-changed" | "invocation-update-required";
    }
    | { readonly _tag: "Unreadable"; readonly sequence: number }
    | { readonly _tag: "Committed"; readonly invocation: InvocationId }
    | {
      readonly _tag: "Rejected";
      readonly invocation: InvocationId;
      readonly code: string;
    }
    /**
     * Refused with no durable receipt. The record stays queued and holds its
     * database; only a change to the invocation, the caller's authorization,
     * or the deployed operation can clear it.
     */
    | {
      readonly _tag: "Refused";
      readonly invocation: InvocationId;
      readonly code: string | undefined;
    }
    /**
     * This database's pass did not complete. Nothing durable is claimed in
     * either direction and the next pass decides the same head again; it is
     * reported so one database's failure cannot silently erase what its
     * siblings did in the same pass.
     */
    | { readonly _tag: "Interrupted" }
    | {
      readonly _tag: "Retry";
      readonly invocation: InvocationId;
      readonly reason: Extract<MutationAcknowledgement, { _tag: "Retry" }>["reason"];
    };
};

const progress = (
  partition: string,
  receiver: ReplicaDatabaseScope,
  state: QueueProgress["state"],
): QueueProgress => Object.freeze({ partition, receiver, state });

/**
 * Exactly the surface of the durable outbox this driver uses.
 *
 * Structural rather than nominal only to keep the dependency pointing one way:
 * the IndexedDB adapter imports this module for {@link MutationAcknowledgement}
 * and satisfies this shape. It is not a seam for a substitute store — the
 * durable behavior is proven against real IndexedDB, and nothing here is
 * meaningful without it.
 */
export type SubmissionStore = {
  readonly submissionPlan: (
    scope: { readonly server: string; readonly principal: string },
    keyId?: string,
  ) => Promise<{
    readonly plans: readonly OutboxPartitionPlan[];
    readonly handles: MappedHandles;
  }>;
  readonly acknowledge: (
    record: OutboxRecord,
    acknowledgement: Extract<
      MutationAcknowledgement,
      { _tag: "Committed" } | { _tag: "Rejected" }
    >,
  ) => Promise<unknown>;
};

export type SubmissionPass = {
  readonly store: SubmissionStore;
  readonly scope: { readonly server: string; readonly principal: string };
  readonly endpoints: MutationEndpointResolver;
  readonly transport: MutationTransport;
  /** The sealing epoch the current authenticated session confirmed, if any. */
  readonly keyId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
};

/**
 * Drive one submission pass: at most one head per receiver database.
 *
 * Databases are driven concurrently and decided independently, so a blocked or
 * quarantined head in one never delays another. Within a database only the head
 * moves, which is what preserves FIFO across a restart.
 */
export const runSubmissionPass = async (
  pass: SubmissionPass,
): Promise<readonly QueueProgress[]> => {
  const { plans, handles } = await pass.store.submissionPlan(
    pass.scope,
    pass.keyId,
  );
  // Settled, not `all`. Databases are decided independently, so one durable
  // write that throws must not discard what every sibling database did in the
  // same pass — that progress is the only report the caller gets, and the work
  // behind it is already durable.
  const settled = await Promise.allSettled(plans.map(async (plan) => {
    const { head, partition, receiver } = plan;
    switch (head.type) {
      case "empty":
        return progress(partition, receiver, { _tag: "Empty" });
      case "blocked":
        return progress(partition, receiver, {
          _tag: "Blocked",
          missing: head.missing,
        });
      case "update-required":
        return progress(partition, receiver, {
          _tag: "UpdateRequired",
          invocation: head.record.invocation,
          reason: head.reason,
        });
      case "unreadable":
        return progress(partition, receiver, {
          _tag: "Unreadable",
          sequence: head.sequence,
        });
      case "ready":
        return submitHead(pass, plan.receiver, head.record, handles);
    }
  }));
  return Object.freeze(settled.map((outcome, index) => {
    if (outcome.status === "fulfilled") return outcome.value;
    const plan = plans[index]!;
    return progress(plan.partition, plan.receiver, { _tag: "Interrupted" });
  }));
};

const submitHead = async (
  pass: SubmissionPass,
  receiver: ReplicaDatabaseScope,
  record: OutboxRecord,
  handles: MappedHandles,
): Promise<QueueProgress> => {
  const endpoint = pass.endpoints(receiver);
  if (endpoint === undefined) {
    return progress(record.partition, receiver, { _tag: "Offline" });
  }
  const substituted = substituteMutationRefs(record, handles);
  if (substituted === undefined) {
    // The plan and the handles come from one transaction, so this is only
    // reachable if the two disagreed; hold rather than submit a ref-shaped
    // input the server would read as an opaque scalar.
    return progress(record.partition, receiver, {
      _tag: "Blocked",
      missing: Object.freeze([]),
    });
  }
  const response = await pass.transport(
    buildMutationRequest(record, endpoint, substituted),
    pass.signal,
  );
  const acknowledgement = classifyMutationResponse(record, response);
  switch (acknowledgement._tag) {
    case "Committed":
      await pass.store.acknowledge(record, acknowledgement);
      return progress(record.partition, receiver, {
        _tag: "Committed",
        invocation: record.invocation,
      });
    case "Rejected":
      await pass.store.acknowledge(record, acknowledgement);
      return progress(record.partition, receiver, {
        _tag: "Rejected",
        invocation: record.invocation,
        code: acknowledgement.code,
      });
    case "Refused":
      return progress(record.partition, receiver, {
        _tag: "Refused",
        invocation: record.invocation,
        code: acknowledgement.code,
      });
    case "UpdateRequired":
      return progress(record.partition, receiver, {
        _tag: "UpdateRequired",
        invocation: record.invocation,
        reason: acknowledgement.reason,
      });
    case "Retry":
      return progress(record.partition, receiver, {
        _tag: "Retry",
        invocation: record.invocation,
        reason: acknowledgement.reason,
      });
  }
};
