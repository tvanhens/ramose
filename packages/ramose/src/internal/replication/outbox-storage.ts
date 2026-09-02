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
  buildOptimisticLayer,
  decodeOptimisticLayer,
  MUTATION_LAYERS,
  withLayerState,
  type LayerRows,
  type OptimisticLayerRecord,
} from "./overlay-records.ts";
import type { LeadershipFence } from "./leadership.ts";
import {
  replicaNotice,
  type ReplicaNotice,
  type ReplicaNoticeKind,
} from "./notices.ts";
import type { ProjectionIdentity } from "./projection-binding.ts";
import {
  REPLICA_COMMITTED_HEADS_STORE,
  REPLICA_GENERATIONS_STORE,
  ReplicaFencedError,
  ReplicaScopeUnconfirmedError,
  replicaDatabasePartitionPrefix,
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
  fencedByActivation,
  mappingKey,
  mutationPartitionKey,
  mutationScopePrefix,
  outboxDependencies,
  OutboxInvocationConflict,
  OutboxRecordInvalid,
  planOutbox,
  sameOutboxIntent,
  sealingEpochOf,
  unobservedReceiptOf,
  type ClientRefMappingRecord,
  type ClientRefRecord,
  type OutboxDecisionContext,
  type OutboxDraft,
  type OutboxPartitionPlan,
  type OutboxRecord,
  type QueuedMapping,
  type ReceiptRecord,
  type ReceiptState,
  type SealingEpoch,
  type UnobservedReceipt,
  type UnreadableOutboxRow,
} from "./outbox.ts";

export const MUTATION_OUTBOX = "mutation-outbox-v1";
export const MUTATION_QUEUES = "mutation-queues-v1";
export const MUTATION_RECEIPTS = "mutation-receipts-v1";
export const MUTATION_CLIENT_REFS = "mutation-client-refs-v1";
export const MUTATION_MAPPINGS = "mutation-client-ref-mappings-v1";
export { MUTATION_LAYERS } from "./overlay-records.ts";

const MUTATION_KEYED_FAMILIES = [MUTATION_QUEUES] as const;

const MUTATION_PREFIXED_FAMILIES = [
  MUTATION_OUTBOX,
  MUTATION_RECEIPTS,
  MUTATION_CLIENT_REFS,
  MUTATION_MAPPINGS,
  MUTATION_LAYERS,
] as const;

export const MUTATION_STORE_FAMILIES = [
  ...MUTATION_KEYED_FAMILIES,
  ...MUTATION_PREFIXED_FAMILIES,
] as const;

const BY_INVOCATION = "by-invocation";

const BY_CLIENT_REF = "by-client-ref";

const ENQUEUE_STORES = [
  MUTATION_OUTBOX,
  MUTATION_QUEUES,
  MUTATION_RECEIPTS,
  MUTATION_CLIENT_REFS,
  MUTATION_LAYERS,
  REPLICA_GENERATIONS_STORE,
] as const;

export const createMutationStores = (
  database: IDBDatabase,
  upgrade: IDBTransaction,
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
        if (current.keyPath === path && current.unique) continue;
        store.deleteIndex(index);
      }
      store.createIndex(index, path, { unique: true });
    }
  };
  ensure(MUTATION_QUEUES, "partition");
  ensure(MUTATION_OUTBOX, ["partition", "sequence"], [[BY_INVOCATION, "invocation"]]);
  ensure(MUTATION_RECEIPTS, ["partition", "invocation"], [
    [BY_INVOCATION, "invocation"],
  ]);
  ensure(MUTATION_CLIENT_REFS, ["partition", "clientRef"], [
    [BY_CLIENT_REF, "clientRef"],
  ]);
  ensure(MUTATION_MAPPINGS, ["partition", "clientRef"], [[BY_CLIENT_REF, "clientRef"]]);
  ensure(MUTATION_LAYERS, ["partition", "sequence"], [[BY_INVOCATION, "invocation"]]);
};

