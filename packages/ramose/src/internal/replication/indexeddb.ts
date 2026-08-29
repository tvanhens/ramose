/** Native IndexedDB persistence for one complete logical client replica. */

import * as Result from "effect/Result";
import type { ReadCompatibilityHash } from "../authorization/identities.ts";
import { type Datom, type DatomValue, ValueTag } from "../core/datom.ts";
import { buildRoots } from "../core/conn.ts";
import { Db, type Roots } from "../core/db.ts";
import { base64ToBytes } from "../core/log.ts";
import { Novelty } from "../core/novelty.ts";
import { FIRST_USER_EID, type AttributeSpec, Schema } from "../core/schema.ts";
import { deserializeNode, gzipCodec, serializeNode } from "../core/store.ts";
import type { IndexId } from "../core/datom.ts";
import type { NodeRef, NodeStore, TreeNode } from "../core/tree.ts";
import {
  REPLICA_STORAGE_VERSION,
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
  replicaAttributeDatoms,
  replicaAttributes,
  replicaBootstrapDatoms,
  sameReplicaAttributes,
  type ReplicaAttributeSpec,
} from "./replica-schema.ts";
import type { ReplicaRouteSlot } from "./route-slot.ts";
import {
  applyReplicationFrame,
  emptyClientReplicationState,
  ReplicationTransitionError,
  sameReplicationIdentity,
  type ClientReplicationState,
  type CommittedReplica,
} from "./state.ts";

/** The IndexedDB version that introduced replica storage version 2. */
const STORAGE_V2_DATABASE_VERSION = 5;
const DATABASE_VERSION = STORAGE_V2_DATABASE_VERSION;
const COMMITTED = "replica-committed-v1";
const COMMITTED_HEADS = "replica-committed-heads-v1";
const STAGING = "replica-staging-v1";
const STAGING_CHUNKS = "replica-staging-chunks-v1";
const NODES = "replica-nodes-v1";
const CREDENTIAL_BINDINGS = "replica-credential-bindings-v1";
const CACHE_CANDIDATES = "replica-cache-candidates-v1";
const ROUTE_SLOTS = "replica-route-slots-v1";
const USER_T = 2;

/**
 * Every store family this storage format owns. The pre-public migration resets
 * exactly these; future mutation stores (#475/#476) are separate families that
 * a later migration must decide about on its own.
 */
const REPLICA_STORE_FAMILIES = [
  COMMITTED,
  COMMITTED_HEADS,
  STAGING,
  STAGING_CHUNKS,
  NODES,
  CREDENTIAL_BINDINGS,
  CACHE_CANDIDATES,
  ROUTE_SLOTS,
] as const;

export const DEFAULT_REPLICA_DATABASE_NAME = "ramose-replicas";

/** Authenticator and catalog rotation do not create another stored partition. */
export const replicaPartitionKey = (identity: ReplicationIdentity): string =>
  [
    `ramose-replica-v${REPLICA_STORAGE_VERSION}`,
    identity.server,
    identity.principal,
    identity.database,
    identity.readView,
    identity.readCompatibilityHash,
  ].join(":");

type CommittedRecord = {
  readonly partition: string;
  readonly storageVersion: typeof REPLICA_STORAGE_VERSION;
  readonly identity: ReplicationIdentity;
  readonly readCompatibilityHash: ReadCompatibilityHash;
  readonly revision: string;
  readonly datoms: readonly LogicalDatom[];
  /** Documentation-free by construction; docs live in the client catalog. */
  readonly attributes: readonly ReplicaAttributeSpec[];
  /** Server identities only; future client refs use a different store and map. */
  readonly entityIds: readonly (readonly [string, number])[];
  readonly attributeIds: readonly (readonly [string, number])[];
  readonly roots: Roots;
  readonly nextLocalId: number;
};

