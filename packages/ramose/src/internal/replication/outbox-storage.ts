/**
 * The durable mutation queue at the real browser boundary (#475 slice 1).
 *
 * Five store families, all keyed by the mutation partition key so a scoped
 * clear removes them with one prefix range and no new selection logic:
 *
 *   - `mutation-outbox-v1`     — queued invocations, `[partition, sequence]`
 *   - `mutation-queues-v1`     — one durable FIFO cursor per receiver database
 *   - `mutation-receipts-v1`   — the durable receipt, `[partition, invocation]`
 *   - `mutation-client-refs-v1` — client refs this device minted
 *   - `mutation-client-ref-mappings-v1` — authoritative `{ ref → entityId }`
 *
 * They are *scope*-prefixed, not replica-partition-prefixed. A queued
 * invocation must survive a compatible read-view or schema change, and it must
 * survive eviction of the cached replica it happens to sit beside: evicting a
 * database reclaims cache, while an unsubmitted mutation is the user's own
 * work and #474's eviction contract already promises not to touch it. A
 * scoped clear is the one destructive path that does remove them, atomically
 * and together with the replicas, because that is a deliberate request to
 * delete this principal's local data.
 *
 * Enqueue is one IndexedDB transaction. Either the invocation id, the
 * operation identity and version, the receiver, the target, the validated
 * input, the declared allocation slots, the minted client refs, the queued
 * receipt, and the FIFO position all become durable together, or none of them
 * do — a crash cut in the middle can never leave a half-queued invocation.
 */

import * as Data from "effect/Data";
import type { RuntimeBoundaries } from "../runtime-boundaries.ts";
import type { EntityId, InvocationId } from "../../db/refs.ts";
import { isClientRef, isEntityId } from "../../db/refs.ts";
import { canonicalizeJson } from "../authorization/canonical-json.ts";
import type { JsonValue } from "../authorization/json.ts";
import type { MutationAcknowledgement } from "./submission.ts";
import {
  abortTransaction,
  abortWithSignal,
  commitTransaction,
  compoundPrefixRange,
  prefixRange,
  requestResult,
  transactionDone,
} from "./idb.ts";
import {
  REPLICA_GENERATIONS_STORE,
  ReplicaFencedError,
  ReplicaScopeUnconfirmedError,
  replicaScopeKey,
  type ReplicaDatabaseScope,
  type ReplicaLease,
  type ReplicaScope,
} from "./replica-lifecycle.ts";
import {
  buildClientRef,
  buildClientRefMapping,
  buildOutboxRecord,
  buildQueueCursor,
  buildReceipt,
  ClientRefConflict,
  decodeClientRef,
  decodeClientRefMapping,
  decodeOutboxRecord,
  decodeReceipt,
  decodeQueueCursor,
  mappingKey,
  mutationPartitionKey,
  mutationScopePrefix,
  outboxDependencies,
  OutboxInvocationConflict,
  OutboxRecordInvalid,
  planOutbox,
  sameOutboxIntent,
  sealingEpochOf,
  type ClientRefMappingRecord,
  type ClientRefRecord,
  type OutboxDecisionContext,
  type OutboxDraft,
  type OutboxPartitionPlan,
  type OutboxRecord,
  type QueuedMapping,
  type ReceiptRecord,
  type SealingEpoch,
  type UnreadableOutboxRow,
} from "./outbox.ts";

export const MUTATION_OUTBOX = "mutation-outbox-v1";
export const MUTATION_QUEUES = "mutation-queues-v1";
export const MUTATION_RECEIPTS = "mutation-receipts-v1";
export const MUTATION_CLIENT_REFS = "mutation-client-refs-v1";
export const MUTATION_MAPPINGS = "mutation-client-ref-mappings-v1";

/** Keyed by the mutation partition key alone. */
const MUTATION_KEYED_FAMILIES = [MUTATION_QUEUES] as const;

/** Compound keys whose first element is the mutation partition key. */
const MUTATION_PREFIXED_FAMILIES = [
  MUTATION_OUTBOX,
  MUTATION_RECEIPTS,
  MUTATION_CLIENT_REFS,
  MUTATION_MAPPINGS,
] as const;

/** Every family this slice owns, for the migration and the clear transaction. */
export const MUTATION_STORE_FAMILIES = [
  ...MUTATION_KEYED_FAMILIES,
  ...MUTATION_PREFIXED_FAMILIES,
] as const;

/**
 * Unique index over the invocation id *alone*.
 *
 * An invocation id names exactly one queued invocation, full stop. Indexing it
 * per partition would let one id be queued once per receiver database, so a
 * retry that re-resolved its receiver after losing an enqueue result would
 * execute the same intent twice instead of being refused.
 */
const BY_INVOCATION = "by-invocation";

/**
 * Unique index over the client ref alone.
 *
 * A `ClientRef` is a *global* client identity, so exactly one allocating
 * invocation may claim it. Without this, two invocations in sibling databases
 * could each allocate the same ref and the partitioned mapping store would
 * then bind one identity to two different authoritative entities.
 */
const BY_CLIENT_REF = "by-client-ref";

/**
 * Exactly the stores one enqueue writes, plus the generation record that
 * fences it. The mapping store is deliberately absent: an enqueue never
 * installs a mapping, and naming it would lock out a concurrent
 * acknowledgement for no reason.
 */
