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
import type { ClientRef, EntityId, InvocationId } from "../../db/refs.ts";
import { isClientRef, isEntityId } from "../../db/refs.ts";
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
  ReplicaScopeUnconfirmedError,
  replicaScopeKey,
  type ReplicaDatabaseScope,
  type ReplicaLease,
  type ReplicaScope,
} from "./replica-lifecycle.ts";
import {
  buildOutboxRecord,
  ClientRefConflict,
  decodeClientRefMapping,
  decodeOutboxRecord,
  mappingKey,
  mutationPartitionKey,
  mutationScopePrefix,
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
  type QueueCursorRecord,
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
): void => {
  const ensure = (
    name: string,
    keyPath: string | string[],
    indexes: readonly (readonly [string, string])[] = [],
  ): void => {
    const store = database.objectStoreNames.contains(name)
      ? upgrade.objectStore(name)
      : database.createObjectStore(name, { keyPath });
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
  ensure(MUTATION_RECEIPTS, ["partition", "invocation"]);
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
    this.assertScopeLive(options.scope);
    // A queue is selected by its receiver's partition key but fenced, cleared,
    // and reported by the supplied scope. If those disagreed, the record would
    // be invisible to this scope's restore and survive its clear while
    // appearing in another principal's queue.
    if (
      draft.receiver.server !== options.scope.server ||
      draft.receiver.principal !== options.scope.principal
    ) {
      throw new OutboxRecordInvalid({
        reason: "the receiver database is outside the supplied confirmed scope",
      });
    }
    const scopeKey = replicaScopeKey(options.scope);
    const partition = mutationPartitionKey(draft.receiver);
    const transaction = this.database.transaction([...ENQUEUE_STORES], "readwrite");
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      return await this.stageEnqueue(transaction, draft, options, scopeKey, partition);
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

  private async stageEnqueue(
    transaction: IDBTransaction,
    draft: OutboxDraft,
    options: EnqueueOptions,
    scopeKey: string,
    partition: string,
  ): Promise<OutboxRecord> {
    const generations = transaction.objectStore(REPLICA_GENERATIONS_STORE);
    const outbox = transaction.objectStore(MUTATION_OUTBOX);
    const [fence, cursor, existing] = await Promise.all([
      requestResult<{ readonly generation: number } | undefined>(
        generations.get(scopeKey),
      ),
      requestResult<QueueCursorRecord | undefined>(
        transaction.objectStore(MUTATION_QUEUES).get(partition),
      ),
      requestResult<unknown>(outbox.index(BY_INVOCATION).get(draft.invocation)),
    ]);
    // Only a scope an authenticated response confirmed may hold durable work:
    // `clearScope` refuses an unconfirmed scope, so queueing under one would
    // create local data the deletion API can never select.
    if (fence === undefined) throw new ReplicaScopeUnconfirmedError({ scope: scopeKey });
    // Only the scope generation guards a queue. Evicting one cached database
    // must not fence the user's unsent work for it.
    options.lease?.observe(scopeKey, fence.generation);
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
    const sequence = cursor?.nextSequence ?? 1;
    const record = buildOutboxRecord(draft, scopeKey, sequence);
    outbox.add(record);
    transaction.objectStore(MUTATION_QUEUES).put({
      partition,
      scope: scopeKey,
      receiver: record.receiver,
      nextSequence: sequence + 1,
      // The epoch the newest queued handle was minted under. Older records keep
      // their own epoch and quarantine on their own terms; this only records
      // what the queue has most recently seen.
      sealing: record.sealing ?? cursor?.sealing ?? null,
      updatedAt: record.enqueuedAt,
    } satisfies QueueCursorRecord);
    transaction.objectStore(MUTATION_RECEIPTS).add({
      partition,
      invocation: record.invocation,
      scope: scopeKey,
      state: "queued",
      observation: null,
      output: null,
      mappings: [],
      failure: null,
      updatedAt: record.enqueuedAt,
    } satisfies ReceiptRecord);
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
    for (const allocation of record.allocations) {
      refs.add({
        partition,
        clientRef: allocation.clientRef,
        invocation: record.invocation,
        slot: allocation.slot,
        createdAt: record.enqueuedAt,
      } satisfies ClientRefRecord);
    }
    // The last boundary before this invocation becomes durable. Inert in
    // production; the source-only testing assembly arms it to cut here, which
    // is what proves the enqueue is all-or-nothing.
    await this.boundaries.checkpoint("outbox.enqueue");
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
    const range = compoundPrefixRange(mutationScopePrefix(scope));
    const transaction = this.database.transaction(MUTATION_OUTBOX, "readonly");
    const store = transaction.objectStore(MUTATION_OUTBOX);
    const [stored, keys] = await Promise.all([
      requestResult<unknown[]>(store.getAll(range)),
      requestResult<IDBValidKey[]>(store.getAllKeys(range)),
    ]);
    await transactionDone(transaction);
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
    const stored = await requestResult<unknown[]>(
      transaction.objectStore(MUTATION_MAPPINGS).getAll(
        compoundPrefixRange(mutationScopePrefix(scope)),
      ),
    );
    await transactionDone(transaction);
    const mapped = new Map<string, SealingEpoch>();
    for (const value of stored) {
      // A mapping whose persisted epoch disagrees with its own handle is
      // dropped, so its dependents stay blocked instead of being released
      // against a handle this build may not be able to resolve at all.
      const record = decodeClientRefMapping(value);
      if (record === undefined) continue;
      mapped.set(mappingKey(record.partition, record.clientRef), record.sealing);
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
    const [restored, mapped] = await Promise.all([
      this.restore(scope),
      this.mappedRefs(scope),
    ]);
    const context: OutboxDecisionContext = { mapped, keyId };
    return planOutbox(restored.records, restored.unreadable, context);
  }

  /** One durable receipt, or `undefined` when the invocation is unknown here. */
  async receipt(
    receiver: ReplicaDatabaseScope,
    invocation: InvocationId,
  ): Promise<ReceiptRecord | undefined> {
    this.assertScopeLive(receiver);
    const transaction = this.database.transaction(MUTATION_RECEIPTS, "readonly");
    const record = await requestResult<ReceiptRecord | undefined>(
      transaction.objectStore(MUTATION_RECEIPTS).get([
        mutationPartitionKey(receiver),
        invocation,
      ]),
    );
    await transactionDone(transaction);
    return record;
  }

  /** Every client ref this device minted for one receiver database. */
  async clientRefs(
    receiver: ReplicaDatabaseScope,
  ): Promise<readonly ClientRefRecord[]> {
    this.assertScopeLive(receiver);
    const transaction = this.database.transaction(MUTATION_CLIENT_REFS, "readonly");
    const records = await requestResult<ClientRefRecord[]>(
      transaction.objectStore(MUTATION_CLIENT_REFS).getAll(
        compoundPrefixRange(mutationPartitionKey(receiver)),
      ),
    );
    await transactionDone(transaction);
    return records;
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
    this.assertScopeLive(receiver);
    const partition = mutationPartitionKey(receiver);
    const transaction = this.database.transaction(
      [MUTATION_MAPPINGS, MUTATION_CLIENT_REFS],
      "readwrite",
    );
    try {
      await this.stageMappings(transaction, partition, invocation, mappings, mappedAt);
    } catch (error) {
      await abortTransaction(transaction);
      throw error;
    }
    await commitTransaction(transaction);
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
    for (const mapping of mappings) {
      if (!isClientRef(mapping.clientRef) || !isEntityId(mapping.entityId)) {
        throw new ClientRefMappingRefused({
          partition,
          clientRef: String(mapping.clientRef),
          reason: "not-a-ref-pair",
        });
      }
      const sealing = sealingEpochOf(mapping.entityId);
      if (sealing === undefined) {
        throw new ClientRefMappingRefused({
          partition,
          clientRef: mapping.clientRef,
          reason: "unreadable-handle",
        });
      }
      const key = [partition, mapping.clientRef];
      const [allocation, current] = await Promise.all([
        requestResult<ClientRefRecord | undefined>(refs.get(key)),
        requestResult<ClientRefMappingRecord | undefined>(store.get(key)),
      ]);
      if (allocation === undefined || allocation.invocation !== invocation) {
        throw new ClientRefMappingRefused({
          partition,
          clientRef: mapping.clientRef,
          reason: "not-allocated-here",
        });
      }
      if (current !== undefined) {
        if (
          current.invocation !== invocation || current.entityId !== mapping.entityId
        ) {
          throw new ClientRefMappingRefused({
            partition,
            clientRef: mapping.clientRef,
            reason: "already-mapped",
          });
        }
        continue;
      }
      store.add({
        partition,
        clientRef: mapping.clientRef as ClientRef,
        entityId: mapping.entityId as EntityId,
        sealing: sealing as SealingEpoch,
        invocation,
        mappedAt,
      } satisfies ClientRefMappingRecord);
    }
  }
}