export type MutationClearOutcome = {
  readonly queued: number;
  readonly clientRefs: number;
  readonly layers: number;
};

export const clearMutationScope = async (
  transaction: IDBTransaction,
  scope: ReplicaScope,
): Promise<MutationClearOutcome> => {
  const prefix = mutationScopePrefix(scope);
  const [queued, clientRefs, layers] = await Promise.all([
    requestResult<number>(
      transaction.objectStore(MUTATION_OUTBOX).count(compoundPrefixRange(prefix)),
    ),
    requestResult<number>(
      transaction.objectStore(MUTATION_CLIENT_REFS).count(compoundPrefixRange(prefix)),
    ),
    requestResult<number>(
      transaction.objectStore(MUTATION_LAYERS).count(compoundPrefixRange(prefix)),
    ),
  ]);
  for (const family of MUTATION_KEYED_FAMILIES) {
    transaction.objectStore(family).delete(prefixRange(prefix));
  }
  for (const family of MUTATION_PREFIXED_FAMILIES) {
    transaction.objectStore(family).delete(compoundPrefixRange(prefix));
  }
  return Object.freeze({ queued, clientRefs, layers });
};

export type EnqueueOptions = {
  readonly scope: ReplicaScope;
  readonly lease?: ReplicaLease | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly projection?: ProjectionIdentity | undefined;
};

export type ActivationObservationState = {
  readonly partition: string;
  readonly receiver: ReplicaDatabaseScope;
  readonly activation: number;
  readonly unobserved: readonly UnobservedReceipt[];
  readonly settlements: ReadonlyMap<InvocationId, number>;
};

export type ActivationFenceOutcome = {
  readonly receiver: ReplicaDatabaseScope;
  readonly activation: number;
  readonly fenced: readonly InvocationId[];
  readonly confirmed: string;
  readonly layers: readonly OptimisticLayerRecord[];
  readonly unreadable: number;
};

const confirmCommittedHead = async (
  transaction: IDBTransaction,
  receiver: ReplicaDatabaseScope,
): Promise<{ readonly revision: string; readonly settled: number }> => {
  const heads = await requestResult<unknown[]>(
    transaction.objectStore(REPLICA_COMMITTED_HEADS_STORE).getAll(
      prefixRange(replicaDatabasePartitionPrefix(receiver)),
    ),
  );
  let revision: string | undefined;
  let settled: number | undefined;
  for (const head of heads) {
    const stored = head as {
      readonly revision?: unknown;
      readonly settled?: unknown;
    } | null;
    const confirmed = stored?.revision;
    if (typeof confirmed !== "string" || confirmed.length === 0) continue;
    revision ??= confirmed;
    const covered = typeof stored?.settled === "number" && stored.settled >= 0
      ? stored.settled
      : 0;
    settled = settled === undefined ? covered : Math.min(settled, covered);
  }
  if (revision !== undefined) {
    return { revision, settled: settled ?? 0 };
  }
  throw new OutboxRecordInvalid({
    reason: "no committed replica of this receiver database confirms the fenced outcome",
  });
};

export type OutboxRestoration = {
  readonly records: readonly OutboxRecord[];
  readonly unreadable: readonly UnreadableOutboxRow[];
};

export type TerminalAcknowledgement = Extract<
  MutationAcknowledgement,
  { readonly _tag: "Committed" } | { readonly _tag: "Rejected" }
>;

const epochsOf = (
  mapped: ReadonlyMap<string, ClientRefMappingRecord>,
): ReadonlyMap<string, SealingEpoch> =>
  new Map([...mapped].map(([key, record]) => [key, record.sealing] as const));