type CommittedHeadRecord = {
  readonly partition: string;
  readonly storageVersion: typeof REPLICA_STORAGE_VERSION;
  readonly identity: ReplicationIdentity;
  readonly readCompatibilityHash: ReadCompatibilityHash;
  readonly revision: string;
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

type CacheCandidateRecord = {
  readonly selector: string;
  readonly routeSlot: ReplicaRouteSlot;
  readonly identity: ReplicationIdentity;
};

/**
 * One durable observation that a path text resolved to a confirmed stable
 * route slot. It is written only from an authenticated response, so an offline
 * client cannot discover a rename this table has never observed; it then falls
 * back to the provisional path slot and reuses nothing. #477 replaces the
 * lookup with an interned graph handle resolved against the parent replica.
 */
type RouteSlotRecord = {
  readonly scope: string;
  readonly pathKey: string;
  readonly slot: ReplicaRouteSlot;
};

export type ReplicaRouteObservation = {
  readonly scope: string;
  readonly pathKey: string;
};

const committedHead = (record: CommittedRecord): CommittedHeadRecord => ({
  partition: record.partition,
  storageVersion: record.storageVersion,
  identity: record.identity,
  readCompatibilityHash: record.readCompatibilityHash,
  revision: record.revision,
});

export type RestoredReplica = {
  readonly db: Db;
  readonly revision: string;
};

export type BoundRestoredReplica = RestoredReplica & {
  readonly identity: ReplicationIdentity;
};

/** Authenticated manifest metadata that cannot construct or expose a Db. */
export type ReplicaCacheCandidate = {
  readonly identity: ReplicationIdentity;
  readonly revision: string;
};

export type ReplicaCacheCandidateKey = {
  readonly selector: string;
  readonly routeSlot: ReplicaRouteSlot;
};

/** Everything one authenticated response may rebind, in one transaction. */
export type ReplicaAuthenticatedBinding = {
  readonly fingerprint: string;
  readonly identity: ReplicationIdentity;
  readonly candidateKey?: ReplicaCacheCandidateKey | undefined;
  /** Re-key this observed path text onto the confirmed stable route slot. */
  readonly route?: (ReplicaRouteObservation & {
    readonly slot: ReplicaRouteSlot;
  }) | undefined;
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

const nodeRange = (partition: string): IDBKeyRange =>
  IDBKeyRange.bound([partition, ""], [partition, "\uffff"]);

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

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
  const specs = replicaAttributes(attributes);
  if (prior !== undefined && !sameReplicaAttributes(prior.attributes, specs)) {
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
    if (builtIn === undefined) schemaDatoms.push(...replicaAttributeDatoms(id, spec, USER_T));
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
    replicaBootstrapDatoms().concat(schemaDatoms, facts),
  );
  signal?.throwIfAborted();
  const record: CommittedRecord = {
    partition,
    storageVersion: REPLICA_STORAGE_VERSION,
    identity,
    readCompatibilityHash: identity.readCompatibilityHash,
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

const dbFromRecord = (
  database: IDBDatabase,
  record: CommittedRecord,
  expected: ReadCompatibilityHash,
): Db => {
  if (
    record.readCompatibilityHash !== expected ||
    record.identity.readCompatibilityHash !== expected
  ) {
    throw new Error("replica read compatibility is not confirmed for this client");
  }
  const schemaDatoms: Datom[] = [];
  const bootstrap = Schema.bootstrap();
  const attributeIds = new Map(record.attributeIds);
  for (const spec of record.attributes) {
    const builtIn = bootstrap.attr(spec.ident);
    const id = builtIn?.id ?? attributeIds.get(spec.ident);
    if (id === undefined) throw new Error(`missing local attribute id for ${spec.ident}`);
    if (builtIn === undefined) schemaDatoms.push(...replicaAttributeDatoms(id, spec, USER_T));
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
    request.addEventListener("upgradeneeded", (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(COMMITTED)) {
        database.createObjectStore(COMMITTED, { keyPath: "partition" });
      }
      if (!database.objectStoreNames.contains(COMMITTED_HEADS)) {
        database.createObjectStore(COMMITTED_HEADS, { keyPath: "partition" });
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
      if (!database.objectStoreNames.contains(CACHE_CANDIDATES)) {
        database.createObjectStore(CACHE_CANDIDATES, {
          keyPath: ["selector", "routeSlot"],
        });
      }
      if (!database.objectStoreNames.contains(ROUTE_SLOTS)) {
        database.createObjectStore(ROUTE_SLOTS, { keyPath: ["scope", "pathKey"] });
      }
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (oldVersion > 0 && oldVersion < STORAGE_V2_DATABASE_VERSION && request.transaction !== null) {
        // One atomic pre-public reset. Every stored record older than storage
        // version 2 carries documentation in its attribute metadata and roots,
        // or keys an exact binding/candidate by mutable graph-path text. Both
        // are unreadable under the current format and there is no gradual
        // adapter, so the upgrade transaction empties this format's store
        // families together. Future #475/#476 mutation stores are separate
        // families and are deliberately untouched.
        const upgrade = request.transaction;
        for (const store of REPLICA_STORE_FAMILIES) upgrade.objectStore(store).clear();
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

  /** Remove only one incompatible replica representation, never unrelated store families. */
  private async quarantineReplica(
    identity: ReplicationIdentity,
    fingerprint?: string,
  ): Promise<void> {
    const partition = replicaPartitionKey(identity);
    const transaction = this.database.transaction(
      [
        COMMITTED,
        COMMITTED_HEADS,
        STAGING,
        STAGING_CHUNKS,
        NODES,
        CREDENTIAL_BINDINGS,
        CACHE_CANDIDATES,
      ],
      "readwrite",
    );
    transaction.objectStore(COMMITTED).delete(partition);
    transaction.objectStore(COMMITTED_HEADS).delete(partition);
    transaction.objectStore(STAGING).delete(partition);
    transaction.objectStore(STAGING_CHUNKS).delete(chunkRange(partition));
    transaction.objectStore(NODES).delete(nodeRange(partition));
    const bindings = transaction.objectStore(CREDENTIAL_BINDINGS);
    if (fingerprint !== undefined) {
      bindings.delete(fingerprint);
    } else {
      const records = await requestResult<CredentialBindingRecord[]>(bindings.getAll());
      for (const binding of records) {
        if (sameReplicationIdentity(binding.identity, identity)) {
          bindings.delete(binding.fingerprint);
        }
      }
    }
    const candidates = transaction.objectStore(CACHE_CANDIDATES);
    const candidateRecords = await requestResult<CacheCandidateRecord[]>(candidates.getAll());
    for (const candidate of candidateRecords) {
      if (sameReplicationIdentity(candidate.identity, identity)) {
        candidates.delete([candidate.selector, candidate.routeSlot]);
      }
    }
    await commitTransaction(transaction);
  }

  /** Remove one stale exact binding without touching its shared partition. */
  private async unbindCredential(fingerprint: string): Promise<void> {
    const transaction = this.database.transaction(CREDENTIAL_BINDINGS, "readwrite");
    transaction.objectStore(CREDENTIAL_BINDINGS).delete(fingerprint);
    await commitTransaction(transaction);
  }

  async restore(
    identity: ReplicationIdentity,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<RestoredReplica | undefined> {
    const record = await this.committed(identity);
    if (record === undefined) return undefined;
    if (record.storageVersion !== REPLICA_STORAGE_VERSION) return undefined;
    if (!sameReplicationIdentity(record.identity, identity)) return undefined;
    if (
      identity.readCompatibilityHash !== readCompatibilityHash ||
      record.readCompatibilityHash !== readCompatibilityHash ||
      record.identity.readCompatibilityHash !== readCompatibilityHash
    ) {
      await this.quarantineReplica(identity);
      return undefined;
    }
    if (!sameReplicaAttributes(record.attributes, replicaAttributes(attributes))) {
      throw new Error("replica attribute metadata is incompatible with the committed read view");
    }
    return {
      db: dbFromRecord(this.database, record, readCompatibilityHash),
      revision: record.revision,
    };
  }

  /**
   * Read only authenticated manifest metadata nominated by a stable local
   * selector. This path deliberately cannot load content nodes or construct a
   * Db; the current response must confirm the identity first.
   */
  async selectCacheCandidate(
    key: ReplicaCacheCandidateKey,
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<ReplicaCacheCandidate | undefined> {
    const transaction = this.database.transaction(
      [CACHE_CANDIDATES, COMMITTED_HEADS],
      "readonly",
    );
    const binding = await requestResult<CacheCandidateRecord | undefined>(
      transaction.objectStore(CACHE_CANDIDATES).get([key.selector, key.routeSlot]),
    );
    if (
      binding === undefined ||
      binding.identity.readCompatibilityHash !== readCompatibilityHash
    ) {
      await transactionDone(transaction);
      return undefined;
    }
    const head = await requestResult<CommittedHeadRecord | undefined>(
      transaction.objectStore(COMMITTED_HEADS).get(replicaPartitionKey(binding.identity)),
    );
    await transactionDone(transaction);
    if (
      head === undefined ||
      head.storageVersion !== REPLICA_STORAGE_VERSION ||
      head.partition !== replicaPartitionKey(binding.identity) ||
      head.readCompatibilityHash !== readCompatibilityHash ||
      head.identity.readCompatibilityHash !== readCompatibilityHash ||
      !sameReplicationIdentity(head.identity, binding.identity)
    ) {
      return undefined;
    }
    return Object.freeze({
      identity: binding.identity,
      revision: head.revision,
    });
  }

  /**
   * Construct a candidate only after the current response authenticated its
   * exact identity and revision. A concurrent manifest change fails closed.
   */
  async restoreConfirmedCandidate(
    candidate: ReplicaCacheCandidate,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<BoundRestoredReplica | undefined> {
    const record = await this.committed(candidate.identity);
    if (
      record === undefined ||
      record.storageVersion !== REPLICA_STORAGE_VERSION ||
      record.revision !== candidate.revision ||
      candidate.identity.readCompatibilityHash !== readCompatibilityHash ||
      record.readCompatibilityHash !== readCompatibilityHash ||
      record.identity.readCompatibilityHash !== readCompatibilityHash ||
      !sameReplicationIdentity(record.identity, candidate.identity)
    ) {
      return undefined;
    }
    if (!sameReplicaAttributes(record.attributes, replicaAttributes(attributes))) {
      throw new Error("replica attribute metadata is incompatible with the committed read view");
    }
    return {
      identity: candidate.identity,
      db: dbFromRecord(this.database, record, readCompatibilityHash),
      revision: record.revision,
    };
  }

  /**
   * Read the confirmed stable route slot previously observed for one path text.
   * This is a lookup hint only: it selects where to look, never what is
   * authorized, and a miss simply falls back to the provisional slot.
   */
  async observedRouteSlot(
    observation: ReplicaRouteObservation,
  ): Promise<ReplicaRouteSlot | undefined> {
    const transaction = this.database.transaction(ROUTE_SLOTS, "readonly");
    const record = await requestResult<RouteSlotRecord | undefined>(
      transaction.objectStore(ROUTE_SLOTS).get([observation.scope, observation.pathKey]),
    );
    await transactionDone(transaction);
    return record?.slot;
  }

  /**
   * Rebind the exact credential, the optional stable selector, and the observed
   * route slot together only after the current response has authenticated
   * `identity`. One transaction keeps the exact binding and the slot that
   * derives its fingerprint from ever disagreeing on restart.
   */
  async bindAuthenticated(
    binding: ReplicaAuthenticatedBinding,
    options: ReplicaInstallOptions = {},
  ): Promise<void> {
    const transaction = this.database.transaction(
      [CREDENTIAL_BINDINGS, CACHE_CANDIDATES, ROUTE_SLOTS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      transaction.objectStore(CREDENTIAL_BINDINGS).put({
        fingerprint: binding.fingerprint,
        identity: binding.identity,
      } satisfies CredentialBindingRecord);
      if (binding.candidateKey !== undefined) {
        transaction.objectStore(CACHE_CANDIDATES).put({
          selector: binding.candidateKey.selector,
          routeSlot: binding.candidateKey.routeSlot,
          identity: binding.identity,
        } satisfies CacheCandidateRecord);
      }
      if (binding.route !== undefined) {
        transaction.objectStore(ROUTE_SLOTS).put({
          scope: binding.route.scope,
          pathKey: binding.route.pathKey,
          slot: binding.route.slot,
        } satisfies RouteSlotRecord);
      }
      await commitTransaction(transaction);
    } finally {
      removeAbort();
    }
  }

  /** Bind only a locally digested credential; the raw credential never enters IndexedDB. */
  async bindCredential(
    fingerprint: string,
    identity: ReplicationIdentity,
    options: ReplicaInstallOptions = {},
  ): Promise<void> {
    await this.bindAuthenticated({ fingerprint, identity }, options);
  }

  /** Restore only the exact partition selected by a prior authenticated binding. */
  async restoreBound(
    fingerprint: string,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
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
    if (record === undefined || record.storageVersion !== REPLICA_STORAGE_VERSION) {
      return undefined;
    }
    if (!sameReplicationIdentity(record.identity, binding.identity)) {
      await this.unbindCredential(fingerprint);
      return undefined;
    }
    if (
      binding.identity.readCompatibilityHash !== readCompatibilityHash ||
      record.readCompatibilityHash !== readCompatibilityHash ||
      record.identity.readCompatibilityHash !== readCompatibilityHash
    ) {
      await this.quarantineReplica(binding.identity, fingerprint);
      return undefined;
    }
    if (!sameReplicaAttributes(record.attributes, replicaAttributes(attributes))) {
      throw new Error("replica attribute metadata is incompatible with the committed read view");
    }
    return {
      identity: binding.identity,
      db: dbFromRecord(this.database, record, readCompatibilityHash),
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
      [COMMITTED, COMMITTED_HEADS, STAGING, STAGING_CHUNKS],
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
      transaction.objectStore(COMMITTED_HEADS).put(committedHead(built.record));
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
      return {
        db: dbFromRecord(this.database, prior, frame.identity.readCompatibilityHash),
        revision: prior.revision,
      };
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
    const write = this.database.transaction(
      [COMMITTED, COMMITTED_HEADS],
      "readwrite",
    );
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
      write.objectStore(COMMITTED_HEADS).put(committedHead(built.record));
      await commitTransaction(write);
    } finally {
      removeAbort();
    }
    return { db: built.db, revision: built.record.revision };
  }
}
