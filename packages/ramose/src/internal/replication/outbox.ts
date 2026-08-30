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
import {
  isAllocationSlotName,
  type AllocationPathSegment,
} from "../../db/allocations.ts";
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
import { canonicalizeJson } from "../authorization/canonical-json.ts";
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

/**
 * The receiver a partition key names. The components never contain the
 * separator, so the key is exactly reversible — which is what lets a queue
 * holding only an unreadable row still report which database it belongs to.
 */
export const parseMutationPartitionKey = (
  partition: string,
): ReplicaDatabaseScope | undefined => {
  const parts = partition.split(":");
  if (parts.length !== 4 || parts[0] !== PARTITION_DOMAIN) return undefined;
  if (parts[1] === "" || parts[2] === "" || parts[3] === "") return undefined;
  return Object.freeze({
    server: parts[1]!,
    principal: parts[2]!,
    database: parts[3]!,
  });
};

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

/**
 * One client ref claimed by two allocating invocations. A client ref is a
 * *global* identity, so a second claim — in this database or a sibling — is
 * refused rather than resolved to two different authoritative entities.
 */
export class ClientRefConflict extends Data.TaggedError(
  "ClientRefConflict",
)<{ readonly clientRef: string; readonly partition: string }> {}

/**
 * One invocation id reused for a different intent. Never a silent overwrite:
 * the durable record that already exists is the one that will be submitted.
 */
export class OutboxInvocationConflict extends Data.TaggedError(
  "OutboxInvocationConflict",
)<{ readonly invocation: InvocationId; readonly partition: string }> {}

const reject = (reason: string): never => {
  throw new OutboxRecordInvalid({ reason });
};

/**
 * Validate and *materialize* one JSON value in a single pass.
 *
 * Rejects `undefined`, functions, symbols, bigints, `NaN`, infinities,
 * non-plain prototypes, holes, and cycles — anything IndexedDB's structured
 * clone would lose or store in a form the wire cannot carry.
 *
 * It returns a fresh plain copy rather than the caller's object, and every
 * property is read exactly once. An input carrying an enumerable accessor
 * would otherwise be read again by structured clone *after* validation, so the
 * stored value could disagree with the declared reference positions it was
 * checked against — and the row it produced would be unreadable on the next
 * restart, holding its own partition. The snapshot is what is validated,
 * what the declared positions are read from, and what is persisted.
 */
const jsonSnapshot = (value: unknown, at: string, seen: Set<object>): JsonValue => {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) reject(`input at ${at} is not a finite number`);
      return value;
    case "object":
      break;
    default:
      return reject(`input at ${at} is ${typeof value}, which is not JSON`);
  }
  const object = value as object;
  if (seen.has(object)) reject(`input at ${at} is cyclic`);
  seen.add(object);
  let snapshot: JsonValue;
  if (Array.isArray(object)) {
    const items: JsonValue[] = [];
    for (let index = 0; index < object.length; index++) {
      // An index-wise walk, not `forEach`: a hole in a sparse array is skipped
      // by `forEach` but becomes `null` the moment the value is serialized for
      // the wire, which would change the invocation digest after the fact.
      if (!(index in object)) reject(`input at ${at}[${index}] is a hole`);
      items.push(jsonSnapshot(object[index], `${at}[${index}]`, seen));
    }
    snapshot = Object.freeze(items);
  } else {
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      reject(`input at ${at} is not a plain object`);
    }
    const fields: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(object)) {
      fields[key] = jsonSnapshot(item, `${at}.${key}`, seen);
    }
    snapshot = Object.freeze(fields);
  }
  seen.delete(object);
  return snapshot;
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

/** Every sealed handle a record embeds, in declaration order. */
const sealedHandles = (
  target: QueuedTarget,
  inputRefs: readonly QueuedInputRef[],
): readonly string[] => {
  const handles: string[] = [];
  if (target.type === "entity") handles.push(target.entityId);
  for (const use of inputRefs) if (isEntityId(use.ref)) handles.push(use.ref);
  return handles;
};

