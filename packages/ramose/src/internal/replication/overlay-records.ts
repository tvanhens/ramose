import type { AnyOptimisticProjection } from "../../db/Projection.ts";
import {
  isClientRef,
  isEntityId,
  isInvocationId,
  type ClientRef,
  type InvocationId,
  type MutationRef,
} from "../../db/refs.ts";
import { isAllocationSlotName } from "../../db/allocations.ts";
import type { OperationVersion } from "../authorization/identities.ts";
import type { JsonValue } from "../authorization/json.ts";
import type { OverlayLayer, OverlayLayerState } from "./overlay-layers.ts";
import {
  resolveProjectionBinding,
  type ClientProjectionCatalog,
  type ProjectionDriftReason,
  type ProjectionIdentity,
} from "./projection-binding.ts";
import {
  decideQuarantine,
  mutationPartitionKey,
  parseMutationPartitionKey,
  sameSealingEpoch,
  sealingEpochOf,
  type OutboxRecord,
  type QuarantineReason,
  type QueuedAllocation,
  type QueuedOperation,
  type QueuedTarget,
  type SealingEpoch,
} from "./outbox.ts";
import type { ReplicaDatabaseScope } from "./replica-lifecycle.ts";

export const MUTATION_LAYERS = "mutation-layers-v1";

const isSettlement = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export type OptimisticLayerRecord = {
  readonly partition: string;
  readonly sequence: number;
  readonly invocation: InvocationId;
  readonly scope: string;
  readonly receiver: ReplicaDatabaseScope;
  readonly operation: QueuedOperation;
  readonly operationVersion: OperationVersion;
  readonly projection: ProjectionIdentity;
  readonly target: QueuedTarget;
  readonly input: JsonValue;
  readonly allocations: readonly QueuedAllocation[];
  readonly refs: readonly MutationRef[];
  readonly sealing: SealingEpoch | null;
  readonly state: OverlayLayerState;
  readonly settled: number;
  readonly activation: number;
  readonly createdAt: number;
};

