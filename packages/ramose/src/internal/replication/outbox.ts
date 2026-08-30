/**
 * The durable offline queue model (#475 slice 1).
 *
 * Everything in this module is a pure value: record shapes, strict decoding,
 * per-receiver FIFO ordering, dependency blocking, and the sealing-epoch
 * quarantine decision. The IndexedDB boundary lives in `outbox-storage.ts`;
 * submission and acknowledgement are the next slices.
 *
 * ## What a queued invocation is allowed to hold
 *
 * Identity, version, receiver, target, input — and nothing else. No
 * authoritative operation body, source, AST, bytecode, closure, or
 * interpreter artifact is persisted here or transmitted from here; the server
 * resolves the permanent operation identity to its own trusted deployed
 * executable. The pinned {@link OperationVersion} is what makes that safe: it
 * is operation-scoped and deployment-free, so an ordinary redeploy keeps a
 * queued invocation valid while a changed contract is refused rather than
 * silently executed against different semantics. Catalog unit hashes and
 * deployment identities are deliberately *not* persisted — they rotate on
 * every deploy and would expire an offline queue for no semantic reason.
 *
 * ## Ordering
 *
 * FIFO is per receiver database and nothing else, so two databases drain
 * independently. Order comes from an explicit durable sequence assigned inside
 * the enqueue transaction, never from a timestamp or from a UUID's time
 * prefix, so a clock adjustment or a same-millisecond burst cannot reorder a
 * restored queue.
 *
 * ## Blocking and quarantine
 *
 * A record that names an unmapped {@link ClientRef} — as its target or at a
 * declared entity-reference input position — is *blocked*: it stays exactly
 * where it is in its queue until a durable mapping exists (mappings arrive in
 * slice 2). Because the queue is FIFO, a blocked head holds its own database
 * and no other.
 *
 * A record embedding a sealed {@link EntityId} minted under a codec version
 * this build cannot read, or under a server sealing-key epoch the server has
 * since replaced, surfaces the typed data-free `update-required` state — the
 * same taxonomy the authoritative resolver uses. It is never silently
 * cleared, never re-executed, and the state carries no entity data.
 */

import * as Data from "effect/Data";
import type { AllocationPathSegment } from "../../db/allocations.ts";
import {
  ENTITY_ID_CODEC,
  entityIdEnvelope,
  isClientRef,
  isEntityId,
  isInvocationId,
  type ClientRef,
  type EntityId,
  type InvocationId,
  type MutationRef,
} from "../../db/refs.ts";
import type {
  CatalogId,
  OperationVersion,
  OwnerRef,
} from "../authorization/identities.ts";
import type { JsonValue } from "../authorization/json.ts";
import { decideServerIdentityBinding } from "./server-identity.ts";
import type { ReplicaDatabaseScope, ReplicaScope } from "./replica-lifecycle.ts";

/** Bump only for a change to the durable mutation record layout. */
export const MUTATION_QUEUE_VERSION = 1;

const PARTITION_DOMAIN = `ramose-mutation-v${MUTATION_QUEUE_VERSION}`;

/**
 * The durable partition of one receiver database's queue.
 *
 * Deliberately *not* the replica partition key: that key also carries the
 * read-view and read-compatibility hashes, so a compatible schema change would
 * orphan every queued mutation. A queue is bound to the same three stable
 * components the sealed entity handle is bound to, and to nothing else.
 *
 * The components are fixed-shape opaque identities that never contain the
 * separator, so a scope selects exactly its own queues by a prefix range.
 */
export const mutationPartitionKey = (scope: ReplicaDatabaseScope): string =>
  [PARTITION_DOMAIN, scope.server, scope.principal, scope.database].join(":");

/** Prefix owning every queue of one server/principal scope. */
export const mutationScopePrefix = (scope: ReplicaScope): string =>
  [PARTITION_DOMAIN, scope.server, scope.principal, ""].join(":");