/**
 * The one sealing epoch a record's own handles agree on.
 *
 * `null` means the record embeds no sealed handle at all. It is computed the
 * same way when a draft is built and when a stored row is decoded, so the
 * persisted epoch can never drift from the handles it claims to describe —
 * otherwise a row whose `sealing` was rewritten to `null` would look
 * submittable after a key rotation, which is exactly the quarantine the
 * epoch exists to trigger.
 */
const embeddedSealingEpoch = (
  target: QueuedTarget,
  inputRefs: readonly QueuedInputRef[],
): SealingEpoch | null | "unreadable" | "mixed" => {
  let epoch: SealingEpoch | null = null;
  for (const handle of sealedHandles(target, inputRefs)) {
    const found = sealingEpochOf(handle);
    if (found === undefined) return "unreadable";
    if (epoch === null) epoch = found;
    else if (!sameSealingEpoch(epoch, found)) return "mixed";
  }
  return epoch;
};

/**
 * A path segment the builder accepts and the decoder can read back.
 *
 * Both ends apply this: a path the builder allowed but the decoder rejected
 * would produce a durable row that becomes unreadable on the next restart and
 * holds its partition. An empty property name is therefore not an addressable
 * reference position, in either direction.
 */
const validPathSegment = (segment: unknown): boolean =>
  (typeof segment === "string" && segment.length > 0) ||
  (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0);

const validPath = (path: readonly AllocationPathSegment[]): boolean =>
  path.every(validPathSegment);

/**
 * Whether every declared entity-reference position still holds exactly the
 * reference it declares. Checked when a draft is built *and* when a stored row
 * is decoded: if the two could drift, a row could be reported ready on a
 * mapped ref while its input carried a different, unresolved one.
 */
