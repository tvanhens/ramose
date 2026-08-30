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
import {
  canonicalizeJson,
  hasLoneSurrogate,
} from "../authorization/canonical-json.ts";
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
  /**
   * The post-commit activation counter of this receiver database (#475 slice
   * 3). Monotonic, never reused, and incremented exactly once per fresh
   * replication activation — the increment *is* that activation's identity.
   * `0` means no fresh activation has begun on this device yet.
   */
  readonly activation: number;
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
  /**
   * The activation counter in force when this receipt's `unobserved` marker
   * became durable (#475 slice 3). The fence on activation `n` marks every
   * receipt stamped strictly below `n`, which is what makes "durable before
   * that activation began" a single comparison rather than a per-receipt fence
   * record. The fence does *not* rewrite it, so the predicate is stable and
   * re-fencing an already observed row selects nothing. `0` when there is no
   * marker at all, and for every row written before the counter existed —
   * which is exactly what such a row means.
   */
  readonly activation: number;
  readonly output: JsonValue | null;
  readonly mappings: readonly QueuedMapping[];
  readonly failure: { readonly code: string } | null;
  readonly updatedAt: number;
};

export type QueuedMapping = {
  readonly clientRef: ClientRef;
  readonly entityId: EntityId;
};

/**
 * One committed receipt still waiting for the post-commit activation fence.
 *
 * The public shape carries no output, no mappings, and no observation token —
 * it says only that this invocation committed and that the authoritative
 * stream has not yet been seen to include it.
 */
export type UnobservedReceipt = {
  readonly invocation: InvocationId;
  /** The activation counter this marker became durable under. */
  readonly activation: number;
  readonly committedAt: number;
};

/**
 * Whether the fence on `activation` covers this receipt.
 *
 * The entire post-commit fence bookkeeping is this comparison. A receipt is
 * covered when its `unobserved` marker was already durable *before* that
 * activation began — which, because the counter is incremented exactly once
 * per fresh activation and before it opens, is exactly `stamp < activation`.
 * A receipt acknowledged after the activation began carries that activation's
 * own number, is not strictly below it, and waits for a later one.
 */
export const fencedByActivation = (
  receipt: ReceiptRecord,
  activation: number,
): boolean =>
  receipt.state === "committed" && receipt.observation === "unobserved" &&
  receipt.activation < activation;

/** The public view of one receipt that is still awaiting its fence. */
export const unobservedReceiptOf = (
  receipt: ReceiptRecord,
): UnobservedReceipt | undefined =>
  receipt.state === "committed" && receipt.observation === "unobserved"
    ? Object.freeze({
      invocation: receipt.invocation,
      activation: receipt.activation,
      committedAt: receipt.updatedAt,
    })
    : undefined;