const ENQUEUE_STORES = [
  MUTATION_OUTBOX,
  MUTATION_QUEUES,
  MUTATION_RECEIPTS,
  MUTATION_CLIENT_REFS,
  REPLICA_GENERATIONS_STORE,
] as const;

/**
 * Create the mutation families during an `upgradeneeded` transaction.
 *
 * Primary keys stay compound and partition-first so a scoped clear selects one
 * realm by an ordinary prefix range; the global identities are enforced by
 * unique indexes beside them. Indexes are reconciled rather than assumed, so a
 * store created by an earlier build of this same unreleased version gains them.
 */
export const createMutationStores = (
  database: IDBDatabase,
  upgrade: IDBTransaction,
  /**
   * True while upgrading a database an earlier build of this unreleased format
   * created. Those stores predate the global identity indexes, so they may
   * hold rows that violate them; creating a unique index over such a store
   * aborts the upgrade transaction on the first duplicate and the database can
   * then never be opened again. Version 7 only ever existed inside this
   * change, so the rows are discarded rather than reconciled.
   */
  resetLegacy: boolean,
): void => {
  const ensure = (
    name: string,
    keyPath: string | string[],
    indexes: readonly (readonly [string, string])[] = [],
  ): void => {
    const existed = database.objectStoreNames.contains(name);
    const store = existed
      ? upgrade.objectStore(name)
      : database.createObjectStore(name, { keyPath });
    if (existed && resetLegacy) store.clear();
    for (const [index, path] of indexes) {
      if (store.indexNames.contains(index)) {
        const current = store.index(index);
        // An index of the same name but a different key path or uniqueness is
        // a *different* invariant, so it is replaced rather than kept: the
        // earlier build's compound `by-invocation` index would otherwise leave
        // global invocation ownership unenforced under its own name.
        if (current.keyPath === path && current.unique) continue;
        store.deleteIndex(index);
      }
      store.createIndex(index, path, { unique: true });
    }
  };
  ensure(MUTATION_QUEUES, "partition");
  ensure(MUTATION_OUTBOX, ["partition", "sequence"], [[BY_INVOCATION, "invocation"]]);
  // Global invocation ownership lives here, not on the outbox.
  //
  // The outbox's own index only holds while the row does, and an
  // acknowledgement removes the row — so after one, the same globally unique
  // invocation id could be queued again for a *sibling* database, find no
  // outbox row, miss the old receipt under its own `[partition, invocation]`
  // key, and execute a second time. A receipt outlives its row, so it is what
  // can say "this id is spoken for" forever.
  ensure(MUTATION_RECEIPTS, ["partition", "invocation"], [
    [BY_INVOCATION, "invocation"],
  ]);
  ensure(MUTATION_CLIENT_REFS, ["partition", "clientRef"], [
    [BY_CLIENT_REF, "clientRef"],
  ]);
  ensure(MUTATION_MAPPINGS, ["partition", "clientRef"], [[BY_CLIENT_REF, "clientRef"]]);
};

/** What a scoped clear removed from the mutation families. */
export type MutationClearOutcome = {
  readonly queued: number;
  readonly clientRefs: number;
};

/**
 * Stage the mutation half of a scoped clear inside the caller's transaction.
 * The caller commits, so the replicas and the queue disappear together or not
 * at all.
 */
export const clearMutationScope = async (
  transaction: IDBTransaction,
  scope: ReplicaScope,
): Promise<MutationClearOutcome> => {
  const prefix = mutationScopePrefix(scope);
  const [queued, clientRefs] = await Promise.all([
    requestResult<number>(
      transaction.objectStore(MUTATION_OUTBOX).count(compoundPrefixRange(prefix)),
    ),
    requestResult<number>(
      transaction.objectStore(MUTATION_CLIENT_REFS).count(compoundPrefixRange(prefix)),
    ),
  ]);
  for (const family of MUTATION_KEYED_FAMILIES) {
    transaction.objectStore(family).delete(prefixRange(prefix));
  }
  for (const family of MUTATION_PREFIXED_FAMILIES) {
    transaction.objectStore(family).delete(compoundPrefixRange(prefix));
  }
  return Object.freeze({ queued, clientRefs });
};

/** Everything an enqueue supplies beyond the draft itself. */
export type EnqueueOptions = {
  /** The confirmed scope this receiver belongs to. */
  readonly scope: ReplicaScope;
  /**
   * The caller's lifecycle lease. Supplying one makes the enqueue refuse to
   * write into a scope a clear has already fenced, so a queue cannot be
   * repopulated behind a completed `clearLocalData()`.
   */
  readonly lease?: ReplicaLease | undefined;
  readonly signal?: AbortSignal | undefined;
};

/** Rows the queue could not interpret, kept and reported, never submitted. */
export type OutboxRestoration = {
  readonly records: readonly OutboxRecord[];
  readonly unreadable: readonly UnreadableOutboxRow[];
};

/** The two acknowledgements that are terminal, and therefore durable. */
export type TerminalAcknowledgement = Extract<
  MutationAcknowledgement,
  { readonly _tag: "Committed" } | { readonly _tag: "Rejected" }
>;

const epochsOf = (
  mapped: ReadonlyMap<string, ClientRefMappingRecord>,
): ReadonlyMap<string, SealingEpoch> =>
  new Map([...mapped].map(([key, record]) => [key, record.sealing] as const));

