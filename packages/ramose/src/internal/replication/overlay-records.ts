/**
 * The durable half of the speculative overlay (#476 slice 2).
 *
 * One row per invocation that produced a layer, in the same per-receiver FIFO
 * position its outbox row holds. Everything here is a pure value: the record
 * shape, its strict decoder, and the total decision that turns stored rows back
 * into layers on restart. The IndexedDB boundary lives beside the other
 * mutation families in `outbox-storage.ts`, because a layer is written,
 * transitioned, and removed inside the very transactions that enqueue,
 * acknowledge, and fence the invocation it belongs to.
 *
 * ## What a layer row is allowed to hold
 *
 * Operation identity, the pinned {@link OperationVersion}, the *declared*
 * projection identity, the validated input, the invocation's target, its
 * declared allocation slots and the client refs they minted, the sealed
 * handles the input supplies, and the layer's own bookkeeping — its FIFO
 * position, its state, and the activation counter its commit was stamped with.
 *
 * **Never callback source, AST, bytecode, closure, or interpreter artifact.**
 * The changeset itself is deliberately *not* stored either. It is recomputed on
 * restart by resolving the callback from the installed client bundle and
 * running it natively over the stored input — which is what makes "restart
 * reconstructs exactly the same speculative view by natively replaying the
 * matching projection" a property of the code that is installed *now* rather
 * than of a snapshot some earlier build left behind. A stored changeset would
 * silently outlive the identity check that exists to refuse it.
 *
 * ## Scope
 *
 * Rows are keyed by the same stable `{server, principal, database}` partition
 * the outbox uses, so `clearLocalData()` removes them in the same atomic
 * clearing transaction, a quarantine covers one principal's scope without
 * touching another's, and a compatible read-view rotation or a cache eviction
 * never discards the user's own optimistic work.
 */

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

/** The durable store family holding one receiver database's layers. */
export const MUTATION_LAYERS = "mutation-layers-v1";

/** One durable speculative layer. */
export type OptimisticLayerRecord = {
  readonly partition: string;
  /** The invocation's own durable FIFO position; identical to its outbox row. */
  readonly sequence: number;
  readonly invocation: InvocationId;
  readonly scope: string;
  readonly receiver: ReplicaDatabaseScope;
  readonly operation: QueuedOperation;
  readonly operationVersion: OperationVersion;
  /**
   * The declared identity of the projection that produced this layer. Never
   * derived from the callback: `revision` is the author's statement and `build`
   * names the bundle the row was written by.
   */
  readonly projection: ProjectionIdentity;
  readonly target: QueuedTarget;
  readonly input: JsonValue;
  /** Declared allocation slots, so `tx.create` resolves on replay. */
  readonly allocations: readonly QueuedAllocation[];
  /**
   * Every reference the invocation's own target and validated input supply.
   *
   * Persisted because the overlay's aliasing rule is a *closed* one: a layer
   * may name a client ref only when the ref is committed-mapped, supplied by
   * this invocation's input, or minted by one of its declared slots. Without
   * the row carrying them, a restored layer could mint a speculative entity for
   * a ref no durable record accounts for.
   */
  readonly refs: readonly MutationRef[];
  /**
   * The one server sealing epoch every sealed handle in this row was minted
   * under — the codec version and the identity root's `keyId` — or `null` when
   * the row embeds none. Recomputed from the row's own handles on decode, so a
   * rewritten field cannot make a stale handle look current.
   */
  readonly sealing: SealingEpoch | null;
  readonly state: OverlayLayerState;
  /**
   * The activation counter in force when the receipt became durable, or `0`
   * while the layer is still queued. A fence at `n` removes this row when it is
   * `committed-unobserved` and stamped strictly below `n`.
   */
  readonly activation: number;
  readonly createdAt: number;
};

/** Everything a caller supplies; the durable position comes from the record. */
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

/** Every sealed handle one row embeds: its target, and its supplied refs. */
const sealedHandles = (
  target: QueuedTarget,
  refs: readonly MutationRef[],
): readonly string[] => {
  const handles: string[] = [];
  if (target.type === "entity") handles.push(target.entityId);
  for (const ref of refs) if (isEntityId(ref)) handles.push(ref);
  return handles;
};

/**
 * The one sealing epoch a row's own handles agree on, computed identically by
 * the builder and the decoder so the persisted field can never drift from the
 * handles it claims to describe.
 */
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

/** The references one queued record's target and input positions supply. */
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

/**
 * Build one durable layer from the queued record it belongs to.
 *
 * Deriving it from the record rather than from a second caller-supplied shape
 * is deliberate: the layer and the invocation it projects must agree on the
 * partition, the FIFO position, the target, the input, and the declared slots,
 * and taking them from one already-validated value is the only way that cannot
 * drift.
 */
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
    activation: 0,
    createdAt: draft.createdAt,
  });
  return durable(built);
};