/**
 * A record refused before anything became durable — from any of the mutation
 * families, not only the outbox. Every builder in the durable-persistence
 * boundary below raises this and nothing else, so "this cannot be stored" is
 * one condition with one type and a reason that names the record kind.
 */
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
const jsonSnapshot = (
  value: unknown,
  at: string,
  seen: Set<object>,
  /**
   * Whether this value must also survive RFC 8785 canonicalization.
   *
   * A queued *input* must: it enters the canonical invocation digest, so a
   * value the canonicalizer refuses could never be submitted and would make
   * even an identical retry throw instead of matching.
   *
   * An authoritative *output* must not be held to that rule. It is application
   * data the server already committed, it is never digested here, and refusing
   * to store it would leave the invocation queued and resubmitting forever
   * against a receipt that replays the same output every time — a wedged queue
   * for a string the operation was entitled to return.
   */
  canonical: boolean,
): JsonValue => {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      if (canonical && hasLoneSurrogate(value)) {
        reject(`input at ${at} has a lone surrogate`);
      }
      return value;
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
      items.push(jsonSnapshot(object[index], `${at}[${index}]`, seen, canonical));
    }
    snapshot = Object.freeze(items);
  } else {
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      reject(`input at ${at} is not a plain object`);
    }
    // `Object.fromEntries` creates own data properties, so an input carrying
    // an own `__proto__` field keeps it instead of silently invoking the
    // inherited setter and losing the field the declared paths were checked
    // against.
    const fields: (readonly [string, JsonValue])[] = [];
    for (const [key, item] of Object.entries(object)) {
      if (canonical && hasLoneSurrogate(key)) {
        reject(`input at ${at} has a lone surrogate in a key`);
      }
      fields.push([key, jsonSnapshot(item, `${at}.${key}`, seen, canonical)]);
    }
    snapshot = Object.freeze(Object.fromEntries(fields));
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
      if (!Array.isArray(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
      cursor = cursor[segment];
    } else {
      // Own properties only. A value installed on `Object.prototype` would
      // otherwise satisfy a declared position that the snapshot — and so the
      // durable row — does not contain, leaving the row unreadable on a
      // restart where that prototype mutation is absent.
      if (Array.isArray(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
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
  // Read exactly once, exactly as the input and the mappings are. Everything
  // below — the partition key, the reversibility check, and the stored row —
  // reads this snapshot, so an accessor cannot answer one receiver to the key
  // and another to the record filed under it.
  const receiver = Object.freeze({
    server: draft.receiver.server,
    principal: draft.receiver.principal,
    database: draft.receiver.database,
  });
  const partition = mutationPartitionKey(receiver);
  // The same reversibility every other mutation family requires. A receiver
  // component carrying the separator would produce a key that names a
  // different realm when it is read back, so the row is refused here rather
  // than committed and then found unreadable — or, worse, found readable as
  // some other database's queue.
  if (parseMutationPartitionKey(partition) === undefined) {
    reject("the receiver database does not form a reversible partition key");
  }
  if (!isInvocationId(draft.invocation)) {
    reject("the invocation id is not a durable client invocation id");
  }
  if (!isSequence(sequence)) {
    reject("the queue sequence must be a positive safe integer");
  }
  // Checked here, exactly as the decoder checks it: a `NaN`, an infinity, or a
  // fractional stamp would commit and then make its own row unreadable on the
  // next restart, holding a partition that has done nothing wrong.
  if (!isTimestamp(draft.enqueuedAt)) {
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
  if (draft.target.type === "client-ref") {
    const targeted = draft.target.clientRef;
    if (draft.allocations.some((allocation) => allocation.clientRef === targeted)) {
      reject("an invocation may not target a client ref it allocates");
    }
  }
  // Validated and materialized once. Everything below reads this snapshot,
  // and it is what becomes durable.
  const input = jsonSnapshot(draft.input, "input", new Set(), true);

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
    // A ref this very invocation allocates cannot also be an input it depends
    // on: the mapping only exists once this invocation's authoritative result
    // arrives, which is after its inputs had to be resolved.
    if (allocated.has(use.ref)) {
      reject("an invocation may not depend on a client ref it allocates");
    }
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

  const record: OutboxRecord = Object.freeze({
    partition,
    sequence,
    invocation: draft.invocation,
    scope: scopeKey,
    receiver,
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
  return durable(record, decodeOutboxRecord, "outbox");
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
  if (!isCodecVersion(value.codecVersion)) return undefined;
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
  if (!isSequence(value.sequence)) return undefined;
  if (!isInvocationId(value.invocation)) return undefined;
  if (!isScopeKey(value.scope)) return undefined;
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
  if (!isTimestamp(value.enqueuedAt)) return undefined;
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
    input = jsonSnapshot(value.input, "input", new Set(), true);
  } catch {
    return undefined;
  }
  // The persisted epoch is not believed on its own: it must be exactly what
  // this row's own handles say. A row whose `sealing` was rewritten — by a
  // partial write, a foreign build, or tampering — is unreadable, not ready.
  // The same invariants the builder enforced. A row whose declared reference
  // no longer matches its own input, or that depends on a ref it allocates,
  // is not interpretable, so it quarantines.
  if (!inputRefsAgree(input, inputRefs)) return undefined;
  if (
    (target.type === "client-ref" && claimed.has(target.clientRef)) ||
    inputRefs.some((use) => claimed.has(use.ref))
  ) return undefined;
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
  if (!isTimestamp(value.mappedAt)) return undefined;
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

/* ── the durable-persistence boundary ─────────────────────────────────────
 *
 * Every record this slice stores passes through exactly one builder here, and
 * every builder ends by proving its record survives the round trip its own
 * strict decoder performs — over a `structuredClone`, which is literally what
 * IndexedDB will store. A field that one side accepts and the other refuses is
 * therefore a failure at *write* time, not a durable row that becomes
 * unreadable on the next restart and holds its FIFO partition forever.
 *
 * The storage adapter calls only these builders. It performs no validation of
 * its own, so there is no second place for the two sides to drift apart.
 * ─────────────────────────────────────────────────────────────────────── */

/**
 * Refuse to persist anything the reader cannot read back, and return exactly
 * what the reader will see.
 *
 * `structuredClone` is the exact transformation IndexedDB applies, so this
 * catches accessors, prototypes, holes, and unclonable values as well as every
 * field-level disagreement between a builder and its decoder.
 *
 * The *decoded* value is what is returned, never the caller's own object. The
 * durable row and the value handed back are then the same value by
 * construction, so a caller comparing its intent against a durable row is
 * comparing like with like — and a retry whose draft carries harmless extra own
 * properties on a sub-object is recognized as the same intent rather than
 * refused as reuse.
 */
const durable = <T>(
  record: T,
  decode: (value: unknown) => T | undefined,
  kind: string,
): T => {
  let stored: unknown;
  try {
    stored = structuredClone(record);
  } catch {
    return reject(`a ${kind} record cannot be stored by structured clone`);
  }
  const decoded = decode(stored);
  if (decoded === undefined) {
    reject(`a ${kind} record does not survive its own durable decoder`);
  }
  return decoded!;
};

const decodeReceiverScope = (
  value: unknown,
): ReplicaDatabaseScope | undefined => {
  if (
    !isPlainObject(value) || typeof value.server !== "string" ||
    typeof value.principal !== "string" || typeof value.database !== "string"
  ) return undefined;
  return Object.freeze({
    server: value.server,
    principal: value.principal,
    database: value.database,
  });
};

const isScopeKey = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A FIFO position. Positions start at one; zero is "no position". */
const isSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/**
 * An activation counter, read from a stored row.
 *
 * Absent means `0` — "durable before any activation this build began" — which
 * is exactly what a row written before the counter existed means, so no
 * migration is needed and no queue is orphaned. Every other unreadable value is
 * still a refusal: a row claiming a fractional or negative activation would
 * make the fence comparison meaningless.
 */
const decodeActivation = (value: unknown): number | undefined => {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
};

/** The envelope's version byte, which is exactly one byte. */
const isCodecVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  value <= 255;

/** The durable FIFO cursor of one receiver database. */
export const buildQueueCursor = (
  record: QueueCursorRecord,
): QueueCursorRecord => {
  const receiver = Object.freeze({
    server: record.receiver.server,
    principal: record.receiver.principal,
    database: record.receiver.database,
  });
  // Symmetric with `buildOutboxRecord`: the cursor names the same realm its
  // queue does, so it refuses a non-reversible key on the same terms.
  if (parseMutationPartitionKey(mutationPartitionKey(receiver)) === undefined) {
    reject("the receiver database does not form a reversible partition key");
  }
  return durable(
    Object.freeze({
      partition: record.partition,
      scope: record.scope,
      receiver,
      nextSequence: record.nextSequence,
      sealing: record.sealing === null ? null : Object.freeze({ ...record.sealing }),
      activation: record.activation,
      updatedAt: record.updatedAt,
    }),
    decodeQueueCursor,
    "queue cursor",
  );
};

export const decodeQueueCursor = (
  value: unknown,
): QueueCursorRecord | undefined => {
  if (!isPlainObject(value)) return undefined;
  const receiver = decodeReceiverScope(value.receiver);
  if (
    receiver === undefined || typeof value.partition !== "string" ||
    mutationPartitionKey(receiver) !== value.partition
  ) return undefined;
  if (!isScopeKey(value.scope)) return undefined;
  if (!isSequence(value.nextSequence)) return undefined;
  const sealing = decodeSealing(value.sealing);
  if (sealing === undefined) return undefined;
  const activation = decodeActivation(value.activation);
  if (activation === undefined) return undefined;
  if (!isTimestamp(value.updatedAt)) return undefined;
  return Object.freeze({
    partition: value.partition,
    scope: value.scope,
    receiver,
    nextSequence: value.nextSequence,
    sealing,
    activation,
    updatedAt: value.updatedAt,
  });
};

/** One durable receipt. Slice 1 only ever writes the `queued` shell. */
export const buildReceipt = (record: ReceiptRecord): ReceiptRecord =>
  durable(
    Object.freeze({
      partition: record.partition,
      invocation: record.invocation,
      scope: record.scope,
      state: record.state,
      observation: record.observation,
      activation: record.activation,
      output: record.output,
      mappings: Object.freeze(
        record.mappings.map((mapping) => Object.freeze({ ...mapping })),
      ),
      failure: record.failure === null ? null : Object.freeze({ ...record.failure }),
      updatedAt: record.updatedAt,
    }),
    decodeReceipt,
    "receipt",
  );

export const decodeReceipt = (value: unknown): ReceiptRecord | undefined => {
  if (!isPlainObject(value)) return undefined;
  if (
    typeof value.partition !== "string" ||
    parseMutationPartitionKey(value.partition) === undefined
  ) return undefined;
  if (!isInvocationId(value.invocation) || !isScopeKey(value.scope)) return undefined;
  if (
    value.state !== "queued" && value.state !== "committed" && value.state !== "rejected"
  ) return undefined;
  if (
    value.observation !== null && value.observation !== "unobserved" &&
    value.observation !== "observed"
  ) return undefined;
  const activation = decodeActivation(value.activation);
  if (activation === undefined) return undefined;
  // A receipt with no marker has nothing to fence, so it can carry no stamp: a
  // row that claimed one would be selected by a comparison that means nothing
  // for it.
  if (value.observation === null && activation !== 0) return undefined;
  if (!Array.isArray(value.mappings)) return undefined;
  const mappings: QueuedMapping[] = [];
  const mapped = new Set<string>();
  for (const mapping of value.mappings) {
    if (
      !isPlainObject(mapping) || !isClientRef(mapping.clientRef) ||
      !isEntityId(mapping.entityId) || mapped.has(mapping.clientRef)
    ) return undefined;
    mapped.add(mapping.clientRef);
    mappings.push(
      Object.freeze({ clientRef: mapping.clientRef, entityId: mapping.entityId }),
    );
  }
  if (
    value.failure !== null &&
    (!isPlainObject(value.failure) || typeof value.failure.code !== "string")
  ) return undefined;
  if (!isTimestamp(value.updatedAt)) return undefined;
  let output: JsonValue | null = null;
  if (value.output !== null) {
    try {
      output = jsonSnapshot(value.output, "output", new Set(), false);
    } catch {
      return undefined;
    }
  }
  return Object.freeze({
    partition: value.partition,
    invocation: value.invocation,
    scope: value.scope,
    state: value.state,
    observation: value.observation,
    activation,
    output,
    mappings: Object.freeze(mappings),
    failure: value.failure === null
      ? null
      : Object.freeze({ code: (value.failure as { code: string }).code }),
    updatedAt: value.updatedAt,
  });
};

/** One client ref this device minted, and the slot that allocates it. */
export const buildClientRef = (record: ClientRefRecord): ClientRefRecord =>
  durable(
    Object.freeze({
      partition: record.partition,
      clientRef: record.clientRef,
      invocation: record.invocation,
      slot: record.slot,
      createdAt: record.createdAt,
    }),
    decodeClientRef,
    "client ref",
  );

export const decodeClientRef = (value: unknown): ClientRefRecord | undefined => {
  if (!isPlainObject(value)) return undefined;
  if (
    typeof value.partition !== "string" ||
    parseMutationPartitionKey(value.partition) === undefined
  ) return undefined;
  if (!isClientRef(value.clientRef) || !isInvocationId(value.invocation)) {
    return undefined;
  }
  if (!isAllocationSlotName(value.slot) || !isTimestamp(value.createdAt)) {
    return undefined;
  }
  return Object.freeze({
    partition: value.partition,
    clientRef: value.clientRef,
    invocation: value.invocation,
    slot: value.slot,
    createdAt: value.createdAt,
  });
};

/** One exact authoritative `{ clientRef, entityId }` mapping. */
export const buildClientRefMapping = (
  record: ClientRefMappingRecord,
): ClientRefMappingRecord =>
  durable(
    Object.freeze({
      partition: record.partition,
      clientRef: record.clientRef,
      entityId: record.entityId,
      sealing: Object.freeze({ ...record.sealing }),
      invocation: record.invocation,
      mappedAt: record.mappedAt,
    }),
    decodeClientRefMapping,
    "client ref mapping",
  );