/** The permanent semantic identity of an operation, across every deployment. */
export type QueuedOperation = {
  readonly catalog: CatalogId;
  readonly owner: OwnerRef;
  readonly localName: string;
};

/** The sealing epoch every sealed handle in one record was minted under. */
export type SealingEpoch = {
  readonly codecVersion: number;
  readonly keyId: string;
};

/** What a queued invocation acts on. Never a numeric eid, never path text. */
export type QueuedTarget =
  | { readonly type: "none" }
  | { readonly type: "entity"; readonly entityId: EntityId }
  | { readonly type: "client-ref"; readonly clientRef: ClientRef };

/** One declared allocation slot bound to the client ref it will name. */
export type QueuedAllocation = {
  readonly slot: string;
  readonly clientRef: ClientRef;
};

/**
 * One declared entity-reference position inside the validated input. The path
 * is declared, never discovered: a durable dependency is never inferred by
 * scanning input text for something that looks like a client ref.
 */
export type QueuedInputRef = {
  readonly path: readonly AllocationPathSegment[];
  readonly ref: MutationRef;
};

/** One durable queued invocation. */
export type OutboxRecord = {
  readonly partition: string;
  /** Per-partition FIFO order. Monotonic, assigned inside the enqueue write. */
  readonly sequence: number;
  readonly invocation: InvocationId;
  /** Owning scope key, so a scoped clear can report what it removed. */
  readonly scope: string;
  readonly receiver: ReplicaDatabaseScope;
  readonly operation: QueuedOperation;
  readonly operationVersion: OperationVersion;
  readonly target: QueuedTarget;
  readonly input: JsonValue;
  readonly allocations: readonly QueuedAllocation[];
  readonly inputRefs: readonly QueuedInputRef[];
  /** `null` when this record embeds no sealed handle at all. */
  readonly sealing: SealingEpoch | null;
  readonly enqueuedAt: number;
};

/** The durable per-receiver cursor: FIFO order and the adopted sealing epoch. */
export type QueueCursorRecord = {
  readonly partition: string;
  readonly scope: string;
  readonly receiver: ReplicaDatabaseScope;
  readonly nextSequence: number;
  readonly sealing: SealingEpoch | null;
  readonly updatedAt: number;
};

/**
 * One client ref this device minted, and the invocation slot that allocates
 * it. Registered in the same transaction as the invocation that owns it, so a
 * restored queue can never hold a ref no record accounts for.
 */
export type ClientRefRecord = {
  readonly partition: string;
  readonly clientRef: ClientRef;
  readonly invocation: InvocationId;
  readonly slot: string;
  readonly createdAt: number;
};

/**
 * One durable `{ clientRef, entityId }` mapping. Written only from a completed
 * authoritative receipt (slice 2); the shape is frozen here because the queue
 * model reads it to decide blocking.
 */
export type ClientRefMappingRecord = {
  readonly partition: string;
  readonly clientRef: ClientRef;
  readonly entityId: EntityId;
  readonly sealing: SealingEpoch;
  readonly invocation: InvocationId;
  readonly mappedAt: number;
};

/** Public durable receipt states plus the internal reconciliation marker. */
export type ReceiptState = "queued" | "committed" | "rejected";

/**
 * One durable receipt. Slice 1 freezes the shape and writes only the `queued`
 * record that atomic enqueue produces; completion, output, mappings, and the
 * `committed-unobserved` marker are populated in the following slices.
 */
export type ReceiptRecord = {
  readonly partition: string;
  readonly invocation: InvocationId;
  readonly scope: string;
  readonly state: ReceiptState;
  /**
   * Internal reconciliation marker for #476. `null` until the receipt
   * completes; `"unobserved"` between the durable commit and the first
   * causally fresh replication activation that observes it. Never public.
   */
  readonly observation: "unobserved" | "observed" | null;
  readonly output: JsonValue | null;
  readonly mappings: readonly QueuedMapping[];
  readonly failure: { readonly code: string } | null;
  readonly updatedAt: number;
};

export type QueuedMapping = {
  readonly clientRef: ClientRef;
  readonly entityId: EntityId;
};