export type OptimisticLayerDraft = {
  readonly record: OutboxRecord;
  readonly projection: ProjectionIdentity;
  readonly createdAt: number;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const sealedHandles = (
  target: QueuedTarget,
  refs: readonly MutationRef[],
): readonly string[] => {
  const handles: string[] = [];
  if (target.type === "entity") handles.push(target.entityId);
  for (const ref of refs) if (isEntityId(ref)) handles.push(ref);
  return handles;
};

const embeddedEpoch = (
  target: QueuedTarget,
  refs: readonly MutationRef[],
): SealingEpoch | null | "invalid" => {
  let epoch: SealingEpoch | null = null;
  for (const handle of sealedHandles(target, refs)) {
    const found = sealingEpochOf(handle);
    if (found === undefined) return "invalid";
    if (epoch === null) epoch = found;
    else if (!sameSealingEpoch(epoch, found)) return "invalid";
  }
  return epoch;
};

export const suppliedRefs = (record: OutboxRecord): readonly MutationRef[] => {
  const refs: MutationRef[] = [];
  const seen = new Set<string>();
  const add = (ref: MutationRef): void => {
    if (seen.has(ref)) return;
    seen.add(ref);
    refs.push(ref);
  };
  if (record.target.type === "entity") add(record.target.entityId);
  if (record.target.type === "client-ref") add(record.target.clientRef);
  for (const use of record.inputRefs) add(use.ref);
  return Object.freeze(refs);
};

export const buildOptimisticLayer = (
  draft: OptimisticLayerDraft,
): OptimisticLayerRecord => {
  const { record } = draft;
  const refs = suppliedRefs(record);
  const built: OptimisticLayerRecord = Object.freeze({
    partition: record.partition,
    sequence: record.sequence,
    invocation: record.invocation,
    scope: record.scope,
    receiver: Object.freeze({ ...record.receiver }),
    operation: Object.freeze({
      catalog: record.operation.catalog,
      owner: Object.freeze({ ...record.operation.owner }),
      localName: record.operation.localName,
    }),
    operationVersion: record.operationVersion,
    projection: Object.freeze({
      revision: draft.projection.revision,
      build: draft.projection.build,
    }),
    target: Object.freeze({ ...record.target }) as QueuedTarget,
    input: record.input,
    allocations: Object.freeze(
      record.allocations.map((allocation) => Object.freeze({ ...allocation })),
    ),
    refs,
    sealing: record.sealing,
    state: "queued",
    settled: 0,
    activation: 0,
    createdAt: draft.createdAt,
  });
  return durable(built);
};

export const withLayerState = (
  record: OptimisticLayerRecord,
  state: OverlayLayerState,
  activation: number,
  settled = record.settled,
): OptimisticLayerRecord =>
  durable(Object.freeze({ ...record, state, settled, activation }));

const durable = (record: OptimisticLayerRecord): OptimisticLayerRecord => {
  let stored: unknown;
  try {
    stored = structuredClone(record);
  } catch {
    throw new Error("ramose/overlay: a layer record cannot be structured-cloned");
  }
  const decoded = decodeOptimisticLayer(stored);
  if (decoded === undefined) {
    throw new Error("ramose/overlay: a layer record does not survive its decoder");
  }
  return decoded;
};

export const decodeOptimisticLayer = (
  value: unknown,
): OptimisticLayerRecord | undefined => {
  if (!isPlainObject(value)) return undefined;
  if (
    typeof value.partition !== "string" ||
    parseMutationPartitionKey(value.partition) === undefined
  ) return undefined;
  if (!isSequence(value.sequence) || !isInvocationId(value.invocation)) return undefined;
  if (typeof value.scope !== "string" || value.scope.length === 0) return undefined;
  if (
    !isPlainObject(value.receiver) || typeof value.receiver.server !== "string" ||
    typeof value.receiver.principal !== "string" ||
    typeof value.receiver.database !== "string"
  ) return undefined;
  const receiver = Object.freeze({
    server: value.receiver.server,
    principal: value.receiver.principal,
    database: value.receiver.database,
  });
  if (mutationPartitionKey(receiver) !== value.partition) return undefined;
  if (
    !isPlainObject(value.operation) || typeof value.operation.catalog !== "string" ||
    typeof value.operation.localName !== "string" ||
    value.operation.localName.length === 0 ||
    !isPlainObject(value.operation.owner) ||
    (value.operation.owner.kind !== "entity" && value.operation.owner.kind !== "trait") ||
    typeof value.operation.owner.name !== "string"
  ) return undefined;
  if (
    typeof value.operationVersion !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.operationVersion)
  ) return undefined;
  if (
    !isPlainObject(value.projection) ||
    typeof value.projection.revision !== "number" ||
    !Number.isSafeInteger(value.projection.revision) || value.projection.revision < 1 ||
    typeof value.projection.build !== "string" || value.projection.build.length === 0
  ) return undefined;
  const target = decodeTarget(value.target);
  if (target === undefined) return undefined;
  if (!Array.isArray(value.allocations) || !Array.isArray(value.refs)) return undefined;
  const allocations: QueuedAllocation[] = [];
  const slots = new Set<string>();
  const claimed = new Set<string>();
  for (const allocation of value.allocations) {
    if (
      !isPlainObject(allocation) || !isAllocationSlotName(allocation.slot) ||
      !isClientRef(allocation.clientRef)
    ) return undefined;
    if (slots.has(allocation.slot) || claimed.has(allocation.clientRef)) return undefined;
    slots.add(allocation.slot);
    claimed.add(allocation.clientRef);
    allocations.push(
      Object.freeze({ slot: allocation.slot, clientRef: allocation.clientRef }),
    );
  }
  const refs: MutationRef[] = [];
  const supplied = new Set<string>();
  for (const ref of value.refs) {
    if (typeof ref !== "string" || (!isClientRef(ref) && !isEntityId(ref))) {
      return undefined;
    }
    if (supplied.has(ref) || claimed.has(ref)) return undefined;
    supplied.add(ref);
    refs.push(ref as MutationRef);
  }
  if (value.state !== "queued" && value.state !== "committed-unobserved") return undefined;
  if (
    typeof value.activation !== "number" || !Number.isSafeInteger(value.activation) ||
    value.activation < 0
  ) return undefined;
  if (value.state === "queued" && value.activation !== 0) return undefined;
  if (!isTimestamp(value.createdAt)) return undefined;
  const embedded = embeddedEpoch(target, refs);
  if (embedded === "invalid") return undefined;
  const sealing = decodeSealing(value.sealing);
  if (sealing === undefined) return undefined;
  if (embedded === null ? sealing !== null : sealing === null || !sameSealingEpoch(sealing, embedded)) {
    return undefined;
  }
  let input: JsonValue;
  try {
    input = cloneJson(value.input, new Set());
  } catch {
    return undefined;
  }
  return Object.freeze({
    partition: value.partition,
    sequence: value.sequence,
    invocation: value.invocation,
    scope: value.scope,
    receiver,
    operation: Object.freeze({
      catalog: value.operation.catalog as QueuedOperation["catalog"],
      owner: Object.freeze({
        kind: value.operation.owner.kind,
        name: value.operation.owner.name,
      }) as QueuedOperation["owner"],
      localName: value.operation.localName,
    }),
    operationVersion: value.operationVersion as OperationVersion,
    projection: Object.freeze({
      revision: value.projection.revision,
      build: value.projection.build,
    }),
    target,
    input,
    allocations: Object.freeze(allocations),
    refs: Object.freeze(refs),
    sealing: embedded,
    state: value.state,
    settled: isSettlement(value.settled) ? value.settled : 0,
    activation: value.activation,
    createdAt: value.createdAt,
  });
};

