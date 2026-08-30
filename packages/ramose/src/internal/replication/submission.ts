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
 * Classify one `/op` answer into the queue's own vocabulary.
 *
 * Fail-open is not an option in either direction: an answer this build cannot
 * interpret is `Retry`, never a silent commit and never a silent drop.
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
    const mappings = readMappings(record, body.mappings);
    if (mappings === undefined) return RETRY("malformed");
    const output = body.result === undefined
      ? null
      : body.result as JsonValue;
    return Object.freeze({ _tag: "Committed", output, mappings });
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
      // The same id was already used for a different intent. The durable
      // receipt that exists is the authoritative one, and this record can
      // never become it.
      case "invocation_conflict":
        return REJECTED("invocation_conflict");
      default:
        return REJECTED(code ?? "request_rejected");
    }
  }
  if (status === 400) return REJECTED("invalid_request");
  if (status === 401 || status === 403) return REJECTED("unauthorized");
  // A durable `failed` receipt is terminal on the server: retrying replays the
  // same answer forever, so it is terminal here too.
  if (status === 500 && code === "invocation_failed") {
    return REJECTED("invocation_failed");
  }
  if (status === 503 || status === 429) return RETRY("unavailable");
  if (status >= 500) return RETRY("unavailable");
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
  return Object.freeze(await Promise.all(plans.map(async (plan) => {
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
  })));
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
