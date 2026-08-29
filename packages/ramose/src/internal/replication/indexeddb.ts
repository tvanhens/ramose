/** Native IndexedDB persistence for one complete logical client replica. */

import * as Result from "effect/Result";
import { type Datom, type DatomValue, ValueTag } from "../core/datom.ts";
import { buildRoots } from "../core/conn.ts";
import { Db, type Roots } from "../core/db.ts";
import { base64ToBytes } from "../core/log.ts";
import { Novelty } from "../core/novelty.ts";
import {
  FIRST_USER_EID,
  type AttributeSpec,
  Schema,
  VALUE_TYPE_IDENTS,
  VALUE_TYPE_NAMES,
  attributeDatoms,
  bootstrapDatoms,
} from "../core/schema.ts";
import { deserializeNode, gzipCodec, serializeNode } from "../core/store.ts";
import type { IndexId } from "../core/datom.ts";
import type { NodeRef, NodeStore, TreeNode } from "../core/tree.ts";
import {
  INITIAL_REPLICA_STORAGE_VERSION,
  type Change,
  type LogicalDatom,
  type LogicalValue,
  type ReplicationIdentity,
  type SnapshotChunk,
  type SnapshotCommit,
  type SnapshotDatom,
  type SnapshotStart,
} from "./protocol.ts";
import {
  applyReplicationFrame,
  emptyClientReplicationState,
  ReplicationTransitionError,
  sameReplicationIdentity,
  type ClientReplicationState,
  type CommittedReplica,
} from "./state.ts";

const DATABASE_VERSION = 2;
const COMMITTED = "replica-committed-v1";
const STAGING = "replica-staging-v1";
const STAGING_CHUNKS = "replica-staging-chunks-v1";
const NODES = "replica-nodes-v1";
const CREDENTIAL_BINDINGS = "replica-credential-bindings-v1";
const USER_T = 2;

export const DEFAULT_REPLICA_DATABASE_NAME = "ramose-replicas";

/** Authenticator and catalog rotation do not create another stored partition. */
export const replicaPartitionKey = (identity: ReplicationIdentity): string =>
  [
    `ramose-replica-v${INITIAL_REPLICA_STORAGE_VERSION}`,
    identity.server,
    identity.principal,
    identity.database,
    identity.readView,
  ].join(":");

type CommittedRecord = {
  readonly partition: string;
  readonly storageVersion: typeof INITIAL_REPLICA_STORAGE_VERSION;
  readonly identity: ReplicationIdentity;
  readonly revision: string;
  readonly datoms: readonly LogicalDatom[];
  readonly attributes: readonly AttributeSpec[];
  /** Server identities only; future client refs use a different store and map. */
  readonly entityIds: readonly (readonly [string, number])[];
  readonly attributeIds: readonly (readonly [string, number])[];
  readonly roots: Roots;
  readonly nextLocalId: number;
};

type StagingRecord = {
  readonly partition: string;
  readonly identity: ReplicationIdentity;
  readonly snapshot: string;
  readonly revision: string;
  /** Committed revision observed atomically when this snapshot began. */
  readonly baseRevision: string | null;
};

type StagingChunkRecord = {
  readonly partition: string;
  readonly index: number;
  readonly datoms: readonly SnapshotDatom[];
};

type NodeRecord = {
  readonly partition: string;
  readonly hash: string;
  readonly body: Uint8Array;
};

type CredentialBindingRecord = {
  readonly fingerprint: string;
  readonly identity: ReplicationIdentity;
};

export type RestoredReplica = {
  readonly db: Db;
  readonly revision: string;
};

export type BoundRestoredReplica = RestoredReplica & {
  readonly identity: ReplicationIdentity;
};

export type ReplicaInstallOptions = {
  /** Aborting leaves the previously committed manifest queryable. */
  readonly signal?: AbortSignal;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new DOMException("transaction aborted", "AbortError")),
      { once: true },
    );
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });

const commitTransaction = async (transaction: IDBTransaction): Promise<void> => {
  transaction.commit();
  await transactionDone(transaction);
};

/** Abort a transaction because this operation intentionally lost a CAS. */
const abortTransaction = async (transaction: IDBTransaction): Promise<void> => {
  const done = transactionDone(transaction);
  transaction.abort();
  try {
    await done;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
  }
};