/** A draft rejected before anything became durable. */
export class OutboxRecordInvalid extends Data.TaggedError(
  "OutboxRecordInvalid",
)<{ readonly reason: string }> {}

const reject = (reason: string): never => {
  throw new OutboxRecordInvalid({ reason });
};

/**
 * JSON-only, by value. Rejects `undefined`, functions, symbols, bigints,
 * `NaN`, infinities, non-plain prototypes, and cycles — anything IndexedDB's
 * structured clone would either lose or store in a form the wire cannot carry.
 */
const assertJsonValue = (value: unknown, at: string, seen: Set<object>): void => {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) reject(`input at ${at} is not a finite number`);
      return;
    case "object":
      break;
    default:
      reject(`input at ${at} is ${typeof value}, which is not JSON`);
      return;
  }
  const object = value as object;
  if (seen.has(object)) reject(`input at ${at} is cyclic`);
  seen.add(object);
  if (Array.isArray(object)) {
    object.forEach((item, index) => assertJsonValue(item, `${at}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      reject(`input at ${at} is not a plain object`);
    }
    for (const [key, item] of Object.entries(object)) {
      assertJsonValue(item, `${at}.${key}`, seen);
    }
  }
  seen.delete(object);
};

/** The sealing epoch a sealed handle declares, read from its preamble alone. */
export const sealingEpochOf = (entityId: string): SealingEpoch | undefined => {
  const envelope = entityIdEnvelope(entityId);
  return envelope === undefined ? undefined : Object.freeze({
    codecVersion: envelope.codecVersion,
    keyId: envelope.keyId,
  });
};

export const sameSealingEpoch = (
  left: SealingEpoch,
  right: SealingEpoch,
): boolean =>
  left.codecVersion === right.codecVersion && left.keyId === right.keyId;

/** Every sealed handle a draft embeds, in declaration order. */
const sealedHandles = (
  target: QueuedTarget,
  inputRefs: readonly QueuedInputRef[],
): readonly string[] => {
  const handles: string[] = [];
  if (target.type === "entity") handles.push(target.entityId);
  for (const use of inputRefs) if (isEntityId(use.ref)) handles.push(use.ref);
  return handles;
};

const readPath = (
  input: JsonValue,
  path: readonly AllocationPathSegment[],
): unknown => {
  let cursor: unknown = input;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[segment];
    } else {
      if (Array.isArray(cursor)) return undefined;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  return cursor;
};

/** Everything a caller supplies; identity and order are assigned here. */
export type OutboxDraft = {
  readonly invocation: InvocationId;
  readonly receiver: ReplicaDatabaseScope;
  readonly operation: QueuedOperation;
  readonly operationVersion: OperationVersion;
  readonly target: QueuedTarget;
  readonly input: JsonValue;
  readonly allocations: readonly QueuedAllocation[];
  readonly inputRefs: readonly QueuedInputRef[];
  readonly enqueuedAt: number;
};

/**
 * Validate one draft and stamp it with its durable partition and FIFO
 * sequence. Every rejection happens here, before the enqueue transaction
 * writes anything, so a queue can never hold a record it cannot interpret.
 */
export const buildOutboxRecord = (
  draft: OutboxDraft,
  scopeKey: string,
  sequence: number,
): OutboxRecord => {
  if (!isInvocationId(draft.invocation)) {
    reject("the invocation id is not a durable client invocation id");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    reject("the queue sequence must be a positive safe integer");
  }
  if (draft.operation.localName.length === 0) {
    reject("the operation local name is empty");
  }
  if (!/^[0-9a-f]{64}$/.test(draft.operationVersion)) {
    reject("the pinned operation version is not a canonical digest");
  }
  if (draft.target.type === "entity" && !isEntityId(draft.target.entityId)) {
    reject("the queued target is not a sealed entity handle");
  }
  if (draft.target.type === "client-ref" && !isClientRef(draft.target.clientRef)) {
    reject("the queued target is not a durable client ref");
  }
  assertJsonValue(draft.input, "input", new Set());

  const slots = new Set<string>();
  const allocated = new Set<string>();
  for (const allocation of draft.allocations) {
    if (!isClientRef(allocation.clientRef)) {
      reject(`allocation slot ${allocation.slot} has no durable client ref`);
    }
    if (slots.has(allocation.slot)) reject(`allocation slot ${allocation.slot} is declared twice`);
    if (allocated.has(allocation.clientRef)) {
      reject(`allocation slot ${allocation.slot} reuses another slot's client ref`);
    }
    slots.add(allocation.slot);
    allocated.add(allocation.clientRef);
  }

  const positions = new Set<string>();
  for (const use of draft.inputRefs) {
    const position = JSON.stringify(use.path);
    if (positions.has(position)) reject(`input position ${position} is declared twice`);
    positions.add(position);
    if (!isClientRef(use.ref) && !isEntityId(use.ref)) {
      reject(`input position ${position} is neither a client ref nor a sealed handle`);
    }
    // Declared, then verified: the durable dependency and the value actually
    // submitted are the same string, so no submission can silently diverge
    // from what blocking was decided on.
    if (readPath(draft.input, use.path) !== use.ref) {
      reject(`input position ${position} does not hold the declared reference`);
    }
  }

  let sealing: SealingEpoch | null = null;
  for (const handle of sealedHandles(draft.target, draft.inputRefs)) {
    const epoch = sealingEpochOf(handle);
    if (epoch === undefined) reject("a sealed handle has no readable envelope");
    if (sealing === null) sealing = epoch!;
    else if (!sameSealingEpoch(sealing, epoch!)) {
      reject("one invocation mixes two server sealing epochs");
    }
  }

  return Object.freeze({
    partition: mutationPartitionKey(draft.receiver),
    sequence,
    invocation: draft.invocation,
    scope: scopeKey,
    receiver: Object.freeze({ ...draft.receiver }),
    operation: Object.freeze({
      catalog: draft.operation.catalog,
      owner: Object.freeze({ ...draft.operation.owner }),
      localName: draft.operation.localName,
    }),
    operationVersion: draft.operationVersion,
    target: Object.freeze({ ...draft.target }) as QueuedTarget,
    input: draft.input,
    allocations: Object.freeze(
      draft.allocations.map((allocation) => Object.freeze({ ...allocation })),
    ),
    inputRefs: Object.freeze(
      draft.inputRefs.map((use) =>
        Object.freeze({ path: Object.freeze([...use.path]), ref: use.ref })
      ),
    ),
    sealing,
    enqueuedAt: draft.enqueuedAt,
  });
};