/** The same row, transitioned. Every field but the two named ones is carried. */
export const withLayerState = (
  record: OptimisticLayerRecord,
  state: OverlayLayerState,
  activation: number,
): OptimisticLayerRecord =>
  durable(Object.freeze({ ...record, state, activation }));

/**
 * Refuse to persist anything the reader cannot read back, and return exactly
 * what the reader will see — the same durable-persistence boundary every other
 * mutation family passes through, over the `structuredClone` IndexedDB itself
 * applies.
 */
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

/**
 * Strict decode of one stored layer. A row this build cannot interpret is
 * reported as `undefined`; the caller quarantines its receiver database rather
 * than replaying a layer it does not fully understand.
 */
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
  // The row and the partition it is filed under must name the same realm, or a
  // restore would replay one database's optimistic work over another's.
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
    // A ref this invocation allocates is minted here, not supplied to it; the
    // enqueue refuses that record for the same reason.
    if (supplied.has(ref) || claimed.has(ref)) return undefined;
    supplied.add(ref);
    refs.push(ref as MutationRef);
  }
  if (value.state !== "queued" && value.state !== "committed-unobserved") return undefined;
  if (
    typeof value.activation !== "number" || !Number.isSafeInteger(value.activation) ||
    value.activation < 0
  ) return undefined;
  // A queued layer has no commit to stamp, so a stamp on one would be selected
  // by a comparison that means nothing for it.
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

/**
 * A plain, frozen copy of a stored JSON input. The row was written from an
 * already-validated snapshot, so this only has to refuse what structured clone
 * could have brought back in a form the projection must not see.
 */
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

/** Why one receiver database's layers cannot be replayed as they stand. */
export type LayerQuarantineReason = ProjectionDriftReason | QuarantineReason | "unreadable-row";

export type LayerQuarantine = {
  /** `undefined` when the offending row could not even be decoded. */
  readonly invocation: InvocationId | undefined;
  readonly reason: LayerQuarantineReason;
};

/** What the durable rows of one receiver database restore to. */
export type LayerRestoration =
  | { readonly type: "layers"; readonly layers: readonly OverlayLayer[] }
  /**
   * Data-free, exactly like the authoritative resolver's quarantine and the
   * outbox's own. No layer of this receiver database is presented, no committed
   * replica is touched, and nothing is dropped: the rows stay durable and a
   * compatible build replays them unchanged.
   */
  | {
    readonly type: "update-required";
    readonly quarantined: readonly LayerQuarantine[];
  };

/**
 * One receiver database's stored rows, as the reader produced them: the ones
 * this build decoded, and how many it could not. An undecodable row is counted
 * rather than dropped, because dropping it would silently replay a *different*
 * sequence of layers than the one the device durably holds.
 */
export type LayerRows = {
  readonly layers: readonly OptimisticLayerRecord[];
  readonly unreadable: number;
};

export type LayerReplay = {
  readonly catalog: ClientProjectionCatalog;
  /** The sealing epoch the current authenticated session confirmed, if any. */
  readonly keyId?: string | undefined;
  /**
   * Run one bound projection over one stored row. Supplied by the caller so
   * this module stays a pure decision: the caller owns `runProjection`, and
   * nothing here ever reads a callback's source.
   */
  readonly run: (
    projection: AnyOptimisticProjection,
    record: OptimisticLayerRecord,
  ) => OverlayLayer | undefined;
};

/**
 * Turn one receiver database's durable rows back into ordered layers.
 *
 * The decision is total and scoped to the whole receiver database: a single
 * drifted projection identity, incompatible sealing epoch, or unreadable row
 * withholds *every* layer of that database as the typed data-free
 * update-required state. Presenting the survivors instead would show a
 * speculative view the installed bundle cannot account for — a partial replay
 * against a replica the row is not compatible with, which is exactly what the
 * quarantine exists to refuse. The committed replica is never reset by this.
 */
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
    // A stored row always names a projection, so `none` cannot occur here: an
    // invocation queued without one never produced a layer to store.
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

/** The layer one stored row becomes, given the changeset its replay produced. */
export const layerOf = (
  record: OptimisticLayerRecord,
  changeset: OverlayLayer["changeset"],
): OverlayLayer =>
  Object.freeze({
    invocation: record.invocation,
    sequence: record.sequence,
    state: record.state,
    activation: record.state === "queued" ? null : record.activation,
    declared: declaredRefs(record),
    changeset,
  });

/**
 * Every reference this layer is entitled to name: the client refs its declared
 * allocation slots minted, and the refs its own target and validated input
 * supplied. A ref outside this set — and outside the committed mappings — is
 * refused by the overlay rather than given a speculative entity.
 */
export const declaredRefs = (
  record: OptimisticLayerRecord,
): readonly MutationRef[] =>
  Object.freeze([
    ...record.allocations.map((allocation) => allocation.clientRef as ClientRef),
    ...record.refs,
  ]);