const abortWithSignal = (
  transaction: IDBTransaction,
  signal: AbortSignal | undefined,
): (() => void) => {
  if (signal === undefined) return () => undefined;
  const abort = (): void => transaction.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
};

const chunkRange = (partition: string): IDBKeyRange =>
  IDBKeyRange.bound([partition, 0], [partition, Number.MAX_SAFE_INTEGER]);

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const normalizeAttributes = (
  attributes: readonly AttributeSpec[],
): readonly AttributeSpec[] => {
  const seen = new Set<string>();
  const bootstrap = Schema.bootstrap();
  return Object.freeze([...attributes]
    .sort((left, right) => left.ident < right.ident ? -1 : left.ident > right.ident ? 1 : 0)
    .map((spec): AttributeSpec => {
      if (!spec.ident.startsWith(":")) throw new Error(`invalid replica attribute ${spec.ident}`);
      if (seen.has(spec.ident)) throw new Error(`duplicate replica attribute ${spec.ident}`);
      seen.add(spec.ident);
      const valueType = typeof spec.valueType === "number"
        ? spec.valueType
        : VALUE_TYPE_IDENTS[spec.valueType];
      if (valueType === undefined || VALUE_TYPE_NAMES[valueType] === undefined) {
        throw new Error(`unknown value type for ${spec.ident}`);
      }
      if (spec.cardinality !== undefined && spec.cardinality !== "one" && spec.cardinality !== "many") {
        throw new Error(`unknown cardinality for ${spec.ident}`);
      }
      if (spec.unique !== undefined && spec.unique !== "identity" && spec.unique !== "value") {
        throw new Error(`unknown uniqueness for ${spec.ident}`);
      }
      const normalized: AttributeSpec = {
        ident: spec.ident,
        valueType,
        cardinality: spec.cardinality ?? "one",
        index: spec.index ?? false,
        isComponent: spec.isComponent ?? false,
        optional: spec.optional ?? false,
        ...(spec.unique === undefined ? {} : { unique: spec.unique }),
        ...(spec.doc === undefined ? {} : { doc: spec.doc }),
      };
      const builtIn = bootstrap.attr(spec.ident);
      if (
        builtIn !== undefined &&
        (builtIn.valueType !== valueType ||
          builtIn.cardinality !== normalized.cardinality ||
          builtIn.index !== normalized.index ||
          builtIn.isComponent !== normalized.isComponent ||
          !!builtIn.optional !== normalized.optional ||
          builtIn.unique !== normalized.unique)
      ) {
        throw new Error(`replica metadata disagrees with built-in ${spec.ident}`);
      }
      return Object.freeze(normalized);
    }));
};