/**
 * Whether two terminal receipts carry the same authoritative output.
 *
 * Canonical, so a re-serialization that only reordered object keys is still
 * recognized as the same answer, while any actual difference is a conflict.
 */
const sameReceiptOutput = (
  left: JsonValue | null,
  right: JsonValue | null,
): boolean =>
  left === null || right === null
    ? left === right
    : canonicalizeJson(left) === canonicalizeJson(right);

/** Order-insensitive, because two mappings of one ref cannot both exist. */
const sameMappings = (
  left: readonly QueuedMapping[],
  right: readonly QueuedMapping[],
): boolean => {
  if (left.length !== right.length) return false;
  const seen = new Map(left.map((mapping) => [mapping.clientRef, mapping.entityId]));
  return right.every((mapping) => seen.get(mapping.clientRef) === mapping.entityId);
};

/** A durable mapping this store refused to write. */
export class ClientRefMappingRefused extends Data.TaggedError(
  "ClientRefMappingRefused",
)<{
  readonly partition: string;
  readonly clientRef: string;
  readonly reason:
    | "not-a-ref-pair"
    | "unreadable-handle"
    | "not-allocated-here"
    /** An acknowledgement that leaves a slot this record allocated unmapped. */
    | "slot-unmapped"
    | "already-mapped";
}> {}

/**
 * The durable queue over one already-open replica database handle.
 *
 * It shares the handle deliberately: the enqueue transaction and the scoped
 * clear must be able to name the generation store and the replica families in
 * one transaction, which two separate `IDBDatabase` connections cannot do.
 */
export class IndexedDbOutbox {
  constructor(
    private readonly database: IDBDatabase,
    private readonly boundaries: RuntimeBoundaries,
    /**
     * The owning handle's terminal-scope guard. A handle that has cleared a
     * scope must not be able to repopulate it through the queue either, so
     * every path here asks the same question the replica paths ask.
     */
    private readonly assertScopeLive: (scope: ReplicaScope) => void,
  ) {}