const sameJsonValue = (left: JsonValue, right: JsonValue): boolean => {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]!));
  }
  if (
    typeof left !== "object" || left === null || typeof right !== "object" ||
    right === null || Array.isArray(right)
  ) return false;
  const fields = left as Readonly<Record<string, JsonValue>>;
  const others = right as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(fields);
  if (keys.length !== Object.keys(others).length) return false;
  return keys.every((key) =>
    Object.hasOwn(others, key) && sameJsonValue(fields[key]!, others[key]!)
  );
};

const sameReceiptOutput = (
  left: JsonValue | null,
  right: JsonValue | null,
): boolean => {
  if (left === null || right === null) return left === right;
  try {
    return canonicalizeJson(left) === canonicalizeJson(right);
  } catch {
    return sameJsonValue(left, right);
  }
};

const sameMappings = (
  left: readonly QueuedMapping[],
  right: readonly QueuedMapping[],
): boolean => {
  if (left.length !== right.length) return false;
  const seen = new Map(left.map((mapping) => [mapping.clientRef, mapping.entityId]));
  return right.every((mapping) => seen.get(mapping.clientRef) === mapping.entityId);
};

export class ClientRefMappingRefused extends Data.TaggedError(
  "ClientRefMappingRefused",
)<{
  readonly partition: string;
  readonly clientRef: string;
  readonly reason:
    | "not-a-ref-pair"
    | "unreadable-handle"
    | "not-allocated-here"
    | "slot-unmapped"
    | "already-mapped";
}> {}

export class IndexedDbOutbox {
  constructor(
    private readonly database: IDBDatabase,
    private readonly boundaries: RuntimeBoundaries,
    private readonly assertScopeLive: (scope: ReplicaScope) => void,
    private readonly leader: (() => LeadershipFence | undefined) | undefined =
      undefined,
    private readonly announce: (notice: ReplicaNotice) => void = () => undefined,
  ) {}

  private announceReceiver(
    kind: ReplicaNoticeKind,
    receiver: ReplicaDatabaseScope,
  ): void {
    this.announce(replicaNotice(kind, receiver, receiver));
  }