const transition = (
  state: ClientReplicationState,
  frame: Parameters<typeof applyReplicationFrame>[1],
): ClientReplicationState => {
  const result = applyReplicationFrame(state, frame);
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

class IndexedDbNodeStore implements NodeStore {
  constructor(
    private readonly database: IDBDatabase,
    private readonly partition: string,
    private readonly signal?: AbortSignal,
  ) {}

  peek(_hash: string): TreeNode | undefined {
    return undefined;
  }

  async load(ref: NodeRef): Promise<TreeNode> {
    this.signal?.throwIfAborted();
    const transaction = this.database.transaction(NODES, "readonly");
    const record = await requestResult<NodeRecord | undefined>(
      transaction.objectStore(NODES).get([this.partition, ref.hash]),
    );
    await transactionDone(transaction);
    if (record === undefined) throw new Error(`missing replica node ${ref.hash}`);
    return deserializeNode(record.body, gzipCodec);
  }

  async put(index: IndexId, node: TreeNode): Promise<NodeRef> {
    this.signal?.throwIfAborted();
    const { ref, body } = await serializeNode(index, node, gzipCodec);
    this.signal?.throwIfAborted();
    const transaction = this.database.transaction(NODES, "readwrite");
    transaction.objectStore(NODES).put({
      partition: this.partition,
      hash: ref.hash,
      body,
    } satisfies NodeRecord);
    await commitTransaction(transaction);
    return ref;
  }
}

const valueTag = (value: LogicalValue): ValueTag => {
  switch (value.type) {
    case "long": return ValueTag.Long;
    case "double": return ValueTag.Double;
    case "string": return ValueTag.Str;
    case "boolean": return ValueTag.Bool;
    case "ref": return ValueTag.Ref;
    case "uuid": return ValueTag.Uuid;
    case "instant": return ValueTag.Inst;
    case "bytes": return ValueTag.Bytes;
  }
};

const datomValue = (
  value: LogicalValue,
  entities: ReadonlyMap<string, number>,
): DatomValue => {
  switch (value.type) {
    case "double":
      return value.value === "positive-infinity"
        ? Number.POSITIVE_INFINITY
        : value.value === "negative-infinity"
          ? Number.NEGATIVE_INFINITY
          : value.value;
    case "ref": {
      const eid = entities.get(value.value);
      if (eid === undefined) throw new Error("logical reference has no local entity");
      return eid;
    }
    case "bytes": return base64ToBytes(value.value);
    default: return value.value;
  }
};

type Materialized = {
  readonly record: CommittedRecord;
  readonly db: Db;
};

const materialize = async (
  database: IDBDatabase,
  identity: ReplicationIdentity,
  committed: CommittedReplica,
  attributes: readonly AttributeSpec[],
  prior: CommittedRecord | undefined,
  signal?: AbortSignal,
): Promise<Materialized> => {
  signal?.throwIfAborted();
  const partition = replicaPartitionKey(identity);
  const specs = normalizeAttributes(attributes);
  if (prior !== undefined && !sameJson(prior.attributes, specs)) {
    throw new Error("replica attribute metadata changed within one committed read view");
  }
  const attributeIds = new Map<string, number>(prior?.attributeIds ?? []);
  const entities = new Map<string, number>(prior?.entityIds ?? []);
  let nextLocalId = prior?.nextLocalId ?? FIRST_USER_EID;
  const schemaDatoms: Datom[] = [];
  const bootstrap = Schema.bootstrap();
  for (const spec of specs) {
    const builtIn = bootstrap.attr(spec.ident);
    let id = builtIn?.id ?? attributeIds.get(spec.ident);
    if (id === undefined) {
      id = nextLocalId++;
      attributeIds.set(spec.ident, id);
    }
    if (builtIn === undefined) schemaDatoms.push(...attributeDatoms(id, spec, USER_T));
  }

  const logicalEntities = new Set<string>();
  for (const datom of committed.datoms) {
    logicalEntities.add(datom.entity);
    if (datom.value.type === "ref") logicalEntities.add(datom.value.value);
  }
  for (const entity of [...logicalEntities].sort()) {
    if (!entities.has(entity)) entities.set(entity, nextLocalId++);
  }

  const facts: Datom[] = [];
  const schema = bootstrap.clone().apply(schemaDatoms);
  for (const logical of committed.datoms) {
    const e = entities.get(logical.entity);
    const a = bootstrap.attr(logical.field)?.id ?? attributeIds.get(logical.field);
    if (e === undefined || a === undefined) {
      throw new Error(`logical fact references unknown field ${logical.field}`);
    }
    const expected = schema.attr(a)?.valueType;
    const vt = valueTag(logical.value);
    if (expected !== vt) throw new Error(`logical value type disagrees with ${logical.field}`);
    facts.push({ e, a, vt, v: datomValue(logical.value, entities), t: USER_T, op: true });
  }

  const store = new IndexedDbNodeStore(database, partition, signal);
  const roots = await buildRoots(
    store,
    schema,
    bootstrapDatoms().concat(schemaDatoms, facts),
  );
  signal?.throwIfAborted();
  const record: CommittedRecord = {
    partition,
    storageVersion: INITIAL_REPLICA_STORAGE_VERSION,
    identity,
    revision: committed.revision,
    datoms: Object.freeze([...committed.datoms]),
    attributes: Object.freeze(specs),
    entityIds: Object.freeze([...entities]),
    attributeIds: Object.freeze([...attributeIds]),
    roots,
    nextLocalId,
  };
  return {
    record,
    db: new Db({
      // The caller may abort its install controller during cleanup after this
      // value commits; reads from the immutable result must remain usable.
      store: new IndexedDbNodeStore(database, partition),
      roots,
      novelty: new Novelty(),
      basisT: roots.t,
      schema,
      nextEid: nextLocalId,
    }),
  };
};

const dbFromRecord = (database: IDBDatabase, record: CommittedRecord): Db => {
  const schemaDatoms: Datom[] = [];
  const bootstrap = Schema.bootstrap();
  const attributeIds = new Map(record.attributeIds);
  for (const spec of record.attributes) {
    const builtIn = bootstrap.attr(spec.ident);
    const id = builtIn?.id ?? attributeIds.get(spec.ident);
    if (id === undefined) throw new Error(`missing local attribute id for ${spec.ident}`);
    if (builtIn === undefined) schemaDatoms.push(...attributeDatoms(id, spec, USER_T));
  }
  const schema = bootstrap.clone().apply(schemaDatoms);
  return new Db({
    store: new IndexedDbNodeStore(database, record.partition),
    roots: record.roots,
    novelty: new Novelty(),
    basisT: record.roots.t,
    schema,
    nextEid: record.nextLocalId,
  });
};

export class IndexedDbReplicaStorage {
  private constructor(
    readonly name: string,
    private readonly database: IDBDatabase,
  ) {}

  static async open(name = DEFAULT_REPLICA_DATABASE_NAME): Promise<IndexedDbReplicaStorage> {
    const request = indexedDB.open(name, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(COMMITTED)) {
        database.createObjectStore(COMMITTED, { keyPath: "partition" });
      }
      if (!database.objectStoreNames.contains(STAGING)) {
        database.createObjectStore(STAGING, { keyPath: "partition" });
      }
      if (!database.objectStoreNames.contains(STAGING_CHUNKS)) {
        database.createObjectStore(STAGING_CHUNKS, { keyPath: ["partition", "index"] });
      }
      if (!database.objectStoreNames.contains(NODES)) {
        database.createObjectStore(NODES, { keyPath: ["partition", "hash"] });
      }
      if (!database.objectStoreNames.contains(CREDENTIAL_BINDINGS)) {
        database.createObjectStore(CREDENTIAL_BINDINGS, { keyPath: "fingerprint" });
      }
    });
    const database = await requestResult(request);
    database.addEventListener("versionchange", () => database.close());
    return new IndexedDbReplicaStorage(name, database);
  }

  close(): void {
    this.database.close();
  }

  private async committed(identity: ReplicationIdentity): Promise<CommittedRecord | undefined> {
    const transaction = this.database.transaction(COMMITTED, "readonly");
    const record = await requestResult<CommittedRecord | undefined>(
      transaction.objectStore(COMMITTED).get(replicaPartitionKey(identity)),
    );
    await transactionDone(transaction);
    return record;
  }

  async restore(
    identity: ReplicationIdentity,
    attributes: readonly AttributeSpec[],
  ): Promise<RestoredReplica | undefined> {
    const record = await this.committed(identity);
    if (record === undefined) return undefined;
    if (record.storageVersion !== INITIAL_REPLICA_STORAGE_VERSION) return undefined;
    if (!sameJson(record.attributes, normalizeAttributes(attributes))) {
      throw new Error("replica attribute metadata is incompatible with the committed read view");
    }
    return { db: dbFromRecord(this.database, record), revision: record.revision };
  }

  /** Bind only a locally digested credential; the raw credential never enters IndexedDB. */
  async bindCredential(
    fingerprint: string,
    identity: ReplicationIdentity,
    options: ReplicaInstallOptions = {},
  ): Promise<void> {
    const transaction = this.database.transaction(CREDENTIAL_BINDINGS, "readwrite");
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      transaction.objectStore(CREDENTIAL_BINDINGS).put({
        fingerprint,
        identity,
      } satisfies CredentialBindingRecord);
      await commitTransaction(transaction);
    } finally {
      removeAbort();
    }
  }

  /** Restore only the exact partition selected by a prior authenticated binding. */
  async restoreBound(
    fingerprint: string,
    attributes: readonly AttributeSpec[],
  ): Promise<BoundRestoredReplica | undefined> {
    const transaction = this.database.transaction(
      [CREDENTIAL_BINDINGS, COMMITTED],
      "readonly",
    );
    const binding = await requestResult<CredentialBindingRecord | undefined>(
      transaction.objectStore(CREDENTIAL_BINDINGS).get(fingerprint),
    );
    if (binding === undefined) {
      await transactionDone(transaction);
      return undefined;
    }
    const record = await requestResult<CommittedRecord | undefined>(
      transaction.objectStore(COMMITTED).get(replicaPartitionKey(binding.identity)),
    );
    await transactionDone(transaction);
    if (record === undefined || record.storageVersion !== INITIAL_REPLICA_STORAGE_VERSION) {
      return undefined;
    }
    if (!sameJson(record.attributes, normalizeAttributes(attributes))) {
      throw new Error("replica attribute metadata is incompatible with the committed read view");
    }
    if (!sameReplicationIdentity(record.identity, binding.identity)) {
      throw new Error("credential binding does not match its committed replica");
    }
    return {
      identity: binding.identity,
      db: dbFromRecord(this.database, record),
      revision: record.revision,
    };
  }

  /** Reset abandons only incomplete staging; a same-identity committed value survives. */
  async resetStaging(identity: ReplicationIdentity): Promise<void> {
    const partition = replicaPartitionKey(identity);
    const transaction = this.database.transaction([STAGING, STAGING_CHUNKS], "readwrite");
    transaction.objectStore(STAGING).delete(partition);
    transaction.objectStore(STAGING_CHUNKS).delete(chunkRange(partition));
    await commitTransaction(transaction);
  }

  async startSnapshot(frame: SnapshotStart): Promise<void> {
    const partition = replicaPartitionKey(frame.identity);
    const transaction = this.database.transaction(
      [COMMITTED, STAGING, STAGING_CHUNKS],
      "readwrite",
    );
    const staging = transaction.objectStore(STAGING);
    const [current, committed] = await Promise.all([
      requestResult<StagingRecord | undefined>(staging.get(partition)),
      requestResult<CommittedRecord | undefined>(
        transaction.objectStore(COMMITTED).get(partition),
      ),
    ]);
    if (
      current !== undefined && current.snapshot === frame.snapshot &&
      current.revision === frame.revision && sameReplicationIdentity(current.identity, frame.identity)
    ) {
      await transactionDone(transaction);
      return;
    }
    staging.put({
      partition,
      identity: frame.identity,
      snapshot: frame.snapshot,
      revision: frame.revision,
      baseRevision: committed?.revision ?? null,
    } satisfies StagingRecord);
    transaction.objectStore(STAGING_CHUNKS).delete(chunkRange(partition));
    await commitTransaction(transaction);
  }

  async stageSnapshotChunk(frame: SnapshotChunk): Promise<void> {
    const partition = replicaPartitionKey(frame.identity);
    const transaction = this.database.transaction([STAGING, STAGING_CHUNKS], "readwrite");
    const staging = await requestResult<StagingRecord | undefined>(
      transaction.objectStore(STAGING).get(partition),
    );
    if (
      staging === undefined || staging.snapshot !== frame.snapshot ||
      !sameReplicationIdentity(staging.identity, frame.identity)
    ) {
      await abortTransaction(transaction);
      return;
    }
    const chunks = transaction.objectStore(STAGING_CHUNKS);
    const existing = await requestResult<StagingChunkRecord | undefined>(
      chunks.get([partition, frame.index]),
    );
    if (existing !== undefined && !sameJson(existing.datoms, frame.datoms)) {
      await abortTransaction(transaction);
      throw new ReplicationTransitionError({
        reason: "duplicate snapshot chunk changed bytes",
      });
    }
    if (existing === undefined) {
      chunks.put({ partition, index: frame.index, datoms: frame.datoms } satisfies StagingChunkRecord);
    }
    await commitTransaction(transaction);
  }

  private async stagedState(frame: SnapshotCommit): Promise<{
    readonly state: ClientReplicationState;
    readonly baseRevision: string | null;
  }> {
    const partition = replicaPartitionKey(frame.identity);
    const transaction = this.database.transaction([STAGING, STAGING_CHUNKS], "readonly");
    const staging = await requestResult<StagingRecord | undefined>(
      transaction.objectStore(STAGING).get(partition),
    );
    const chunks = await requestResult<StagingChunkRecord[]>(
      transaction.objectStore(STAGING_CHUNKS).getAll(chunkRange(partition)),
    );
    await transactionDone(transaction);
    if (staging === undefined) {
      return { state: emptyClientReplicationState(), baseRevision: null };
    }
    let state = transition(emptyClientReplicationState(), {
      type: "SnapshotStart",
      protocol: 1,
      identity: staging.identity,
      snapshot: staging.snapshot,
      revision: staging.revision,
    });
    for (const chunk of chunks.sort((a, b) => a.index - b.index)) {
      state = transition(state, {
        type: "SnapshotChunk",
        protocol: 1,
        identity: staging.identity,
        snapshot: staging.snapshot,
        index: chunk.index,
        datoms: chunk.datoms,
      });
    }
    return { state: transition(state, frame), baseRevision: staging.baseRevision };
  }

  async commitSnapshot(
    frame: SnapshotCommit,
    attributes: readonly AttributeSpec[],
    options: ReplicaInstallOptions = {},
  ): Promise<RestoredReplica | undefined> {
    const [staged, prior] = await Promise.all([
      this.stagedState(frame),
      this.committed(frame.identity),
    ]);
    const state = staged.state;
    if (state.committed?.revision !== frame.revision) return undefined;
    if ((prior?.revision ?? null) !== staged.baseRevision) return undefined;
    const built = await materialize(
      this.database,
      frame.identity,
      state.committed,
      attributes,
      prior,
      options.signal,
    );
    options.signal?.throwIfAborted();
    const transaction = this.database.transaction(
      [COMMITTED, STAGING, STAGING_CHUNKS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      const current = await requestResult<StagingRecord | undefined>(
        transaction.objectStore(STAGING).get(built.record.partition),
      );
      const currentCommitted = await requestResult<CommittedRecord | undefined>(
        transaction.objectStore(COMMITTED).get(built.record.partition),
      );
      if (
        current === undefined || current.snapshot !== frame.snapshot ||
        current.revision !== frame.revision ||
        !sameReplicationIdentity(current.identity, frame.identity) ||
        (currentCommitted?.revision ?? null) !== staged.baseRevision
      ) {
        await abortTransaction(transaction);
        return undefined;
      }
      transaction.objectStore(COMMITTED).put(built.record);
      transaction.objectStore(STAGING).delete(built.record.partition);
      transaction.objectStore(STAGING_CHUNKS).delete(chunkRange(built.record.partition));
      await commitTransaction(transaction);
    } finally {
      removeAbort();
    }
    return { db: built.db, revision: built.record.revision };
  }

  async applyChange(
    frame: Change,
    options: ReplicaInstallOptions = {},
  ): Promise<RestoredReplica | undefined> {
    const partition = replicaPartitionKey(frame.identity);
    const read = this.database.transaction(COMMITTED, "readonly");
    const prior = await requestResult<CommittedRecord | undefined>(
      read.objectStore(COMMITTED).get(partition),
    );
    await transactionDone(read);
    if (prior === undefined) return undefined;
    const state = transition({
      identity: prior.identity,
      committed: { revision: prior.revision, datoms: prior.datoms },
      closed: false,
    }, frame);
    if (state.committed === undefined || state.committed.revision === prior.revision) {
      return { db: dbFromRecord(this.database, prior), revision: prior.revision };
    }
    const built = await materialize(
      this.database,
      frame.identity,
      state.committed,
      prior.attributes,
      prior,
      options.signal,
    );
    options.signal?.throwIfAborted();
    const write = this.database.transaction(COMMITTED, "readwrite");
    const removeAbort = abortWithSignal(write, options.signal);
    try {
      const current = await requestResult<CommittedRecord | undefined>(
        write.objectStore(COMMITTED).get(partition),
      );
      if (current?.revision !== prior.revision) {
        await abortTransaction(write);
        return undefined;
      }
      write.objectStore(COMMITTED).put(built.record);
      await commitTransaction(write);
    } finally {
      removeAbort();
    }
    return { db: built.db, revision: built.record.revision };
  }
}