  /**
   * Persist one invocation atomically.
   *
   * The invocation id is minted by the caller *before* this write, so the id
   * exists before anything is observable as queued — and so a retry that lost
   * its completion result reuses the same id instead of queueing the same
   * intent twice.
   *
   * Re-enqueueing an id this partition already holds is therefore *not* an
   * error when the intent is identical: the durable record is returned
   * unchanged and nothing is written. A different intent under the same id is
   * an {@link OutboxInvocationConflict}; the record that already exists is the
   * one that will be submitted.
   */
  async enqueue(
    draft: OutboxDraft,
    options: EnqueueOptions,
  ): Promise<OutboxRecord> {
    // Read exactly once, before anything is checked or derived. The scope
    // check, the partition key, and the durable row must all describe the same
    // receiver: an accessor that answered one database to the scope check and
    // another to the builder would file the row where this scope's restore and
    // its clear can never reach it.
    const receiver: ReplicaDatabaseScope = Object.freeze({
      server: draft.receiver.server,
      principal: draft.receiver.principal,
      database: draft.receiver.database,
    });
    const snapshot: OutboxDraft = { ...draft, receiver };
    // A queue is selected by its receiver's partition key but fenced, cleared,
    // and reported by the supplied scope. If those disagreed, the record would
    // be invisible to this scope's restore and survive its clear while
    // appearing in another principal's queue.
    if (
      receiver.server !== options.scope.server ||
      receiver.principal !== options.scope.principal
    ) {
      throw new OutboxRecordInvalid({
        reason: "the receiver database is outside the supplied confirmed scope",
      });
    }
    const scopeKey = replicaScopeKey(options.scope);
    const partition = mutationPartitionKey(receiver);
    const observed = await this.preflightScope(options.scope);
    const transaction = this.database.transaction([...ENQUEUE_STORES], "readwrite");
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      return await this.stageEnqueue(
        transaction,
        snapshot,
        options,
        scopeKey,
        partition,
        observed,
      );
    } catch (error) {
      // IndexedDB auto-commits a transaction with no pending request, so a
      // failure after the writes are issued must roll them back explicitly or
      // a partially queued invocation would become durable.
      await abortTransaction(transaction);
      throw error;
    } finally {
      removeAbort();
    }
  }

  /**
   * The one precondition every durable mutation write shares.
   *
   * It reads the scope's durable generation *before* the write transaction
   * exists and refuses an unconfirmed scope outright: `clearScope` refuses an
   * unconfirmed scope too, so work queued under one could never be deleted by
   * the scoped API. The returned generation is what
   * {@link IndexedDbOutbox.fenceScope} then requires the write to still see.
   */
  private async preflightScope(scope: ReplicaScope): Promise<number> {
    this.assertScopeLive(scope);
    const scopeKey = replicaScopeKey(scope);
    const transaction = this.database.transaction(
      REPLICA_GENERATIONS_STORE,
      "readonly",
    );
    const record = await requestResult<{ readonly generation: number } | undefined>(
      transaction.objectStore(REPLICA_GENERATIONS_STORE).get(scopeKey),
    );
    await transactionDone(transaction);
    if (record === undefined) {
      throw new ReplicaScopeUnconfirmedError({ scope: scopeKey });
    }
    return record.generation;
  }

  /**
   * The same precondition, re-read inside the write transaction. A clear that
   * committed in between bumps the generation, and a scope whose record
   * vanished is no longer confirmed — either way the write is refused rather
   * than landing behind a deletion.
   */
  private async fenceScope(
    transaction: IDBTransaction,
    scopeKey: string,
    observed: number,
    lease: ReplicaLease | undefined,
  ): Promise<void> {
    const current = await requestResult<{ readonly generation: number } | undefined>(
      transaction.objectStore(REPLICA_GENERATIONS_STORE).get(scopeKey),
    );
    if (current === undefined || current.generation !== observed) {
      throw new ReplicaFencedError({
        key: scopeKey,
        expected: observed,
        observed: current?.generation ?? 0,
      });
    }
    // Only the scope generation guards a queue. Evicting one cached database
    // must not fence the user's unsent work for it.
    lease?.observe(scopeKey, current.generation);
  }

  private async stageEnqueue(
    transaction: IDBTransaction,
    draft: OutboxDraft,
    options: EnqueueOptions,
    scopeKey: string,
    partition: string,
    observed: number,
  ): Promise<OutboxRecord> {
    const outbox = transaction.objectStore(MUTATION_OUTBOX);
    const [, cursor, existing] = await Promise.all([
      this.fenceScope(transaction, scopeKey, observed, options.lease),
      requestResult<unknown>(
        transaction.objectStore(MUTATION_QUEUES).get(partition),
      ),
      requestResult<unknown>(outbox.index(BY_INVOCATION).get(draft.invocation)),
    ]);
    if (existing !== undefined) {
      const queued = decodeOutboxRecord(existing);
      // The same id in another receiver's queue is reuse, never a retry.
      if (queued !== undefined && queued.partition !== partition) {
        throw new OutboxInvocationConflict({ invocation: draft.invocation, partition });
      }
      // An already-durable row this build cannot read is not evidence that the
      // intent matches, so it is refused rather than silently adopted. The row
      // stays exactly where it is; nothing was written.
      if (queued === undefined) {
        throw new OutboxInvocationConflict({ invocation: draft.invocation, partition });
      }
      // Compared at the position the durable row already holds, so a retry
      // does not differ merely by where it would have been queued.
      if (!sameOutboxIntent(queued, buildOutboxRecord(draft, scopeKey, queued.sequence))) {
        throw new OutboxInvocationConflict({ invocation: draft.invocation, partition });
      }
      await transactionDone(transaction);
      return queued;
    }
    // No queued row — but an acknowledgement removes the row while its receipt
    // survives, and that receipt is what still owns this invocation id. Without
    // this, the same id could be queued again for a sibling database, miss the
    // old receipt under its own `[partition, invocation]` key, and execute the
    // same intent a second time.
    const settled = await requestResult<unknown>(
      transaction.objectStore(MUTATION_RECEIPTS).index(BY_INVOCATION)
        .get(draft.invocation),
    );
    if (settled !== undefined) {
      throw new OutboxInvocationConflict({ invocation: draft.invocation, partition });
    }
    // A cursor this build cannot read is not a number to count from.
    const current = cursor === undefined ? undefined : decodeQueueCursor(cursor);
    if (cursor !== undefined && current === undefined) {
      throw new OutboxRecordInvalid({
        reason: "the durable queue cursor of this receiver is unreadable",
      });
    }
    const sequence = current?.nextSequence ?? 1;
    const record = buildOutboxRecord(draft, scopeKey, sequence);
    outbox.add(record);
    transaction.objectStore(MUTATION_QUEUES).put(buildQueueCursor({
      partition,
      scope: scopeKey,
      receiver: record.receiver,
      nextSequence: sequence + 1,
      // The epoch the newest queued handle was minted under. Older records keep
      // their own epoch and quarantine on their own terms; this only records
      // what the queue has most recently seen.
      sealing: record.sealing ?? current?.sealing ?? null,
      updatedAt: record.enqueuedAt,
    }));
    transaction.objectStore(MUTATION_RECEIPTS).add(buildReceipt({
      partition,
      invocation: record.invocation,
      scope: scopeKey,
      state: "queued",
      observation: null,
      output: null,
      mappings: [],
      failure: null,
      updatedAt: record.enqueuedAt,
    }));
    const refs = transaction.objectStore(MUTATION_CLIENT_REFS);
    // A client ref is global, so a claim anywhere else in this database is a
    // conflict, not a retry. Checked explicitly so the caller sees the reason
    // rather than a bare index constraint failure.
    const claims = await Promise.all(
      record.allocations.map((allocation) =>
        requestResult<ClientRefRecord | undefined>(
          refs.index(BY_CLIENT_REF).get(allocation.clientRef),
        )
      ),
    );
    for (const [index, claim] of claims.entries()) {
      if (claim === undefined) continue;
      throw new ClientRefConflict({
        clientRef: record.allocations[index]!.clientRef,
        partition: claim.partition,
      });
    }
    // Every ref this record *depends* on must already be owned by an
    // allocation in this same queue. A dependency owned by a sibling database
    // could never be released — planning reads only this partition's mappings,
    // a mapping cannot be written here without a local allocation, and the
    // global ref index forbids allocating it here later — so the head would be
    // permanently stuck. A ref nobody has allocated is stuck for the same
    // reason: FIFO means no later invocation can supply it.
    const dependencies = outboxDependencies(record).filter((ref) =>
      !record.allocations.some((allocation) => allocation.clientRef === ref)
    );
    const owners = await Promise.all(
      dependencies.map((ref) =>
        requestResult<ClientRefRecord | undefined>(refs.index(BY_CLIENT_REF).get(ref))
      ),
    );
    for (const [index, owner] of owners.entries()) {
      const ref = dependencies[index]!;
      if (owner === undefined) {
        throw new OutboxRecordInvalid({
          reason: "a queued reference names a client ref this device never allocated",
        });
      }
      if (owner.partition !== partition) {
        throw new ClientRefConflict({ clientRef: ref, partition: owner.partition });
      }
      // The allocating invocation may already have been refused. Its ownership
      // row survives as durable history, but the mapping will never exist, so
      // queueing new work behind it would block this database exactly as the
      // rejection cascade exists to prevent.
      const settled = await requestResult<unknown>(
        transaction.objectStore(MUTATION_RECEIPTS).get([partition, owner.invocation]),
      );
      if (decodeReceipt(settled)?.state === "rejected") {
        throw new OutboxRecordInvalid({
          reason: "a queued reference names a client ref whose invocation was rejected",
        });
      }
    }
    for (const allocation of record.allocations) {
      refs.add(buildClientRef({
        partition,
        clientRef: allocation.clientRef,
        invocation: record.invocation,
        slot: allocation.slot,
        createdAt: record.enqueuedAt,
      }));
    }
    // The last boundary before this invocation becomes durable. Inert in
    // production; the source-only testing assembly arms it to cut here, which
    // is what proves the enqueue is all-or-nothing.
    await this.boundaries.checkpoint("outbox.enqueue");
    // Last look before this becomes durable: a clear this handle began while
    // the write was in flight has already marked the scope terminal, and the
    // durable generation cannot see that until the clear itself commits.
    this.assertScopeLive(options.scope);
    await commitTransaction(transaction);
    return record;
  }

  /**
   * Every queued row of one scope. Rows this build cannot decode are reported
   * by their durable primary key rather than dropped, so the plan can hold
   * their queue instead of silently promoting the record behind them.
   */
  async restore(scope: ReplicaScope): Promise<OutboxRestoration> {
    this.assertScopeLive(scope);
    const transaction = this.database.transaction(MUTATION_OUTBOX, "readonly");
    const restored = await this.readOutbox(transaction, scope);
    await transactionDone(transaction);
    return restored;
  }

  /** Stage the queued rows of one scope inside the caller's transaction. */
  private async readOutbox(
    transaction: IDBTransaction,
    scope: ReplicaScope,
  ): Promise<OutboxRestoration> {
    const range = compoundPrefixRange(mutationScopePrefix(scope));
    const store = transaction.objectStore(MUTATION_OUTBOX);
    const [stored, keys] = await Promise.all([
      requestResult<unknown[]>(store.getAll(range)),
      requestResult<IDBValidKey[]>(store.getAllKeys(range)),
    ]);
    const records: OutboxRecord[] = [];
    const unreadable: UnreadableOutboxRow[] = [];
    for (const [index, value] of stored.entries()) {
      const record = decodeOutboxRecord(value);
      if (record !== undefined) {
        records.push(record);
        continue;
      }
      // `getAll` and `getAllKeys` walk the same range in the same order, and
      // the key came from the store's own key path, so it names the row even
      // when the value does not.
      const key = keys[index];
      if (
        Array.isArray(key) && typeof key[0] === "string" &&
        typeof key[1] === "number"
      ) {
        unreadable.push(Object.freeze({ partition: key[0], sequence: key[1] }));
      }
    }
    return Object.freeze({
      records: Object.freeze(records),
      unreadable: Object.freeze(unreadable),
    });
  }

  /**
   * Durable authoritative mappings of one scope, keyed by receiver partition
   * *and* client ref, carrying the sealing epoch each mapped handle was minted
   * under. Both halves matter: a handle is sealed to one database's scope, and
   * a handle minted under a replaced key epoch must quarantine the queue that
   * depends on it rather than look submittable.
   */
  async mappedRefs(scope: ReplicaScope): Promise<ReadonlyMap<string, SealingEpoch>> {
    this.assertScopeLive(scope);
    const transaction = this.database.transaction(MUTATION_MAPPINGS, "readonly");
    const mapped = await this.readMappings(transaction, scope);
    await transactionDone(transaction);
    return epochsOf(mapped);
  }

  /** Stage the durable mappings of one scope inside the caller's transaction. */
  private async readMappings(
    transaction: IDBTransaction,
    scope: ReplicaScope,
  ): Promise<ReadonlyMap<string, ClientRefMappingRecord>> {
    const stored = await requestResult<unknown[]>(
      transaction.objectStore(MUTATION_MAPPINGS).getAll(
        compoundPrefixRange(mutationScopePrefix(scope)),
      ),
    );
    const mapped = new Map<string, ClientRefMappingRecord>();
    for (const value of stored) {
      // A mapping whose persisted epoch disagrees with its own handle is
      // dropped, so its dependents stay blocked instead of being released
      // against a handle this build may not be able to resolve at all.
      const record = decodeClientRefMapping(value);
      if (record === undefined) continue;
      mapped.set(mappingKey(record.partition, record.clientRef), record);
    }
    return mapped;
  }

  /**
   * Reconstruct the exact per-database FIFO plan and the blocked, quarantined,
   * or unreadable state of every row after a restart.
   *
   * `keyId` is the sealing epoch the *current* authenticated session confirmed.
   * Omitting it — offline, or before the first response — never quarantines
   * anything: an unconfirmed epoch is not evidence of a rotation.
   */
  async plan(
    scope: ReplicaScope,
    keyId?: string,
  ): Promise<readonly OutboxPartitionPlan[]> {
    return (await this.submissionPlan(scope, keyId)).plans;
  }

  /**
   * The plan and the exact handles its ready records will submit, read in one
   * transaction.
   *
   * Both halves must come from the same snapshot. Read separately, an
   * acknowledgement committing in between would let the plan report a head
   * blocked on a ref that is already resolved — or, in the other order, report
   * a record ready whose own row the same acknowledgement has already removed.
   */
  async submissionPlan(
    scope: ReplicaScope,
    keyId?: string,
  ): Promise<{
    readonly plans: readonly OutboxPartitionPlan[];
    readonly handles: ReadonlyMap<string, EntityId>;
  }> {
    this.assertScopeLive(scope);
    const transaction = this.database.transaction(
      [MUTATION_OUTBOX, MUTATION_MAPPINGS],
      "readonly",
    );
    const [restored, mapped] = await Promise.all([
      this.readOutbox(transaction, scope),
      this.readMappings(transaction, scope),
    ]);
    await transactionDone(transaction);
    const context: OutboxDecisionContext = { mapped: epochsOf(mapped), keyId };
    return Object.freeze({
      plans: planOutbox(restored.records, restored.unreadable, context),
      handles: new Map(
        [...mapped].map(([key, record]) => [key, record.entityId] as const),
      ),
    });
  }

  /** One durable receipt, or `undefined` when the invocation is unknown here. */
  async receipt(
    receiver: ReplicaDatabaseScope,
    invocation: InvocationId,
  ): Promise<ReceiptRecord | undefined> {
    this.assertScopeLive(receiver);
    const transaction = this.database.transaction(MUTATION_RECEIPTS, "readonly");
    const stored = await requestResult<unknown>(
      transaction.objectStore(MUTATION_RECEIPTS).get([
        mutationPartitionKey(receiver),
        invocation,
      ]),
    );
    await transactionDone(transaction);
    // Read through the same decoder that gates the write. A row this build
    // cannot interpret is reported as absent, never half-read.
    return stored === undefined ? undefined : decodeReceipt(stored);
  }

  /** Every client ref this device minted for one receiver database. */
  async clientRefs(
    receiver: ReplicaDatabaseScope,
  ): Promise<readonly ClientRefRecord[]> {
    this.assertScopeLive(receiver);
    const transaction = this.database.transaction(MUTATION_CLIENT_REFS, "readonly");
    const stored = await requestResult<unknown[]>(
      transaction.objectStore(MUTATION_CLIENT_REFS).getAll(
        compoundPrefixRange(mutationPartitionKey(receiver)),
      ),
    );
    await transactionDone(transaction);
    return Object.freeze(
      stored.map(decodeClientRef).filter((record): record is ClientRefRecord =>
        record !== undefined
      ),
    );
  }

  /**
   * Install exact authoritative `{ clientRef, entityId }` mappings.
   *
   * A mapping is immutable. Every later queued invocation resolves its
   * dependencies through this store, so silently replacing one would redirect
   * work that was already decided at a different entity. A repeated
   * acknowledgement therefore has to present exactly the same allocating
   * invocation and the same handle; anything else is refused, and a client ref
   * this device never registered as an allocation is refused as well.
   *
   * This is the durable primitive the acknowledgement transaction composes into
   * its own atomic write in the next slice; here it exists so the mapping store
   * is a real, written store rather than a declared shape, and so a blocked
   * queue can be observed unblocking across a restart.
   */
  async recordMappings(
    receiver: ReplicaDatabaseScope,
    invocation: InvocationId,
    mappings: readonly QueuedMapping[],
    mappedAt = Date.now(),
  ): Promise<void> {
    const scopeKey = replicaScopeKey(receiver);
    const partition = mutationPartitionKey(receiver);
    // The same precondition an enqueue answers: a mapping is durable work in
    // the same scope, so it must not land behind a clear either.
    const observed = await this.preflightScope(receiver);
    const transaction = this.database.transaction(
      [MUTATION_MAPPINGS, MUTATION_CLIENT_REFS, REPLICA_GENERATIONS_STORE],
      "readwrite",
    );
    try {
      await this.fenceScope(transaction, scopeKey, observed, undefined);
      await this.stageMappings(transaction, partition, invocation, mappings, mappedAt);
    } catch (error) {
      await abortTransaction(transaction);
      throw error;
    }
    await commitTransaction(transaction);
  }

  /**
   * Persist one terminal acknowledgement, atomically.
   *
   * A commit writes the exact `{ clientRef, entityId }` mappings, the receipt
   * with its output and the internal `committed-unobserved` marker, and the
   * removal of the submitted outbox row — in one client transaction, or none of
   * it. A rejection writes the typed failure and removes the row on the same
   * terms. There is no window in which the receipt says committed while the
   * invocation is still queued, or in which a dependent record is released
   * against a mapping whose own receipt did not land.
   *
   * The independent replication stream is *not* in this transaction, which is
   * exactly why the marker exists: the commit is durable here and the causally
   * fresh activation that observes it is a separate, later event (#476).
   *
   * Idempotent by construction. A crash cut anywhere leaves the invocation
   * queued, the next pass resubmits it, and #487's exact replay produces the
   * same acknowledgement; reapplying it converges instead of failing.
   */
  async acknowledge(
    record: OutboxRecord,
    acknowledgement: TerminalAcknowledgement,
    acknowledgedAt = Date.now(),
  ): Promise<ReceiptRecord> {
    const scopeKey = replicaScopeKey(record.receiver);
    // The row's own scope key and its receiver must name the same realm: the
    // enqueue guaranteed it, and fencing on a key the row does not belong to
    // would let an acknowledgement land behind another scope's clear.
    if (scopeKey !== record.scope) {
      throw new OutboxRecordInvalid({
        reason: "the acknowledged record's receiver is outside its own scope",
      });
    }
    const observed = await this.preflightScope(record.receiver);
    const transaction = this.database.transaction(
      [
        MUTATION_OUTBOX,
        MUTATION_RECEIPTS,
        MUTATION_MAPPINGS,
        MUTATION_CLIENT_REFS,
        REPLICA_GENERATIONS_STORE,
      ],
      "readwrite",
    );
    try {
      await this.fenceScope(transaction, scopeKey, observed, undefined);
      const receipt = await this.stageAcknowledgement(
        transaction,
        record,
        acknowledgement,
        acknowledgedAt,
      );
      // The last boundary before the acknowledgement becomes durable. Inert in
      // production; the source-only testing assembly arms it to cut here, which
      // is what proves receipt, mappings, marker, and removal are one write.
      await this.boundaries.checkpoint("outbox.acknowledge");
      this.assertScopeLive(record.receiver);
      await commitTransaction(transaction);
      return receipt;
    } catch (error) {
      await abortTransaction(transaction);
      throw error;
    }
  }

  private async stageAcknowledgement(
    transaction: IDBTransaction,
    record: OutboxRecord,
    acknowledgement: TerminalAcknowledgement,
    acknowledgedAt: number,
  ): Promise<ReceiptRecord> {
    const receipts = transaction.objectStore(MUTATION_RECEIPTS);
    const key = [record.partition, record.invocation];
    const stored = await requestResult<unknown>(receipts.get(key));
    const current = stored === undefined ? undefined : decodeReceipt(stored);
    if (stored !== undefined && current === undefined) {
      throw new OutboxRecordInvalid({
        reason: "the durable receipt of this invocation is unreadable",
      });
    }
    // The enqueue wrote this row in the same transaction that queued the
    // invocation, so its absence means the acknowledgement is for work this
    // device does not own.
    if (current === undefined) {
      throw new OutboxRecordInvalid({
        reason: "no durable receipt exists for this invocation",
      });
    }
    const next = acknowledgement._tag === "Committed"
      ? buildReceipt({
        partition: record.partition,
        invocation: record.invocation,
        scope: current.scope,
        state: "committed",
        // The internal reconciliation marker #476 consumes. It is written in
        // this transaction and cleared only by a causally fresh activation.
        observation: "unobserved",
        output: acknowledgement.output,
        mappings: acknowledgement.mappings,
        failure: null,
        updatedAt: acknowledgedAt,
      })
      : buildReceipt({
        partition: record.partition,
        invocation: record.invocation,
        scope: current.scope,
        state: "rejected",
        // A rejection needs no observation fence: nothing was committed.
        observation: null,
        output: null,
        mappings: [],
        failure: { code: acknowledgement.code },
        updatedAt: acknowledgedAt,
      });
    if (current.state !== "queued") {
      // Converged already. A repeated acknowledgement must present exactly the
      // same terminal answer; anything else means two different results were
      // claimed for one invocation, and the durable one wins.
      if (
        current.state !== next.state || current.failure?.code !== next.failure?.code ||
        !sameMappings(current.mappings, next.mappings) ||
        // The output too. Two passes can be in flight at once, and while an
        // incompatible responder is being rolled they can come back with the
        // same mappings and different results. Omitting this would silently
        // accept the second as an exact replay and leave the first durable —
        // a wrong user-visible result with no request left to replay for the
        // right one. Compared canonically, so a re-serialization that only
        // reordered keys is still the same answer.
        !sameReceiptOutput(current.output, next.output)
      ) {
        throw new OutboxInvocationConflict({
          invocation: record.invocation,
          partition: record.partition,
        });
      }
      transaction.objectStore(MUTATION_OUTBOX).delete([
        record.partition,
        record.sequence,
      ]);
      return current;
    }
    if (acknowledgement._tag === "Committed") {
      // Every slot this record allocated has to come back mapped. Removing the
      // outbox row while a registered client ref stays unresolvable would
      // block every dependent invocation forever, with nothing left in the
      // queue to explain why. Over-supply is refused separately, by
      // `stageMappings`: a ref this invocation does not own is not mappable
      // here at all.
      const mapped = new Set(
        acknowledgement.mappings.map((mapping) => mapping.clientRef),
      );
      for (const allocation of record.allocations) {
        if (!mapped.has(allocation.clientRef)) {
          throw new ClientRefMappingRefused({
            partition: record.partition,
            clientRef: allocation.clientRef,
            reason: "slot-unmapped",
          });
        }
      }
      await this.stageMappings(
        transaction,
        record.partition,
        record.invocation,
        acknowledgement.mappings,
        acknowledgedAt,
      );
    }
    receipts.put(next);
    transaction.objectStore(MUTATION_OUTBOX).delete([
      record.partition,
      record.sequence,
    ]);
    if (acknowledgement._tag === "Rejected") {
      await this.cascadeRejection(transaction, record, acknowledgedAt);
    }
    return next;
  }

  /**
   * Reject everything that can now never be submitted, in the same transaction.
   *
   * A rejected invocation's allocation slots will never be mapped: the only
   * queued record that could have produced them is the one just removed. Any
   * record depending on those refs would become the FIFO head, be reported
   * blocked on a ref nothing can ever resolve, and hold its database forever
   * — and so would anything depending on *its* allocations, transitively.
   *
   * A rejection is therefore not a per-record event: it is a cut through the
   * dependency graph, and the whole cut has to become terminal together or the
   * queue is left in a state only a repair could clear.
   */
  private async cascadeRejection(
    transaction: IDBTransaction,
    rejected: OutboxRecord,
    acknowledgedAt: number,
  ): Promise<void> {
    const unresolvable = new Set<string>(
      rejected.allocations.map((allocation) => allocation.clientRef),
    );
    if (unresolvable.size === 0) return;
    const outbox = transaction.objectStore(MUTATION_OUTBOX);
    const receipts = transaction.objectStore(MUTATION_RECEIPTS);
    const stored = await requestResult<unknown[]>(
      outbox.getAll(compoundPrefixRange(rejected.partition)),
    );
    // An undecodable row already holds this queue as `unreadable`, and its
    // dependencies cannot be read, so it is left exactly where it is.
    const pending = stored
      .map(decodeOutboxRecord)
      .filter((candidate): candidate is OutboxRecord =>
        candidate !== undefined && candidate.invocation !== rejected.invocation
      );
    for (;;) {
      const next = pending.find((candidate) =>
        outboxDependencies(candidate).some((ref) => unresolvable.has(ref))
      );
      if (next === undefined) return;
      pending.splice(pending.indexOf(next), 1);
      for (const allocation of next.allocations) {
        unresolvable.add(allocation.clientRef);
      }
      receipts.put(buildReceipt({
        partition: next.partition,
        invocation: next.invocation,
        scope: next.scope,
        state: "rejected",
        observation: null,
        output: null,
        mappings: [],
        // Typed, and distinct from the refusal that started the cut: this
        // invocation was never submitted at all.
        failure: { code: "dependency_rejected" },
        updatedAt: acknowledgedAt,
      }));
      outbox.delete([next.partition, next.sequence]);
    }
  }

  private async stageMappings(
    transaction: IDBTransaction,
    partition: string,
    invocation: InvocationId,
    mappings: readonly QueuedMapping[],
    mappedAt: number,
  ): Promise<void> {
    const store = transaction.objectStore(MUTATION_MAPPINGS);
    const refs = transaction.objectStore(MUTATION_CLIENT_REFS);
    // Materialized once, before anything is validated or looked up. The same
    // rule the input snapshot follows: an accessor or proxy that answered one
    // ref to the ownership check and another to the builder would install an
    // immutable mapping for a ref this invocation does not own, and the ref
    // that does own it could then never be mapped at all.
    const claims = mappings.map((mapping) => ({
      clientRef: mapping.clientRef,
      entityId: mapping.entityId,
    }));
    for (const claim of claims) {
      const { clientRef: ref, entityId } = claim;
      if (!isClientRef(ref) || !isEntityId(entityId)) {
        throw new ClientRefMappingRefused({
          partition,
          clientRef: String(ref),
          reason: "not-a-ref-pair",
        });
      }
      const sealing = sealingEpochOf(entityId);
      if (sealing === undefined) {
        throw new ClientRefMappingRefused({
          partition,
          clientRef: ref,
          reason: "unreadable-handle",
        });
      }
      // Everything else about the row — including its timestamp — is the
      // canonical builder's business, below.
      const key = [partition, ref];
      const [allocation, stored] = await Promise.all([
        requestResult<ClientRefRecord | undefined>(refs.get(key)),
        requestResult<unknown>(store.get(key)),
      ]);
      if (allocation === undefined || allocation.invocation !== invocation) {
        throw new ClientRefMappingRefused({
          partition,
          clientRef: ref,
          reason: "not-allocated-here",
        });
      }
      // Read through the same decoder that every reader uses. Comparing the
      // raw fields instead would let a row that *looks* right but does not
      // decode be treated as already installed: planning drops it, so every
      // dependent would block forever — and the acknowledgement would by then
      // have removed the one queued record that could have replayed for it.
      const current = stored === undefined
        ? undefined
        : decodeClientRefMapping(stored);
      if (current !== undefined) {
        if (current.invocation !== invocation || current.entityId !== entityId) {
          throw new ClientRefMappingRefused({
            partition,
            clientRef: ref,
            reason: "already-mapped",
          });
        }
        continue;
      }
      const repaired = buildClientRefMapping({
        partition,
        clientRef: ref,
        entityId,
        sealing,
        invocation,
        mappedAt,
      });
      // An unreadable row holds no meaning to preserve, and this
      // acknowledgement is the authoritative answer for exactly this ref, so
      // it is repaired rather than refused: refusing would strand the queue on
      // a row nothing can ever fix.
      if (stored === undefined) store.add(repaired);
      else store.put(repaired);
    }
  }
}