/**
 * Every client ref this record must have a durable mapping for before it can
 * be submitted, in a stable order: the target first, then declared input
 * positions in declaration order.
 */
export const outboxDependencies = (
  record: OutboxRecord,
): readonly ClientRef[] => {
  const refs: ClientRef[] = [];
  const seen = new Set<string>();
  const add = (ref: ClientRef): void => {
    if (seen.has(ref)) return;
    seen.add(ref);
    refs.push(ref);
  };
  if (record.target.type === "client-ref") add(record.target.clientRef);
  for (const use of record.inputRefs) if (isClientRef(use.ref)) add(use.ref);
  return Object.freeze(refs);
};

/** Whether the record's own allocations satisfy a dependency. */
const allocatesItself = (record: OutboxRecord, ref: ClientRef): boolean =>
  record.allocations.some((allocation) => allocation.clientRef === ref);

export type OutboxEntryState =
  | { readonly type: "ready" }
  | { readonly type: "blocked"; readonly missing: readonly ClientRef[] }
  /** Data-free, exactly like the authoritative resolver's quarantine. */
  | {
    readonly type: "update-required";
    readonly reason: "codec-version" | "key-epoch";
  };

export type OutboxDecisionContext = {
  /** Client refs that already have a durable authoritative mapping. */
  readonly mapped: ReadonlySet<string>;
  /**
   * The server sealing-key epoch currently confirmed for this scope, when one
   * is known. `undefined` — offline, or before the first authenticated
   * response of this session — never quarantines: an unconfirmed epoch is not
   * evidence of a rotation.
   */
  readonly keyId?: string | undefined;
};