const decodeTarget = (value: unknown): QueuedTarget | undefined => {
  if (!isPlainObject(value)) return undefined;
  if (value.type === "none") return Object.freeze({ type: "none" });
  if (value.type === "entity" && isEntityId(value.entityId)) {
    return Object.freeze({ type: "entity", entityId: value.entityId });
  }
  if (value.type === "client-ref" && isClientRef(value.clientRef)) {
    return Object.freeze({ type: "client-ref", clientRef: value.clientRef });
  }
  return undefined;
};

const decodeSealing = (value: unknown): SealingEpoch | null | undefined => {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  if (
    typeof value.codecVersion !== "number" ||
    !Number.isSafeInteger(value.codecVersion) || value.codecVersion < 0 ||
    value.codecVersion > 255
  ) return undefined;
  if (typeof value.keyId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value.keyId)) {
    return undefined;
  }
  return Object.freeze({ codecVersion: value.codecVersion, keyId: value.keyId });
};

const cloneJson = (value: unknown, seen: Set<object>): JsonValue => {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite input");
      return value;
    case "object":
      break;
    default:
      throw new TypeError("non-JSON input");
  }
  const object = value as object;
  if (seen.has(object)) throw new TypeError("cyclic input");
  seen.add(object);
  let copy: JsonValue;
  if (Array.isArray(object)) {
    const items: JsonValue[] = [];
    for (let index = 0; index < object.length; index++) {
      if (!(index in object)) throw new TypeError("sparse input");
      items.push(cloneJson(object[index], seen));
    }
    copy = Object.freeze(items);
  } else {
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("non-plain input");
    }
    copy = Object.freeze(Object.fromEntries(
      Object.entries(object).map(([key, item]) => [key, cloneJson(item, seen)]),
    ));
  }
  seen.delete(object);
  return copy;
};

export type LayerQuarantineReason = ProjectionDriftReason | QuarantineReason | "unreadable-row";

export type LayerQuarantine = {
  readonly invocation: InvocationId | undefined;
  readonly reason: LayerQuarantineReason;
};

export type LayerRestoration =
  | { readonly type: "layers"; readonly layers: readonly OverlayLayer[] }
  | {
    readonly type: "update-required";
    readonly quarantined: readonly LayerQuarantine[];
  };

export type LayerRows = {
  readonly layers: readonly OptimisticLayerRecord[];
  readonly unreadable: number;
};

export type LayerReplay = {
  readonly catalog: ClientProjectionCatalog;
  readonly keyId?: string | undefined;
  readonly run: (
    projection: AnyOptimisticProjection,
    record: OptimisticLayerRecord,
  ) => OverlayLayer | undefined;
};

export const restoreOverlayLayers = (
  rows: LayerRows,
  replay: LayerReplay,
): LayerRestoration => {
  const quarantined: LayerQuarantine[] = [];
  const layers: OverlayLayer[] = [];
  const ordered = [...rows.layers].sort(
    (left, right) => left.sequence - right.sequence,
  );
  if (rows.unreadable > 0) {
    quarantined.push(
      Object.freeze({ invocation: undefined, reason: "unreadable-row" as const }),
    );
  }
  for (const row of ordered) {
    if (row.sealing !== null) {
      const reason = decideQuarantine(row.sealing, replay.keyId);
      if (reason !== undefined) {
        quarantined.push(Object.freeze({ invocation: row.invocation, reason }));
        continue;
      }
    }
    const binding = resolveProjectionBinding(replay.catalog, {
      operation: row.operation,
      projection: row.projection,
    });
    if (binding.type === "update-required") {
      quarantined.push(Object.freeze({ invocation: row.invocation, reason: binding.reason }));
      continue;
    }
    if (binding.type === "none") continue;
    const layer = replay.run(binding.run, row);
    if (layer !== undefined) layers.push(layer);
  }
  if (quarantined.length > 0) {
    return Object.freeze({
      type: "update-required" as const,
      quarantined: Object.freeze(quarantined),
    });
  }
  return Object.freeze({ type: "layers" as const, layers: Object.freeze(layers) });
};

export const layerOf = (
  record: OptimisticLayerRecord,
  changeset: OverlayLayer["changeset"],
): OverlayLayer =>
  Object.freeze({
    invocation: record.invocation,
    sequence: record.sequence,
    state: record.state,
    settled: record.settled,
    activation: record.state === "queued" ? null : record.activation,
    declared: declaredRefs(record),
    changeset,
  });

export const declaredRefs = (
  record: OptimisticLayerRecord,
): readonly MutationRef[] =>
  Object.freeze([
    ...record.allocations.map((allocation) => allocation.clientRef as ClientRef),
    ...record.refs,
  ]);