  async enqueue(
    draft: OutboxDraft,
    options: EnqueueOptions,
  ): Promise<OutboxRecord> {
    const receiver: ReplicaDatabaseScope = Object.freeze({
      server: draft.receiver.server,
      principal: draft.receiver.principal,
      database: draft.receiver.database,
    });
    const snapshot: OutboxDraft = { ...draft, receiver };
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
      const record = await this.stageEnqueue(
        transaction,
        snapshot,
        options,
        scopeKey,
        partition,
        observed,
      );
      this.announceReceiver("layer", receiver);
      return record;
    } catch (error) {
      await abortTransaction(transaction);
      throw error;
    } finally {
      removeAbort();
    }
  }

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
    lease?.observe(scopeKey, current.generation);
  }

  private async fenceLeadership(transaction: IDBTransaction): Promise<void> {
    const fence = this.leader?.();
    if (fence === undefined) return;
    const held = await requestResult<{ readonly generation: number } | undefined>(
      transaction.objectStore(REPLICA_GENERATIONS_STORE).get(fence.key),
    );
    const generation = held?.generation ?? 0;
    if (generation === fence.epoch) return;
    throw new ReplicaFencedError({
      key: fence.key,
      expected: fence.epoch,
      observed: generation,
    });
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
      if (queued !== undefined && queued.partition !== partition) {
        throw new OutboxInvocationConflict({ invocation: draft.invocation, partition });
      }
      if (queued === undefined) {
        throw new OutboxInvocationConflict({ invocation: draft.invocation, partition });
      }
      if (!sameOutboxIntent(queued, buildOutboxRecord(draft, scopeKey, queued.sequence))) {
        throw new OutboxInvocationConflict({ invocation: draft.invocation, partition });
      }
      await transactionDone(transaction);
      return queued;
    }
    const settled = await requestResult<unknown>(
      transaction.objectStore(MUTATION_RECEIPTS).index(BY_INVOCATION)
        .get(draft.invocation),
    );
    if (settled !== undefined) {
      throw new OutboxInvocationConflict({ invocation: draft.invocation, partition });
    }
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
      sealing: record.sealing ?? current?.sealing ?? null,
      activation: current?.activation ?? 0,
      updatedAt: record.enqueuedAt,
    }));
    transaction.objectStore(MUTATION_RECEIPTS).add(buildReceipt({
      partition,
      invocation: record.invocation,
      scope: scopeKey,
      state: "queued",
      observation: null,
      activation: 0,
      settled: 0,
      output: null,
      mappings: [],
      failure: null,
      updatedAt: record.enqueuedAt,
    }));
    const refs = transaction.objectStore(MUTATION_CLIENT_REFS);
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
    if (options.projection !== undefined) {
      transaction.objectStore(MUTATION_LAYERS).add(buildOptimisticLayer({
        record,
        projection: options.projection,
        createdAt: record.enqueuedAt,
      }));
    }
    await this.boundaries.checkpoint("outbox.enqueue");
    this.assertScopeLive(options.scope);
    await commitTransaction(transaction);
    return record;
  }

  async restore(scope: ReplicaScope): Promise<OutboxRestoration> {
    this.assertScopeLive(scope);
    const transaction = this.database.transaction(MUTATION_OUTBOX, "readonly");
    const restored = await this.readOutbox(transaction, scope);
    await transactionDone(transaction);
    return restored;
  }

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

  async mappedRefs(scope: ReplicaScope): Promise<ReadonlyMap<string, SealingEpoch>> {
    this.assertScopeLive(scope);
    const transaction = this.database.transaction(MUTATION_MAPPINGS, "readonly");
    const mapped = await this.readMappings(transaction, scope);
    await transactionDone(transaction);
    return epochsOf(mapped);
  }

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
      const record = decodeClientRefMapping(value);
      if (record === undefined) continue;
      mapped.set(mappingKey(record.partition, record.clientRef), record);
    }
    return mapped;
  }

  async plan(
    scope: ReplicaScope,
    keyId?: string,
  ): Promise<readonly OutboxPartitionPlan[]> {
    return (await this.submissionPlan(scope, keyId)).plans;
  }

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

  async mappedHandles(
    receiver: ReplicaDatabaseScope,
  ): Promise<ReadonlyMap<string, EntityId>> {
    this.assertScopeLive(receiver);
    const transaction = this.database.transaction(MUTATION_MAPPINGS, "readonly");
    const stored = await requestResult<unknown[]>(
      transaction.objectStore(MUTATION_MAPPINGS).getAll(
        compoundPrefixRange(mutationPartitionKey(receiver)),
      ),
    );
    await transactionDone(transaction);
    const handles = new Map<string, EntityId>();
    for (const value of stored) {
      const record = decodeClientRefMapping(value);
      if (record !== undefined) handles.set(record.clientRef, record.entityId);
    }
    return handles;
  }

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
    return stored === undefined ? undefined : decodeReceipt(stored);
  }

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

  async recordMappings(
    receiver: ReplicaDatabaseScope,
    invocation: InvocationId,
    mappings: readonly QueuedMapping[],
    mappedAt = Date.now(),
  ): Promise<void> {
    const scopeKey = replicaScopeKey(receiver);
    const partition = mutationPartitionKey(receiver);
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
    this.announceReceiver("layer", receiver);
  }

  async acknowledge(
    record: OutboxRecord,
    acknowledgement: TerminalAcknowledgement,
    acknowledgedAt = Date.now(),
  ): Promise<ReceiptRecord> {
    const scopeKey = replicaScopeKey(record.receiver);
    if (scopeKey !== record.scope) {
      throw new OutboxRecordInvalid({
        reason: "the acknowledged record's receiver is outside its own scope",
      });
    }
    const observed = await this.preflightScope(record.receiver);
    const transaction = this.database.transaction(
      [
        MUTATION_OUTBOX,
        MUTATION_QUEUES,
        MUTATION_RECEIPTS,
        MUTATION_MAPPINGS,
        MUTATION_CLIENT_REFS,
        MUTATION_LAYERS,
        REPLICA_GENERATIONS_STORE,
      ],
      "readwrite",
    );
    try {
      await this.fenceScope(transaction, scopeKey, observed, undefined);
      await this.fenceLeadership(transaction);
      const receipt = await this.stageAcknowledgement(
        transaction,
        record,
        acknowledgement,
        acknowledgedAt,
      );
      await this.boundaries.checkpoint("outbox.acknowledge");
      this.assertScopeLive(record.receiver);
      await commitTransaction(transaction);
      this.announceReceiver("receipt", record.receiver);
      this.announceReceiver("layer", record.receiver);
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
    const [stored, cursor] = await Promise.all([
      requestResult<unknown>(receipts.get(key)),
      requestResult<unknown>(
        transaction.objectStore(MUTATION_QUEUES).get(record.partition),
      ),
    ]);
    const decodedCursor = cursor === undefined ? undefined : decodeQueueCursor(cursor);
    if (cursor !== undefined && decodedCursor === undefined) {
      throw new OutboxRecordInvalid({
        reason: "the durable queue cursor of this receiver is unreadable",
      });
    }
    const activation = decodedCursor?.activation ?? 0;
    const current = stored === undefined ? undefined : decodeReceipt(stored);
    if (stored !== undefined && current === undefined) {
      throw new OutboxRecordInvalid({
        reason: "the durable receipt of this invocation is unreadable",
      });
    }
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
        observation: "unobserved",
        activation,
        settled: acknowledgement.settled,
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
        observation: null,
        activation: 0,
        settled: 0,
        output: null,
        mappings: [],
        failure: { code: acknowledgement.code },
        updatedAt: acknowledgedAt,
      });
    if (current.state !== "queued") {
      if (
        current.state !== next.state || current.failure?.code !== next.failure?.code ||
        !sameMappings(current.mappings, next.mappings) ||
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
      const recovered = current.settled === 0 && next.settled > 0
        ? buildReceipt({ ...current, settled: next.settled })
        : current;
      if (recovered !== current) receipts.put(recovered);
      await this.stageLayerOutcome(
        transaction,
        record,
        recovered.state,
        recovered.activation,
        recovered.settled,
      );
      return recovered;
    }
    if (acknowledgement._tag === "Committed") {
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
    await this.stageLayerOutcome(
      transaction,
      record,
      next.state,
      next.activation,
      acknowledgement._tag === "Committed" ? acknowledgement.settled : 0,
    );
    if (acknowledgement._tag === "Rejected") {
      await this.cascadeRejection(transaction, record, acknowledgedAt);
    }
    return next;
  }

  private async stageLayerOutcome(
    transaction: IDBTransaction,
    record: OutboxRecord,
    state: ReceiptState,
    activation: number,
    settled = 0,
  ): Promise<void> {
    const layers = transaction.objectStore(MUTATION_LAYERS);
    const key = [record.partition, record.sequence];
    if (state === "rejected") {
      layers.delete(key);
      return;
    }
    const stored = await requestResult<unknown>(layers.get(key)) ??
      await requestResult<unknown>(
        layers.index(BY_INVOCATION).get(record.invocation),
      );
    if (stored === undefined) return;
    const layer = decodeOptimisticLayer(stored);
    if (layer === undefined) return;
    const outcome = layer.state === "retired" ? "retired" : "committed-unobserved";
    if (
      layer.state === outcome && layer.activation === activation &&
      layer.settled !== undefined && layer.settled >= settled
    ) return;
    layers.put(withLayerState(
      layer,
      outcome,
      layer.state === "retired" ? layer.activation : activation,
      layer.settled === undefined ? settled : Math.max(layer.settled, settled),
    ));
  }

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
        activation: 0,
        settled: 0,
        output: null,
        mappings: [],
        failure: { code: "dependency_rejected" },
        updatedAt: acknowledgedAt,
      }));
      outbox.delete([next.partition, next.sequence]);
      transaction.objectStore(MUTATION_LAYERS).delete([next.partition, next.sequence]);
    }
  }

  async observationState(
    receiver: ReplicaDatabaseScope,
  ): Promise<ActivationObservationState> {
    this.assertScopeLive(receiver);
    const partition = mutationPartitionKey(receiver);
    const transaction = this.database.transaction(
      [MUTATION_QUEUES, MUTATION_RECEIPTS],
      "readonly",
    );
    const [cursor, stored] = await Promise.all([
      requestResult<unknown>(transaction.objectStore(MUTATION_QUEUES).get(partition)),
      requestResult<unknown[]>(
        transaction.objectStore(MUTATION_RECEIPTS).getAll(
          compoundPrefixRange(partition),
        ),
      ),
    ]);
    await transactionDone(transaction);
    const unobserved: UnobservedReceipt[] = [];
    const settlements = new Map<InvocationId, number>();
    for (const value of stored) {
      const receipt = decodeReceipt(value);
      if (receipt === undefined) continue;
      if (receipt.settled > 0) settlements.set(receipt.invocation, receipt.settled);
      const pending = unobservedReceiptOf(receipt);
      if (pending !== undefined) unobserved.push(pending);
    }
    unobserved.sort((left, right) =>
      left.activation - right.activation ||
      (left.invocation < right.invocation ? -1 : left.invocation > right.invocation ? 1 : 0)
    );
    const decoded = cursor === undefined ? undefined : decodeQueueCursor(cursor);
    if (cursor !== undefined && decoded === undefined) {
      throw new OutboxRecordInvalid({
        reason: "the durable queue cursor of this receiver is unreadable",
      });
    }
    return Object.freeze({
      partition,
      receiver,
      activation: decoded?.activation ?? 0,
      unobserved: Object.freeze(unobserved),
      settlements,
    });
  }

  async beginActivation(receiver: ReplicaDatabaseScope): Promise<number> {
    const scopeKey = replicaScopeKey(receiver);
    const partition = mutationPartitionKey(receiver);
    const observed = await this.preflightScope(receiver);
    const transaction = this.database.transaction(
      [MUTATION_QUEUES, REPLICA_GENERATIONS_STORE],
      "readwrite",
    );
    try {
      await this.fenceScope(transaction, scopeKey, observed, undefined);
      const queues = transaction.objectStore(MUTATION_QUEUES);
      const stored = await requestResult<unknown>(queues.get(partition));
      const cursor = stored === undefined ? undefined : decodeQueueCursor(stored);
      if (stored !== undefined && cursor === undefined) {
        throw new OutboxRecordInvalid({
          reason: "the durable queue cursor of this receiver is unreadable",
        });
      }
      const activation = (cursor?.activation ?? 0) + 1;
      queues.put(buildQueueCursor({
        partition,
        scope: scopeKey,
        receiver: cursor?.receiver ?? receiver,
        nextSequence: cursor?.nextSequence ?? 1,
        sealing: cursor?.sealing ?? null,
        activation,
        updatedAt: Date.now(),
      }));
      await this.boundaries.checkpoint("outbox.activation");
      this.assertScopeLive(receiver);
      await commitTransaction(transaction);
      this.announceReceiver("fence", receiver);
      return activation;
    } catch (error) {
      await abortTransaction(transaction);
      throw error;
    }
  }

  async fenceActivation(
    receiver: ReplicaDatabaseScope,
    activation: number,
    observedAt = Date.now(),
  ): Promise<ActivationFenceOutcome> {
    if (!Number.isSafeInteger(activation) || activation < 1) {
      throw new OutboxRecordInvalid({
        reason: "an activation fence needs the durable activation it was begun with",
      });
    }
    const scopeKey = replicaScopeKey(receiver);
    const partition = mutationPartitionKey(receiver);
    const observed = await this.preflightScope(receiver);
    const transaction = this.database.transaction(
      [
        MUTATION_RECEIPTS,
        MUTATION_LAYERS,
        REPLICA_COMMITTED_HEADS_STORE,
        REPLICA_GENERATIONS_STORE,
      ],
      "readwrite",
    );
    try {
      await this.fenceScope(transaction, scopeKey, observed, undefined);
      const confirmed = await confirmCommittedHead(transaction, receiver);
      const receipts = transaction.objectStore(MUTATION_RECEIPTS);
      const layerStore = transaction.objectStore(MUTATION_LAYERS);
      const [stored, layerRows] = await Promise.all([
        requestResult<unknown[]>(receipts.getAll(compoundPrefixRange(partition))),
        requestResult<unknown[]>(layerStore.getAll(compoundPrefixRange(partition))),
      ]);
      const fenced = new Set<InvocationId>();
      for (const value of stored) {
        const receipt = decodeReceipt(value);
        if (receipt === undefined || !fencedByActivation(receipt, activation)) {
          continue;
        }
        receipts.put(buildReceipt({
          ...receipt,
          observation: "observed",
          updatedAt: observedAt,
        }));
        fenced.add(receipt.invocation);
      }
      let unreadable = 0;
      const remaining: OptimisticLayerRecord[] = [];
      for (const value of layerRows) {
        const layer = decodeOptimisticLayer(value);
        if (layer === undefined) {
          unreadable += 1;
          continue;
        }
        if (fenced.has(layer.invocation)) {
          if (
            layer.state === "committed-unobserved" && layer.settled !== undefined &&
            layer.settled > confirmed.settled
          ) {
            const held = withLayerState(layer, "retired", layer.activation);
            layerStore.put(held);
            remaining.push(held);
          } else {
            layerStore.delete([layer.partition, layer.sequence]);
          }
          continue;
        }
        if (
          layer.state === "retired" &&
          (layer.settled === undefined || layer.settled <= confirmed.settled)
        ) {
          layerStore.delete([layer.partition, layer.sequence]);
          continue;
        }
        remaining.push(layer);
      }
      remaining.sort((left, right) => left.sequence - right.sequence);
      await this.boundaries.checkpoint("outbox.fence");
      this.assertScopeLive(receiver);
      await commitTransaction(transaction);
      this.announceReceiver("fence", receiver);
      this.announceReceiver("receipt", receiver);
      return Object.freeze({
        receiver,
        activation,
        fenced: Object.freeze([...fenced]),
        confirmed: confirmed.revision,
        layers: Object.freeze(remaining),
        unreadable,
      });
    } catch (error) {
      await abortTransaction(transaction);
      throw error;
    }
  }

  async optimisticLayers(
    receiver: ReplicaDatabaseScope,
  ): Promise<LayerRows> {
    this.assertScopeLive(receiver);
    const transaction = this.database.transaction(MUTATION_LAYERS, "readonly");
    const stored = await requestResult<unknown[]>(
      transaction.objectStore(MUTATION_LAYERS).getAll(
        compoundPrefixRange(mutationPartitionKey(receiver)),
      ),
    );
    await transactionDone(transaction);
    const rows: OptimisticLayerRecord[] = [];
    let unreadable = 0;
    for (const value of stored) {
      const layer = decodeOptimisticLayer(value);
      if (layer === undefined) unreadable += 1;
      else rows.push(layer);
    }
    rows.sort((left, right) => left.sequence - right.sequence);
    return Object.freeze({ layers: Object.freeze(rows), unreadable });
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
      if (stored === undefined) store.add(repaired);
      else store.put(repaired);
    }
  }
}