/**
 * The state of one queued record. Quarantine is decided first and from the
 * record's own preamble, so an unreadable codec or a replaced key epoch is
 * never reported as an ordinary missing dependency.
 */
export const decideOutboxEntry = (
  record: OutboxRecord,
  context: OutboxDecisionContext,
): OutboxEntryState => {
  if (record.sealing !== null) {
    if (record.sealing.codecVersion !== ENTITY_ID_CODEC) {
      return Object.freeze({ type: "update-required", reason: "codec-version" });
    }
    if (context.keyId !== undefined) {
      const binding = decideServerIdentityBinding(record.sealing.keyId, context.keyId);
      if (binding.type === "incompatible") {
        return Object.freeze({ type: "update-required", reason: "key-epoch" });
      }
    }
  }
  const missing = outboxDependencies(record).filter((ref) =>
    !context.mapped.has(ref) && !allocatesItself(record, ref)
  );
  if (missing.length > 0) {
    return Object.freeze({ type: "blocked", missing: Object.freeze(missing) });
  }
  return READY;
};

const READY = Object.freeze({ type: "ready" }) as OutboxEntryState;

export type OutboxEntry = {
  readonly record: OutboxRecord;
  readonly state: OutboxEntryState;
};

/** The single next action for one receiver database's FIFO queue. */
export type OutboxHead =
  | { readonly type: "empty" }
  | { readonly type: "ready"; readonly record: OutboxRecord }
  | {
    readonly type: "blocked";
    readonly record: OutboxRecord;
    readonly missing: readonly ClientRef[];
  }
  | {
    readonly type: "update-required";
    readonly record: OutboxRecord;
    readonly reason: "codec-version" | "key-epoch";
  };

export type OutboxPartitionPlan = {
  readonly partition: string;
  readonly receiver: ReplicaDatabaseScope;
  readonly entries: readonly OutboxEntry[];
  readonly head: OutboxHead;
};

const EMPTY_HEAD = Object.freeze({ type: "empty" }) as OutboxHead;

/**
 * Group durable records into one plan per receiver database, in FIFO order.
 *
 * The head is the *first* record of each queue and nothing else. A blocked or
 * quarantined head holds its own database — that is what preserves per-database
 * FIFO — while every other database's head is decided independently, so an
 * unmapped ref in one database never stalls another.
 */
export const planOutbox = (
  records: readonly OutboxRecord[],
  context: OutboxDecisionContext,
): readonly OutboxPartitionPlan[] => {
  const grouped = new Map<string, OutboxRecord[]>();
  for (const record of records) {
    const bucket = grouped.get(record.partition);
    if (bucket === undefined) grouped.set(record.partition, [record]);
    else bucket.push(record);
  }
  return Object.freeze(
    [...grouped.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([partition, bucket]) => {
        const ordered = [...bucket].sort((left, right) => left.sequence - right.sequence);
        const entries = ordered.map((record) =>
          Object.freeze({ record, state: decideOutboxEntry(record, context) })
        );
        const first = entries[0];
        const head: OutboxHead = first === undefined
          ? EMPTY_HEAD
          : first.state.type === "ready"
            ? Object.freeze({ type: "ready", record: first.record })
            : first.state.type === "blocked"
              ? Object.freeze({
                type: "blocked",
                record: first.record,
                missing: first.state.missing,
              })
              : Object.freeze({
                type: "update-required",
                record: first.record,
                reason: first.state.reason,
              });
        return Object.freeze({
          partition,
          receiver: ordered[0]!.receiver,
          entries: Object.freeze(entries),
          head,
        });
      }),
  );
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeSealing = (value: unknown): SealingEpoch | null | undefined => {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  if (typeof value.codecVersion !== "number" || !Number.isSafeInteger(value.codecVersion)) {
    return undefined;
  }
  if (typeof value.keyId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value.keyId)) {
    return undefined;
  }
  return Object.freeze({ codecVersion: value.codecVersion, keyId: value.keyId });
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

const decodePath = (
  value: unknown,
): readonly AllocationPathSegment[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  for (const segment of value) {
    if (typeof segment === "string" && segment.length > 0) continue;
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      continue;
    }
    return undefined;
  }
  return Object.freeze([...value] as AllocationPathSegment[]);
};