const inputRefsAgree = (
  input: JsonValue,
  inputRefs: readonly QueuedInputRef[],
): boolean => {
  const positions = new Set<string>();
  for (const use of inputRefs) {
    if (!validPath(use.path)) return false;
    const position = JSON.stringify(use.path);
    if (positions.has(position)) return false;
    positions.add(position);
    if (readPath(input, use.path) !== use.ref) return false;
  }
  return true;
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
  // Checked here, exactly as the decoder checks it: a `NaN`, an infinity, or a
  // fractional stamp would commit and then make its own row unreadable on the
  // next restart, holding a partition that has done nothing wrong.
  if (!Number.isSafeInteger(draft.enqueuedAt) || draft.enqueuedAt < 0) {
    reject("the enqueue timestamp must be a non-negative safe integer");
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
  // Validated and materialized once. Everything below reads this snapshot,
  // and it is what becomes durable.
  const input = jsonSnapshot(draft.input, "input", new Set());

  const slots = new Set<string>();
  const allocated = new Set<string>();
  for (const allocation of draft.allocations) {
    // The decoder's own predicate: a name it would refuse must never commit,
    // or the row it produces holds its partition after the next restart.
    if (!isAllocationSlotName(allocation.slot)) {
      reject(`allocation slot ${JSON.stringify(allocation.slot)} is not a slot name`);
    }
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
    if (!validPath(use.path)) {
      reject(`input position ${position} is not an addressable path`);
    }
    if (positions.has(position)) reject(`input position ${position} is declared twice`);
    positions.add(position);
    if (!isClientRef(use.ref) && !isEntityId(use.ref)) {
      reject(`input position ${position} is neither a client ref nor a sealed handle`);
    }
    // Declared, then verified: the durable dependency and the value actually
    // submitted are the same string, so no submission can silently diverge
    // from what blocking was decided on.
    if (readPath(input, use.path) !== use.ref) {
      reject(`input position ${position} does not hold the declared reference`);
    }
  }

  const embedded = embeddedSealingEpoch(draft.target, draft.inputRefs);
  if (embedded === "unreadable") reject("a sealed handle has no readable envelope");
  if (embedded === "mixed") reject("one invocation mixes two server sealing epochs");
  const sealing = embedded as SealingEpoch | null;

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
    input,
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
 * Whether two records express the same durable intent.
 *
 * Everything a submission depends on is compared; the wall-clock stamp is not,
 * because a retry of one intent legitimately happens later. Comparison is over
 * RFC 8785 canonical JSON — the same canonicalization the authoritative
 * invocation digest uses — so a caller that rebuilt its input with the
 * properties in another order is recognized as the same intent rather than
 * refused as reuse.
 */
const intentMaterial = (record: OutboxRecord): JsonValue =>
  ({
    partition: record.partition,
    sequence: record.sequence,
    invocation: record.invocation,
    scope: record.scope,
    receiver: { ...record.receiver },
    operation: {
      catalog: record.operation.catalog,
      owner: { ...record.operation.owner },
      localName: record.operation.localName,
    },
    operationVersion: record.operationVersion,
    target: { ...record.target },
    input: record.input,
    allocations: record.allocations.map((allocation) => ({ ...allocation })),
    inputRefs: record.inputRefs.map((use) => ({ path: [...use.path], ref: use.ref })),
    sealing: record.sealing === null ? null : { ...record.sealing },
  }) as JsonValue;

export const sameOutboxIntent = (
  left: OutboxRecord,
  right: OutboxRecord,
): boolean =>
  canonicalizeJson(intentMaterial(left)) === canonicalizeJson(intentMaterial(right));

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

export type QuarantineReason = "codec-version" | "key-epoch";

export type OutboxEntryState =
  | { readonly type: "ready" }
  | { readonly type: "blocked"; readonly missing: readonly ClientRef[] }
  /** Data-free, exactly like the authoritative resolver's quarantine. */
  | { readonly type: "update-required"; readonly reason: QuarantineReason };

/**
 * Durable mappings are keyed by receiver partition as well as client ref. A
 * ref resolved in one database says nothing about a sibling: the handle it
 * maps to is sealed to *that* database's scope, so treating one shared set of
 * refs as global would release a queue whose partition has no mapping at all.
 */
export const mappingKey = (partition: string, ref: ClientRef): string =>
  `${partition}\u0000${ref}`;

export type OutboxDecisionContext = {
  /**
   * Durable authoritative mappings, keyed by {@link mappingKey}, carrying the
   * sealing epoch the mapped handle was minted under.
   */
  readonly mapped: ReadonlyMap<string, SealingEpoch>;
  /**
   * The server sealing-key epoch currently confirmed for this scope, when one
   * is known. `undefined` — offline, or before the first authenticated
   * response of this session — never quarantines: an unconfirmed epoch is not
   * evidence of a rotation.
   */
  readonly keyId?: string | undefined;
};

/** Why this build cannot use a sealed handle minted under `epoch`, if at all. */
const quarantineReason = (
  epoch: SealingEpoch,
  keyId: string | undefined,
): QuarantineReason | undefined => {
  if (epoch.codecVersion !== ENTITY_ID_CODEC) return "codec-version";
  if (keyId === undefined) return undefined;
  return decideServerIdentityBinding(epoch.keyId, keyId).type === "incompatible"
    ? "key-epoch"
    : undefined;
};

/**
 * The state of one queued record.
 *
 * Quarantine is decided first — from the record's own preamble, then from the
 * epochs of the handles its dependencies already resolve to — so a key
 * rotation is never reported as an ordinary missing dependency, and a record
 * whose only sealed handle arrives *through* a mapping still surfaces the
 * promised data-free `update-required` rather than looking submittable.
 */
export const decideOutboxEntry = (
  record: OutboxRecord,
  context: OutboxDecisionContext,
): OutboxEntryState => {
  if (record.sealing !== null) {
    const reason = quarantineReason(record.sealing, context.keyId);
    if (reason !== undefined) {
      return Object.freeze({ type: "update-required", reason });
    }
  }
  const missing: ClientRef[] = [];
  for (const ref of outboxDependencies(record)) {
    if (allocatesItself(record, ref)) continue;
    const epoch = context.mapped.get(mappingKey(record.partition, ref));
    if (epoch === undefined) {
      missing.push(ref);
      continue;
    }
    const reason = quarantineReason(epoch, context.keyId);
    if (reason !== undefined) {
      return Object.freeze({ type: "update-required", reason });
    }
  }
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

/**
 * One stored row this build could not decode, named by the primary key
 * IndexedDB derived from its key path — the one part of a broken row that is
 * still trustworthy.
 */
export type UnreadableOutboxRow = {
  readonly partition: string;
  readonly sequence: number;
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
    readonly reason: QuarantineReason;
  }
  /**
   * The next row in durable order cannot be interpreted by this build. The
   * queue holds: submitting the record behind it would execute out of order,
   * and discarding it would destroy durable work.
   */
  | { readonly type: "unreadable"; readonly sequence: number };

export type OutboxPartitionPlan = {
  readonly partition: string;
  readonly receiver: ReplicaDatabaseScope;
  readonly entries: readonly OutboxEntry[];
  /** Rows of this queue this build could not decode, in durable order. */
  readonly unreadable: readonly UnreadableOutboxRow[];
  readonly head: OutboxHead;
};

const EMPTY_HEAD = Object.freeze({ type: "empty" }) as OutboxHead;

const headOf = (
  entry: OutboxEntry | undefined,
  unreadableAt: number | undefined,
): OutboxHead => {
  // Durable order decides, so an unreadable row ahead of the first readable
  // record holds the queue rather than being skipped over.
  if (
    unreadableAt !== undefined &&
    (entry === undefined || unreadableAt < entry.record.sequence)
  ) {
    return Object.freeze({ type: "unreadable", sequence: unreadableAt });
  }
  if (entry === undefined) return EMPTY_HEAD;
  switch (entry.state.type) {
    case "ready":
      return Object.freeze({ type: "ready", record: entry.record });
    case "blocked":
      return Object.freeze({
        type: "blocked",
        record: entry.record,
        missing: entry.state.missing,
      });
    case "update-required":
      return Object.freeze({
        type: "update-required",
        record: entry.record,
        reason: entry.state.reason,
      });
  }
};

type OutboxBucket = {
  readonly records: OutboxRecord[];
  readonly unreadable: UnreadableOutboxRow[];
};

/**
 * Group durable rows into one plan per receiver database, in FIFO order.
 *
 * The head is the first row of each queue in durable sequence order and
 * nothing else. A blocked, quarantined, or unreadable head holds its own
 * database — that is what preserves per-database FIFO — while every other
 * database's head is decided independently, so an unmapped ref or a corrupt
 * row in one database never stalls another.
 */
export const planOutbox = (
  records: readonly OutboxRecord[],
  unreadable: readonly UnreadableOutboxRow[],
  context: OutboxDecisionContext,
): readonly OutboxPartitionPlan[] => {
  const grouped = new Map<string, OutboxBucket>();
  const bucketFor = (partition: string): OutboxBucket => {
    const existing = grouped.get(partition);
    if (existing !== undefined) return existing;
    const created: OutboxBucket = { records: [], unreadable: [] };
    grouped.set(partition, created);
    return created;
  };
  for (const record of records) bucketFor(record.partition).records.push(record);
  for (const row of unreadable) bucketFor(row.partition).unreadable.push(row);
  return Object.freeze(
    [...grouped.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap(([partition, bucket]) => {
        const receiver = bucket.records[0]?.receiver ??
          parseMutationPartitionKey(partition);
        // A partition key that does not parse and holds no readable record
        // names no receiver: there is nothing to plan and nothing to submit.
        if (receiver === undefined) return [];
        const ordered = [...bucket.records].sort(
          (left, right) => left.sequence - right.sequence,
        );
        const broken = [...bucket.unreadable].sort(
          (left, right) => left.sequence - right.sequence,
        );
        const entries = ordered.map((record) =>
          Object.freeze({ record, state: decideOutboxEntry(record, context) })
        );
        return [Object.freeze({
          partition,
          receiver,
          entries: Object.freeze(entries),
          unreadable: Object.freeze(broken),
          head: headOf(entries[0], broken[0]?.sequence),
        })];
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
  if (!value.every(validPathSegment)) return undefined;
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
  // The partition and the receiver it claims must be the same realm: a record
  // filed under one database while naming another would submit somewhere its
  // FIFO position never guarded.
  const receiver = {
    server: value.receiver.server,
    principal: value.receiver.principal,
    database: value.receiver.database,
  };
  if (mutationPartitionKey(receiver) !== value.partition) return undefined;
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
  const slots = new Set<string>();
  const claimed = new Set<string>();
  for (const allocation of value.allocations) {
    if (
      !isPlainObject(allocation) || !isAllocationSlotName(allocation.slot) ||
      !isClientRef(allocation.clientRef)
    ) return undefined;
    // The builder's own uniqueness, reapplied. A row repeating a slot under two
    // refs, or one ref under two slots, cannot be mapped unambiguously, and a
    // submission that acted on it would bind a durable client identity by
    // coincidence — so it stays quarantined instead.
    if (slots.has(allocation.slot) || claimed.has(allocation.clientRef)) return undefined;
    slots.add(allocation.slot);
    claimed.add(allocation.clientRef);
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
  let input: JsonValue;
  try {
    input = jsonSnapshot(value.input, "input", new Set());
  } catch {
    return undefined;
  }
  // The persisted epoch is not believed on its own: it must be exactly what
  // this row's own handles say. A row whose `sealing` was rewritten — by a
  // partial write, a foreign build, or tampering — is unreadable, not ready.
  // The same invariant the builder enforced. A row whose declared reference
  // no longer matches its own input is not interpretable, so it quarantines.
  if (!inputRefsAgree(input, inputRefs)) return undefined;
  const embedded = embeddedSealingEpoch(target, inputRefs);
  if (embedded === "unreadable" || embedded === "mixed") return undefined;
  if (embedded === null) {
    if (sealing !== null) return undefined;
  } else if (sealing === null || !sameSealingEpoch(sealing, embedded)) {
    return undefined;
  }
  return Object.freeze({
    partition: value.partition,
    sequence: value.sequence,
    invocation: value.invocation,
    scope: value.scope,
    receiver: Object.freeze(receiver),
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
    input,
    allocations: Object.freeze(allocations),
    inputRefs: Object.freeze(inputRefs),
    sealing,
    enqueuedAt: value.enqueuedAt,
  });
};

/**
 * Strict decode of one stored mapping.
 *
 * The persisted epoch is not believed on its own: it must be exactly the epoch
 * the mapped handle's own preamble declares. Otherwise an old handle whose
 * `sealing` field was rewritten to the currently confirmed epoch would report
 * every dependent invocation ready after a key rotation — the same quarantine
 * bypass the outbox-row decoder refuses. A row that fails here is dropped, so
 * its dependents stay blocked rather than becoming submittable.
 */
export const decodeClientRefMapping = (
  value: unknown,
): ClientRefMappingRecord | undefined => {
  if (!isPlainObject(value)) return undefined;
  if (
    typeof value.partition !== "string" ||
    parseMutationPartitionKey(value.partition) === undefined
  ) return undefined;
  if (!isClientRef(value.clientRef) || !isEntityId(value.entityId)) return undefined;
  if (!isInvocationId(value.invocation)) return undefined;
  if (typeof value.mappedAt !== "number" || !Number.isSafeInteger(value.mappedAt)) {
    return undefined;
  }
  const sealing = decodeSealing(value.sealing);
  if (sealing === undefined || sealing === null) return undefined;
  const embedded = sealingEpochOf(value.entityId);
  if (embedded === undefined || !sameSealingEpoch(sealing, embedded)) return undefined;
  return Object.freeze({
    partition: value.partition,
    clientRef: value.clientRef,
    entityId: value.entityId,
    sealing: embedded,
    invocation: value.invocation,
    mappedAt: value.mappedAt,
  });
};
