import { isReplicationSettlement } from "./protocol.ts";
import type { JsonValue } from "../authorization/json.ts";
import type { AllocationPathSegment } from "../../db/allocations.ts";
import {
  isClientRef,
  isEntityId,
  type ClientRef,
  type EntityId,
  type InvocationId,
} from "../../db/refs.ts";
import { isLeadershipKey } from "./leadership.ts";
import type { ReplicaDatabaseScope } from "./replica-lifecycle.ts";
import {
  mappingKey,
  type OutboxPartitionPlan,
  type OutboxRecord,
  type QueuedMapping,
  type QuarantineReason,
} from "./outbox.ts";

export type MutationEndpoint = {
  readonly origin: string;
  readonly database: string;
  readonly graphPath: readonly string[];
  readonly credential: string;
};

export type MutationEndpointResolver = (
  receiver: ReplicaDatabaseScope,
) => MutationEndpoint | undefined;

export type MutationRequest = {
  readonly endpoint: MutationEndpoint;
  readonly body: Readonly<Record<string, unknown>>;
};

export type MutationResponse =
  | { readonly _tag: "Response"; readonly status: number; readonly body: unknown }
  | { readonly _tag: "Unreachable" };

export type MutationTransport = (
  request: MutationRequest,
  signal?: AbortSignal,
) => Promise<MutationResponse>;

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

export type MappedHandles = ReadonlyMap<string, EntityId>;

export type SubstitutedInvocation = {
  readonly target: EntityId | undefined;
  readonly input: JsonValue;
};

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

export const buildMutationRequest = (
  record: OutboxRecord,
  endpoint: MutationEndpoint,
  substituted: SubstitutedInvocation,
): MutationRequest => Object.freeze({
  endpoint,
  body: Object.freeze({
    ...(endpoint.graphPath.length === 0
      ? {}
      : { at: [...endpoint.graphPath] }),
    invocationId: record.invocation,
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

export type MutationAcknowledgement =
  | {
    readonly _tag: "Committed";
    readonly settled: number;
    readonly output: JsonValue | null;
    readonly mappings: readonly QueuedMapping[];
  }
  | { readonly _tag: "Rejected"; readonly code: string }
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

const RECEIPT_VERSION = 2;

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
    if (!hasReceipt(record, body, ["completed"])) return RETRY("malformed");
    const mappings = readMappings(record, body.mappings);
    if (mappings === undefined) return RETRY("malformed");
    if (!Object.hasOwn(body, "result")) return RETRY("malformed");
    if (!isReplicationSettlement(body.settled) || body.settled === 0) {
      return RETRY("malformed");
    }
    return Object.freeze({
      _tag: "Committed",
      settled: body.settled as number,
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
      case "invocation_indeterminate":
        return RETRY("indeterminate");
      case "invocation_conflict":
        return REJECTED("invocation_conflict");
    }
  }
  if (hasReceipt(record, body, ["rejected", "failed"])) {
    return REJECTED(rejectionCode(status, body));
  }
  if (status === 409 && body?.receipt === undefined) {
    return Object.freeze({ _tag: "Refused", code });
  }
  if (status === 429 || status >= 500) return RETRY("unavailable");
  return RETRY("malformed");
};

export type InterruptedReason =
  | "scope-fenced"
  | "leadership-fenced"
  | "scope-unconfirmed"
  | "invocation-conflict"
  | "mapping-refused"
  | "record-invalid"
  | "aborted"
  | "storage";

export const interruptedReason = (error: unknown): InterruptedReason => {
  const tag = (error as { readonly _tag?: unknown } | undefined)?._tag;
  switch (tag) {
    case "ReplicaFencedError":
      return isLeadershipKey(String((error as { readonly key?: unknown }).key))
        ? "leadership-fenced"
        : "scope-fenced";
    case "ReplicaScopeClearedError":
      return "scope-fenced";
    case "ReplicaScopeUnconfirmedError":
      return "scope-unconfirmed";
    case "OutboxInvocationConflict":
    case "ClientRefConflict":
      return "invocation-conflict";
    case "ClientRefMappingRefused":
      return "mapping-refused";
    case "OutboxRecordInvalid":
      return "record-invalid";
  }
  return (error as { readonly name?: unknown } | undefined)?.name === "AbortError"
    ? "aborted"
    : "storage";
};

export type QueueProgress = {
  readonly partition: string;
  readonly receiver: ReplicaDatabaseScope;
  readonly state:
    | { readonly _tag: "Empty" }
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
      readonly _tag: "Refused";
      readonly invocation: InvocationId;
      readonly code: string | undefined;
    }
    | { readonly _tag: "Interrupted"; readonly reason: InterruptedReason }
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
  readonly keyId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
};

export const runSubmissionPass = async (
  pass: SubmissionPass,
): Promise<readonly QueueProgress[]> => {
  const { plans, handles } = await pass.store.submissionPlan(
    pass.scope,
    pass.keyId,
  );
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
    return progress(plan.partition, plan.receiver, {
      _tag: "Interrupted",
      reason: interruptedReason(outcome.reason),
    });
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