/**
 * Strict decode of one stored record. A record this build cannot interpret is
 * reported as `undefined` and quarantined by the caller rather than being
 * half-read: a durable queue must never submit an invocation it does not fully
 * understand.
 */
export const decodeOutboxRecord = (value: unknown): OutboxRecord | undefined => {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.partition !== "string" || !value.partition.startsWith(`${PARTITION_DOMAIN}:`)) {
    return undefined;
  }
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    return undefined;
  }
  if (!isInvocationId(value.invocation)) return undefined;
  if (typeof value.scope !== "string" || value.scope.length === 0) return undefined;
  if (
    !isPlainObject(value.receiver) || typeof value.receiver.server !== "string" ||
    typeof value.receiver.principal !== "string" || typeof value.receiver.database !== "string"
  ) return undefined;
  if (
    !isPlainObject(value.operation) || typeof value.operation.catalog !== "string" ||
    typeof value.operation.localName !== "string" || value.operation.localName.length === 0 ||
    !isPlainObject(value.operation.owner) ||
    (value.operation.owner.kind !== "entity" && value.operation.owner.kind !== "trait") ||
    typeof value.operation.owner.name !== "string"
  ) return undefined;
  if (typeof value.operationVersion !== "string" || !/^[0-9a-f]{64}$/.test(value.operationVersion)) {
    return undefined;
  }
  const target = decodeTarget(value.target);
  if (target === undefined) return undefined;
  const sealing = decodeSealing(value.sealing);
  if (sealing === undefined) return undefined;
  if (typeof value.enqueuedAt !== "number" || !Number.isSafeInteger(value.enqueuedAt)) {
    return undefined;
  }
  if (!Array.isArray(value.allocations) || !Array.isArray(value.inputRefs)) return undefined;
  const allocations: QueuedAllocation[] = [];
  for (const allocation of value.allocations) {
    if (
      !isPlainObject(allocation) || typeof allocation.slot !== "string" ||
      allocation.slot.length === 0 || !isClientRef(allocation.clientRef)
    ) return undefined;
    allocations.push(Object.freeze({ slot: allocation.slot, clientRef: allocation.clientRef }));
  }
  const inputRefs: QueuedInputRef[] = [];
  for (const use of value.inputRefs) {
    if (!isPlainObject(use)) return undefined;
    const path = decodePath(use.path);
    if (path === undefined) return undefined;
    if (!isClientRef(use.ref) && !isEntityId(use.ref)) return undefined;
    inputRefs.push(Object.freeze({ path, ref: use.ref as MutationRef }));
  }
  try {
    assertJsonValue(value.input, "input", new Set());
  } catch {
    return undefined;
  }
  return Object.freeze({
    partition: value.partition,
    sequence: value.sequence,
    invocation: value.invocation,
    scope: value.scope,
    receiver: Object.freeze({
      server: value.receiver.server,
      principal: value.receiver.principal,
      database: value.receiver.database,
    }),
    operation: Object.freeze({
      catalog: value.operation.catalog as CatalogId,
      owner: Object.freeze({
        kind: value.operation.owner.kind,
        name: value.operation.owner.name,
      }) as OwnerRef,
      localName: value.operation.localName,
    }),
    operationVersion: value.operationVersion as OperationVersion,
    target,
    input: value.input as JsonValue,
    allocations: Object.freeze(allocations),
    inputRefs: Object.freeze(inputRefs),
    sealing,
    enqueuedAt: value.enqueuedAt,
  });
};
