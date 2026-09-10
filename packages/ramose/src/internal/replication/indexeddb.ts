import * as Result from "effect/Result";
import type { ReadCompatibilityHash } from "../authorization/identities.ts";
import { ALL_INDEXES, type Datom } from "../core/datom.ts";
import { buildRoots } from "../core/conn.ts";
import { sha256Hex } from "../core/bytes.ts";
import { Db, type Roots, rootFor } from "../core/db.ts";
import { Novelty } from "../core/novelty.ts";
import { FIRST_USER_EID, type AttributeSpec, Schema } from "../core/schema.ts";
import { deserializeNode, gzipCodec, serializeNode } from "../core/store.ts";
import type { IndexId } from "../core/datom.ts";
import {
  decodeNode,
  NodeKind,
  type NodeRef,
  type NodeStore,
  type TreeNode,
} from "../core/tree.ts";
import {
  inertRuntimeBoundaries,
  type RuntimeBoundaries,
} from "../runtime-boundaries.ts";
import {
  isReplicationOrdinal,
  isReplicationSettlement,
  REPLICA_STORAGE_VERSION,
  REPLICATION_PROTOCOL_VERSION,
  type Change,
  type EntityHandleBinding,
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
  replicaFactDatom,
  sameReplicaAttributes,
} from "./replica-schema.ts";
import type { ReplicaRouteSlot } from "./route-slot.ts";
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
  clearMutationScope,
  createMutationStores,
  IndexedDbOutbox,
  MUTATION_STORE_FAMILIES,
} from "./outbox-storage.ts";
import {
  classifyReplicaStorageFailure,
  replicaQuotaRecovery,
  replicaSweepKey,
  replicaSweepPrefix,
  ReplicaQuotaExhaustedError,
  ReplicaReachability,
  stagingIsSweepable,
  supersededPartitions,
  unreachableNodeHashes,
  type ReplicaGcOutcome,
} from "./replica-gc.ts";
import type { LeadershipFence } from "./leadership.ts";
import {
  identityNotice,
  platformBroadcast,
  replicaNotice,
  replicaNoticeChannelName,
  ReplicaNoticeChannel,
  type ReplicaNotice,
  type ReplicaNoticeListener,
} from "./notices.ts";
import {
  identityInDatabase,
  identityInScope,
  REPLICA_CLEAR_BARRIER_KEY,
  REPLICA_COMMITTED_HEADS_STORE,
  REPLICA_GENERATIONS_STORE,
  replicaDatabaseKey,
  replicaDatabasePartitionPrefix,
  replicaDatabaseScopeOf,
  replicaPartitionKey,
  replicaPartitionScopeKey,
  replicaScopeKey,
  replicaScopeOf,
  replicaScopePartitionPrefix,
  withConfirmedScope,
  withoutConfirmedScope,
  ReplicaDatabaseActiveError,
  ReplicaFencedError,
  ReplicaLease,
  ReplicaScopeClearedError,
  ReplicaScopeUnconfirmedError,
  type ReplicaDatabaseScope,
  type ReplicaScope,
} from "./replica-lifecycle.ts";
import {
  digestReplicaDatoms,
  emptyReplicaIndexDigest,
  expectedReplicaContents,
  replicaAbsent,
  replicaContended,
  ReplicaSupersededError,
  replicaManifestFingerprint,
  replicaManifestIdentity,
  replicaRestored,
  replicaUnusable,
  restoredReplica,
  validateReplicaContents,
  validateReplicaManifest,
  validateReplicaNode,
  type ReplicaIndexDigests,
  type ReplicaIntegrityFailure,
  type ReplicaManifest,
  type ReplicaRestoreOutcome,
} from "./replica-integrity.ts";
import {
  applyReplicationFrame,
  emptyClientReplicationState,
  ReplicationTransitionError,
  sameReplicationIdentity,
  type ClientReplicationState,
  type CommittedReplica,
} from "./state.ts";

const STORAGE_V2_DATABASE_VERSION = 5;
const LIFECYCLE_DATABASE_VERSION = 6;
const MUTATION_INDEX_DATABASE_VERSION = 9;
const OPTIMISTIC_LAYER_DATABASE_VERSION = 10;
export const REPLICA_MANIFEST_STORAGE_VERSION =
  OPTIMISTIC_LAYER_DATABASE_VERSION + 1;
const MANIFEST_V3_DATABASE_VERSION = REPLICA_MANIFEST_STORAGE_VERSION;
const DATABASE_ROUTE_DATABASE_VERSION = MANIFEST_V3_DATABASE_VERSION + 1;
const MANIFEST_V4_DATABASE_VERSION = DATABASE_ROUTE_DATABASE_VERSION + 1;
const MANIFEST_V5_DATABASE_VERSION = MANIFEST_V4_DATABASE_VERSION + 1;
const MANIFEST_V6_DATABASE_VERSION = MANIFEST_V5_DATABASE_VERSION + 1;
export const REPLICA_DATABASE_VERSION = MANIFEST_V6_DATABASE_VERSION;
const DATABASE_VERSION = REPLICA_DATABASE_VERSION;
const COMMITTED = "replica-committed-v1";
const COMMITTED_HEADS = REPLICA_COMMITTED_HEADS_STORE;
const STAGING = "replica-staging-v1";
const STAGING_CHUNKS = "replica-staging-chunks-v1";
const NODES = "replica-nodes-v1";
const CREDENTIAL_BINDINGS = "replica-credential-bindings-v1";
const CACHE_CANDIDATES = "replica-cache-candidates-v1";
const ROUTE_SLOTS = "replica-route-slots-v1";
const GENERATIONS = REPLICA_GENERATIONS_STORE;
const USER_T = 2;

const REPLICA_STORE_FAMILIES = [
  COMMITTED,
  COMMITTED_HEADS,
  STAGING,
  STAGING_CHUNKS,
  NODES,
  CREDENTIAL_BINDINGS,
  CACHE_CANDIDATES,
  ROUTE_SLOTS,
  GENERATIONS,
] as const;

const REPLICA_VALUE_FAMILIES = REPLICA_STORE_FAMILIES.filter(
  (family) => family !== GENERATIONS,
);

const STORAGE_V2_SWEEP_PREFIX = "ramose-replica-sweep-v2:";

const PARTITION_KEYED_FAMILIES = [COMMITTED, COMMITTED_HEADS, STAGING] as const;

const PARTITION_PREFIXED_FAMILIES = [STAGING_CHUNKS, NODES] as const;

const IDENTITY_KEYED_FAMILIES = [CREDENTIAL_BINDINGS, CACHE_CANDIDATES] as const;

export const DEFAULT_REPLICA_DATABASE_NAME = "ramose-replicas";

export { replicaPartitionKey } from "./replica-lifecycle.ts";
export {
  ReplicaQuotaExhaustedError,
  replicaSweepKey,
  type ReplicaGcOutcome,
} from "./replica-gc.ts";

type CommittedRecord = ReplicaManifest;

type CommittedHeadRecord = {
  readonly partition: string;
  readonly storageVersion: typeof REPLICA_STORAGE_VERSION;
  readonly identity: ReplicationIdentity;
  readonly readCompatibilityHash: ReadCompatibilityHash;
  readonly revision: string;
  readonly ordinal: number;
  readonly settled: number;
};

type StagingRecord = {
  readonly partition: string;
  readonly identity: ReplicationIdentity;
  readonly snapshot: string;
  readonly revision: string;
  readonly baseRevision: string | null;
};

type StagingChunkRecord = {
  readonly partition: string;
  readonly index: number;
  readonly datoms: readonly SnapshotDatom[];
  readonly handles: readonly EntityHandleBinding[];
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

type RouteSlotRecord = {
  readonly scope: string;
  readonly pathKey: string;
  readonly slot: ReplicaRouteSlot;
  readonly replicaScopes?: readonly string[];
};

type GenerationRecord = {
  readonly key: string;
  readonly kind: "scope" | "database" | "partition" | "leader" | "barrier";
  readonly scope: string;
  readonly generation: number;
  readonly confirmedAt: number;
  readonly fencedAt: number | null;
  readonly clearedAt?: number;
};

export type ReplicaRouteObservation = {
  readonly scope: string;
  readonly pathKey: string;
};

export type ReplicaWriteCounts = {
  readonly nodes: number;
  readonly manifests: number;
  readonly heads: number;
  readonly staging: number;
  readonly stagingChunks: number;
};

class WriteMeter {
  nodes = 0;
  manifests = 0;
  heads = 0;
  staging = 0;
  stagingChunks = 0;

  counts(): ReplicaWriteCounts {
    return Object.freeze({
      nodes: this.nodes,
      manifests: this.manifests,
      heads: this.heads,
      staging: this.staging,
      stagingChunks: this.stagingChunks,
    });
  }

  reset(): void {
    this.nodes = 0;
    this.manifests = 0;
    this.heads = 0;
    this.staging = 0;
    this.stagingChunks = 0;
  }
}

const positionOf = (record: CommittedRecord): AcknowledgedReplicaPosition =>
  Object.freeze({ ordinal: record.ordinal, settled: record.settled });

const committedHead = (record: CommittedRecord): CommittedHeadRecord => ({
  partition: record.partition,
  storageVersion: record.storageVersion,
  identity: record.identity,
  readCompatibilityHash: record.readCompatibilityHash,
  revision: record.revision,
  ordinal: record.ordinal,
  settled: record.settled,
});

const mergedSettlement = (
  record: CommittedRecord,
  ...priors: readonly ({ readonly settled?: unknown } | undefined)[]
): CommittedRecord => {
  let settled = record.settled;
  for (const prior of priors) {
    const stored = prior?.settled;
    if (isReplicationSettlement(stored) && stored > settled) settled = stored;
  }
  return settled === record.settled ? record : { ...record, settled };
};

const recordOrdinal = (record: unknown): number | undefined => {
  const ordinal = (record as { readonly ordinal?: unknown } | undefined)?.ordinal;
  return isReplicationOrdinal(ordinal) ? ordinal : undefined;
};

const storedOrdinal = (
  head: CommittedHeadRecord | undefined,
  manifest: CommittedRecord | undefined,
): number | undefined => recordOrdinal(head) ?? recordOrdinal(manifest);

const supersedesStoredHead = (
  stored: number | undefined,
  candidate: CommittedRecord,
): boolean => stored === undefined || candidate.ordinal >= stored;

export type RestoredReplica = {
  readonly db: Db;
  readonly revision: string;
  readonly ordinal: number;
  readonly settled: number;
  readonly handles: ReadonlyMap<string, number>;
  readonly release: () => void;
};

type RetainedRecord = {
  readonly record: CommittedRecord;
  readonly release: () => void;
};

export type BoundRestoredReplica = RestoredReplica & {
  readonly identity: ReplicationIdentity;
};

export type ReplicaCacheCandidate = {
  readonly identity: ReplicationIdentity;
  readonly revision: string;
  readonly ordinal: number;
};

export type AcknowledgedReplicaPosition = {
  readonly ordinal: number;
  readonly settled: number;
};

export type ReplicaCommittedPosition = AcknowledgedReplicaPosition & {
  readonly revision: string;
};

export type ReplicaOrdinalAcknowledgement = {
  readonly identity: ReplicationIdentity;
  readonly revision: string;
  readonly ordinal: number;
  readonly settled: number;
};

export type ReplicaCacheCandidateKey = {
  readonly selector: string;
  readonly routeSlot: ReplicaRouteSlot;
};

export type ReplicaAuthenticatedBinding = {
  readonly fingerprint: string;
  readonly identity: ReplicationIdentity;
  readonly candidateKey?: ReplicaCacheCandidateKey | undefined;
  readonly route?: (ReplicaRouteObservation & {
    readonly slot: ReplicaRouteSlot;
  }) | undefined;
};

export type ReplicaInstallOptions = {
  readonly signal?: AbortSignal;
  readonly lease?: ReplicaLease | undefined;
};

export type ReplicaClearOutcome = {
  readonly scope: string;
  readonly generation: number;
  readonly partitions: number;
  readonly nodes: number;
  readonly bindings: number;
  readonly candidates: number;
  readonly routeObservations: number;
  readonly queued: number;
  readonly clientRefs: number;
  readonly layers: number;
};

export type ReplicaEvictOutcome = {
  readonly database: string;
  readonly generation: number;
  readonly partitions: number;
  readonly nodes: number;
  readonly bindings: number;
  readonly candidates: number;
};

export type ReplicaScopeParticipant = {
  readonly scope: ReplicaScope;
  readonly database?: ReplicaDatabaseScope | undefined;
  readonly close: () => Promise<void>;
};

type LifecycleRegistry = {
  readonly pins: Map<string, number>;
  readonly participants: Set<ReplicaScopeParticipant>;
  readonly retained: Map<string, Map<number, readonly string[]>>;
  readonly materializing: Map<string, number>;
};

const LIFECYCLE_REGISTRIES = new Map<string, LifecycleRegistry>();

const confirmationRecords = (
  identity: ReplicationIdentity,
  confirmedAt: number,
): readonly GenerationRecord[] => {
  const scope = replicaScopeKey(replicaScopeOf(identity));
  return [
    { key: scope, kind: "scope", scope, generation: 1, confirmedAt, fencedAt: null },
    {
      key: replicaDatabaseKey(replicaDatabaseScopeOf(identity)),
      kind: "database",
      scope,
      generation: 1,
      confirmedAt,
      fencedAt: null,
    },
  ];
};

const seedConfirmedGenerations = (upgrade: IDBTransaction): void => {
  const generations = upgrade.objectStore(GENERATIONS);
  const confirmedAt = Date.now();
  const scopes = new Set<string>();
  for (const family of [COMMITTED, ...IDENTITY_KEYED_FAMILIES]) {
    const request = upgrade.objectStore(family).getAll();
    request.addEventListener("success", () => {
      const records = request.result as readonly { readonly identity: ReplicationIdentity }[];
      for (const record of records) {
        scopes.add(replicaScopeKey(replicaScopeOf(record.identity)));
        for (const seeded of confirmationRecords(record.identity, confirmedAt)) {
          generations.put(seeded);
        }
      }
    }, { once: true });
  }
  const routes = upgrade.objectStore(ROUTE_SLOTS);
  const observed = routes.getAll();
  observed.addEventListener("success", () => {
    const owners = [...scopes].sort();
    for (const record of observed.result as readonly RouteSlotRecord[]) {
      if (record.replicaScopes !== undefined) continue;
      if (owners.length === 0) routes.delete([record.scope, record.pathKey]);
      else routes.put({ ...record, replicaScopes: owners } satisfies RouteSlotRecord);
    }
  }, { once: true });
};

const lifecycleRegistry = (name: string): LifecycleRegistry => {
  const existing = LIFECYCLE_REGISTRIES.get(name);
  if (existing !== undefined) return existing;
  const created: LifecycleRegistry = {
    pins: new Map(),
    participants: new Set(),
    retained: new Map(),
    materializing: new Map(),
  };
  LIFECYCLE_REGISTRIES.set(name, created);
  return created;
};

const chunkRange = (partition: string): IDBKeyRange =>
  IDBKeyRange.bound([partition, 0], [partition, Number.MAX_SAFE_INTEGER]);

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

const rootHashes = (roots: Roots): readonly string[] =>
  ALL_INDEXES.map((index) => rootFor(roots, index).hash);

type ReplicaFence = {
  readonly lease: ReplicaLease;
  readonly scopeKey: string;
  readonly databaseKey: string;
};

const replicaFence = (
  lease: ReplicaLease | undefined,
  identity: ReplicationIdentity,
): ReplicaFence | undefined =>
  lease === undefined ? undefined : {
    lease,
    scopeKey: replicaScopeKey(replicaScopeOf(identity)),
    databaseKey: replicaDatabaseKey(replicaDatabaseScopeOf(identity)),
  };

const enforceFence = async (
  transaction: IDBTransaction,
  fence: ReplicaFence | undefined,
): Promise<void> => {
  if (fence === undefined) return;
  const generations = transaction.objectStore(GENERATIONS);
  const [scope, database] = await Promise.all([
    requestResult<GenerationRecord | undefined>(generations.get(fence.scopeKey)),
    requestResult<GenerationRecord | undefined>(generations.get(fence.databaseKey)),
  ]);
  try {
    fence.lease.observe(fence.scopeKey, scope?.generation ?? 0);
    fence.lease.observe(fence.databaseKey, database?.generation ?? 0);
    fence.lease.admit(fence.scopeKey, scope?.clearedAt ?? 0);
  } catch (error) {
    await abortTransaction(transaction);
    throw error;
  }
};

class IndexedDbNodeStore implements NodeStore {
  constructor(
    private readonly database: IDBDatabase,
    private readonly partition: string,
    private readonly signal?: AbortSignal,
    private readonly fence?: ReplicaFence | undefined,
    private readonly meter?: WriteMeter | undefined,
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
    const transaction = this.database.transaction(
      this.fence === undefined ? [NODES] : [NODES, GENERATIONS],
      "readwrite",
    );
    await enforceFence(transaction, this.fence);
    transaction.objectStore(NODES).put({
      partition: this.partition,
      hash: ref.hash,
      body,
    } satisfies NodeRecord);
    await commitTransaction(transaction);
    if (this.meter !== undefined) this.meter.nodes++;
    return ref;
  }
}

type Materialized = {
  readonly record: CommittedRecord;
  readonly db: Db;
};

const newInstallId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

const materialize = async (
  database: IDBDatabase,
  identity: ReplicationIdentity,
  committed: CommittedReplica,
  attributes: readonly AttributeSpec[],
  prior: CommittedRecord | undefined,
  signal?: AbortSignal,
  fence?: ReplicaFence | undefined,
  meter?: WriteMeter | undefined,
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
    const fact = replicaFactDatom(logical, schema, entities);
    if (typeof fact === "string") {
      throw new Error(
        fact === "value-type"
          ? `logical value type disagrees with ${logical.field}`
          : `logical fact references unknown field ${logical.field}`,
      );
    }
    facts.push(fact);
  }

  const store = new IndexedDbNodeStore(database, partition, signal, fence, meter);
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
    ordinal: committed.ordinal,
    settled: committed.settled,
    datoms: Object.freeze([...committed.datoms]),
    attributes: Object.freeze(specs),
    entityIds: Object.freeze([...entities]),
    entityHandles: Object.freeze(
      [...entities.keys()].flatMap((entity) => {
        const handle = committed.handles.get(entity);
        return handle === undefined
          ? []
          : [Object.freeze([entity, handle] as const)];
      }),
    ),
    attributeIds: Object.freeze([...attributeIds]),
    roots,
    nextLocalId,
    installId: newInstallId(),
  };
  return {
    record,
    db: new Db({
      store: new IndexedDbNodeStore(database, partition),
      roots,
      novelty: new Novelty(),
      basisT: roots.t,
      schema,
      nextEid: nextLocalId,
    }),
  };
};

const recordHandles = (
  record: CommittedRecord,
): ReadonlyMap<string, number> => {
  const entities = new Map(record.entityIds);
  const handles = new Map<string, number>();
  for (const [identity, handle] of record.entityHandles) {
    const eid = entities.get(identity);
    if (eid !== undefined) handles.set(handle, eid);
  }
  return handles;
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

const VALIDATION_BATCH = 32;

type PendingNode = {
  readonly ref: NodeRef;
  readonly key?: Datom;
};

const readNodeRecords = async (
  database: IDBDatabase,
  partition: string,
  hashes: readonly string[],
): Promise<readonly (NodeRecord | undefined)[]> => {
  const transaction = database.transaction(NODES, "readonly");
  const store = transaction.objectStore(NODES);
  const pending = hashes.map((hash) =>
    requestResult<NodeRecord | undefined>(store.get([partition, hash]))
  );
  const records = await Promise.all(pending);
  await transactionDone(transaction);
  return records;
};

type DecodedNode = { readonly index: IndexId; readonly node: TreeNode };

const verifyNodeRecord = async (
  index: IndexId,
  ref: NodeRef,
  record: NodeRecord | undefined,
  expectedKey: Datom | undefined,
): Promise<ReplicaIntegrityFailure | DecodedNode> => {
  const located = { index, hash: ref.hash };
  if (record === undefined) {
    return { reason: "node-missing", detail: "referenced node is not stored", ...located };
  }
  if (!(record.body instanceof Uint8Array)) {
    return { reason: "node-undecodable", detail: "node record carries no body", ...located };
  }
  if (await sha256Hex(record.body) !== ref.hash) {
    return { reason: "node-hash", detail: "node body does not hash to its address", ...located };
  }
  let decoded: DecodedNode;
  try {
    decoded = decodeNode(await gzipCodec.decompress(record.body));
  } catch {
    return { reason: "node-undecodable", detail: "node body cannot be decoded", ...located };
  }
  return validateReplicaNode(index, ref, decoded, expectedKey) ?? decoded;
};

const validateReachableNodes = async (
  database: IDBDatabase,
  manifest: ReplicaManifest,
  reached?: Set<string>,
): Promise<ReplicaIntegrityFailure | undefined> => {
  const seen = reached ?? new Set<string>();
  const expected = expectedReplicaContents(manifest);
  if (Result.isFailure(expected)) return expected.failure;
  const digests: ReplicaIndexDigests = {
    0: emptyReplicaIndexDigest(),
    1: emptyReplicaIndexDigest(),
    2: emptyReplicaIndexDigest(),
    3: emptyReplicaIndexDigest(),
  };
  for (const index of ALL_INDEXES) {
    const digest = digests[index];
    const frontier: PendingNode[] = [{ ref: rootFor(manifest.roots, index) }];
    while (frontier.length > 0) {
      const batch: PendingNode[] = [];
      while (batch.length < VALIDATION_BATCH && frontier.length > 0) {
        const pending = frontier.pop()!;
        if (seen.has(pending.ref.hash)) {
          return {
            reason: "node-invariant",
            detail: "one node is linked from more than one place",
            index,
            hash: pending.ref.hash,
          };
        }
        seen.add(pending.ref.hash);
        batch.push(pending);
      }
      const records = await readNodeRecords(
        database,
        manifest.partition,
        batch.map((pending) => pending.ref.hash),
      );
      for (let i = 0; i < batch.length; i++) {
        const { ref, key } = batch[i];
        const node = await verifyNodeRecord(index, ref, records[i], key);
        if ("reason" in node) return node;
        if (node.node.kind === NodeKind.Leaf) digestReplicaDatoms(digest, node.node.datoms);
        else {
          for (let child = 0; child < node.node.refs.length; child++) {
            frontier.push({ ref: node.node.refs[child], key: node.node.keys[child] });
          }
        }
      }
    }
  }
  return validateReplicaContents(manifest.roots, digests, expected.success);
};

const reachableFromRoots = async (
  database: IDBDatabase,
  partition: string,
  roots: readonly string[],
): Promise<ReplicaReachability> => {
  const walk = new ReplicaReachability(roots);
  while (walk.pending) {
    const batch = walk.next(VALIDATION_BATCH);
    const records = await readNodeRecords(database, partition, batch);
    for (let i = 0; i < batch.length; i++) {
      const record = records[i];
      if (record === undefined || !(record.body instanceof Uint8Array)) {
        walk.fail();
        return walk;
      }
      if (await sha256Hex(record.body) !== batch[i]) {
        walk.fail();
        return walk;
      }
      try {
        const decoded = decodeNode(await gzipCodec.decompress(record.body));
        walk.expand(
          decoded.node.kind === NodeKind.Leaf
            ? []
            : decoded.node.refs.map((ref) => ref.hash),
        );
      } catch {
        walk.fail();
        return walk;
      }
    }
  }
  return walk;
};

const storedReadCompatibilityHash = (
  record: unknown,
): ReadCompatibilityHash | undefined =>
  typeof record === "object" && record !== null &&
    typeof (record as { readonly readCompatibilityHash?: unknown })
        .readCompatibilityHash === "string"
    ? (record as { readonly readCompatibilityHash: ReadCompatibilityHash })
      .readCompatibilityHash
    : undefined;

const storedRevision = (record: unknown): string | null =>
  typeof record === "object" && record !== null &&
    typeof (record as { readonly revision?: unknown }).revision === "string"
    ? (record as { readonly revision: string }).revision
    : null;

type SurveyedPartition = {
  readonly hashes: readonly string[];
  readonly fingerprint: string;
  readonly record: unknown;
};

const referencedPartitions = (
  families: readonly (readonly { readonly identity: ReplicationIdentity }[])[],
): ReadonlySet<string> => {
  const referenced = new Set<string>();
  for (const family of families) {
    for (const record of family) referenced.add(replicaPartitionKey(record.identity));
  }
  return referenced;
};

const readReferences = async (
  transaction: IDBTransaction,
): Promise<ReadonlySet<string>> => {
  const [bindings, candidates] = await Promise.all([
    requestResult<CredentialBindingRecord[]>(
      transaction.objectStore(CREDENTIAL_BINDINGS).getAll(),
    ),
    requestResult<CacheCandidateRecord[]>(
      transaction.objectStore(CACHE_CANDIDATES).getAll(),
    ),
  ]);
  return referencedPartitions([bindings, candidates]);
};

let retentionToken = 0;

const RECORD_MOVED = Symbol("replica.record-moved");

const REPLICA_SWEEP_RESTORE_ATTEMPTS = 3;

export class IndexedDbReplicaStorage {
  private readonly clearedScopes = new Set<string>();
  private readonly registry: LifecycleRegistry;
  private readonly registrations = new Set<() => void>();
  private readonly invalidations = new Set<() => void>();
  private readonly meter = new WriteMeter();

  private constructor(
    readonly name: string,
    private readonly database: IDBDatabase,
    private readonly boundaries: RuntimeBoundaries,
    private readonly channel: ReplicaNoticeChannel,
  ) {
    this.registry = lifecycleRegistry(name);
  }

  static async open(
    name = DEFAULT_REPLICA_DATABASE_NAME,
    boundaries: RuntimeBoundaries = inertRuntimeBoundaries,
  ): Promise<IndexedDbReplicaStorage> {
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
      if (!database.objectStoreNames.contains(GENERATIONS)) {
        database.createObjectStore(GENERATIONS, { keyPath: "key" });
      }
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (request.transaction !== null) {
        createMutationStores(
          database,
          request.transaction,
          oldVersion > 0 && oldVersion < MUTATION_INDEX_DATABASE_VERSION,
        );
      }
      if (oldVersion > 0 && oldVersion < STORAGE_V2_DATABASE_VERSION && request.transaction !== null) {
        const upgrade = request.transaction;
        for (const store of REPLICA_STORE_FAMILIES) upgrade.objectStore(store).clear();
      } else if (
        oldVersion >= STORAGE_V2_DATABASE_VERSION &&
        oldVersion < LIFECYCLE_DATABASE_VERSION && request.transaction !== null
      ) {
        seedConfirmedGenerations(request.transaction);
      }
      if (
        oldVersion > 0 && oldVersion < MANIFEST_V6_DATABASE_VERSION &&
        request.transaction !== null
      ) {
        const upgrade = request.transaction;
        for (const store of REPLICA_VALUE_FAMILIES) upgrade.objectStore(store).clear();
        upgrade.objectStore(GENERATIONS).delete(prefixRange(STORAGE_V2_SWEEP_PREFIX));
      }
    });
    const database = await requestResult(request);
    const storage = new IndexedDbReplicaStorage(
      name,
      database,
      boundaries,
      ReplicaNoticeChannel.begin({
        name: replicaNoticeChannelName(name),
        broadcast: platformBroadcast(),
      }),
    );
    database.addEventListener("versionchange", () => {
      database.close();
      storage.invalidated();
    });
    return storage;
  }

  notices(listener: ReplicaNoticeListener): () => void {
    return this.register(this.channel.subscribe(listener));
  }

  announces(): boolean {
    return this.channel.announces();
  }

  private announce(notice: ReplicaNotice): void {
    this.channel.post(notice);
  }

  onInvalidated(listener: () => void): () => void {
    this.invalidations.add(listener);
    return this.register(() => {
      this.invalidations.delete(listener);
    });
  }

  private invalidated(): void {
    for (const listener of [...this.invalidations]) listener();
  }

  close(): void {
    for (const release of [...this.registrations]) release();
    this.channel.close();
    this.database.close();
  }

  writeCounts(): ReplicaWriteCounts {
    return this.meter.counts();
  }

  resetWriteCounts(): void {
    this.meter.reset();
  }

  private register(release: () => void): () => void {
    let released = false;
    const once = (): void => {
      if (released) return;
      released = true;
      this.registrations.delete(once);
      release();
    };
    this.registrations.add(once);
    return once;
  }

  outbox(leader?: () => LeadershipFence | undefined): IndexedDbOutbox {
    return new IndexedDbOutbox(
      this.database,
      this.boundaries,
      (scope) => void this.assertScopeLive(scope),
      leader,
      (notice) => this.announce(notice),
    );
  }

  async claimLeadership(key: string, scope: ReplicaScope): Promise<number> {
    const scopeKey = this.assertScopeLive(scope);
    const transaction = this.database.transaction(GENERATIONS, "readwrite");
    const store = transaction.objectStore(GENERATIONS);
    const held = await requestResult<GenerationRecord | undefined>(store.get(key));
    const generation = (held?.generation ?? 0) + 1;
    store.put({
      key,
      kind: "leader",
      scope: scopeKey,
      generation,
      confirmedAt: Date.now(),
      fencedAt: null,
    } satisfies GenerationRecord);
    await commitTransaction(transaction);
    return generation;
  }

  async admission(): Promise<number> {
    const transaction = this.database.transaction(GENERATIONS, "readonly");
    const record = await requestResult<GenerationRecord | undefined>(
      transaction.objectStore(GENERATIONS).get(REPLICA_CLEAR_BARRIER_KEY),
    );
    await transactionDone(transaction);
    return record?.generation ?? 0;
  }

  async lease(): Promise<ReplicaLease> {
    return new ReplicaLease(await this.admission());
  }

  async confirmLease(
    lease: ReplicaLease,
    identity: ReplicationIdentity,
  ): Promise<void> {
    this.assertScopeLive(replicaScopeOf(identity));
    const transaction = this.database.transaction(GENERATIONS, "readonly");
    await enforceFence(transaction, replicaFence(lease, identity));
    await transactionDone(transaction);
  }

  async leaseFor(identity: ReplicationIdentity): Promise<ReplicaLease> {
    const lease = await this.lease();
    await this.confirmLease(lease, identity);
    return lease;
  }

  pinDatabase(scope: ReplicaDatabaseScope): () => void {
    const key = replicaDatabaseKey(scope);
    const pins = this.registry.pins;
    pins.set(key, (pins.get(key) ?? 0) + 1);
    return this.register(() => {
      const held = (pins.get(key) ?? 1) - 1;
      if (held > 0) pins.set(key, held);
      else pins.delete(key);
    });
  }

  retainRoots(identity: ReplicationIdentity, roots: Roots): () => void {
    const partition = replicaPartitionKey(identity);
    const held = this.registry.retained;
    const entries = held.get(partition) ?? new Map<number, readonly string[]>();
    held.set(partition, entries);
    const token = ++retentionToken;
    entries.set(token, rootHashes(roots));
    return this.register(() => {
      entries.delete(token);
      if (entries.size === 0) held.delete(partition);
    });
  }

  private markMaterializing(partition: string): () => void {
    const marks = this.registry.materializing;
    marks.set(partition, (marks.get(partition) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const held = (marks.get(partition) ?? 1) - 1;
      if (held > 0) marks.set(partition, held);
      else marks.delete(partition);
    };
  }

  enroll(participant: ReplicaScopeParticipant): () => void {
    this.registry.participants.add(participant);
    return this.register(() => {
      this.registry.participants.delete(participant);
    });
  }

  private assertScopeLive(scope: ReplicaScope): string {
    const key = replicaScopeKey(scope);
    if (this.clearedScopes.has(key)) throw new ReplicaScopeClearedError({ scope: key });
    return key;
  }

  private async closeMatching(
    match: (participant: ReplicaScopeParticipant) => boolean,
  ): Promise<void> {
    for (const participant of [...this.registry.participants]) {
      if (!match(participant)) continue;
      this.registry.participants.delete(participant);
      await participant.close();
    }
  }

  async clearScope(scope: ReplicaScope): Promise<ReplicaClearOutcome> {
    const scopeKey = this.assertScopeLive(scope);
    const prefix = replicaScopePartitionPrefix(scope);
    this.clearedScopes.add(scopeKey);
    const transaction = this.database.transaction(
      [...REPLICA_STORE_FAMILIES, ...MUTATION_STORE_FAMILIES],
      "readwrite",
    );
    let outcome: ReplicaClearOutcome;
    try {
      outcome = await this.stageClear(transaction, scope, scopeKey, prefix);
    } catch (error) {
      this.clearedScopes.delete(scopeKey);
      await abortTransaction(transaction);
      throw error;
    }
    await commitTransaction(transaction);
    this.announce(replicaNotice("reset", scope));
    await this.closeMatching((participant) =>
      replicaScopeKey(participant.scope) === scopeKey
    );
    return outcome;
  }

  private async stageClear(
    transaction: IDBTransaction,
    scope: ReplicaScope,
    scopeKey: string,
    prefix: string,
  ): Promise<ReplicaClearOutcome> {
    const generations = transaction.objectStore(GENERATIONS);
    const confirmed = await requestResult<GenerationRecord | undefined>(
      generations.get(scopeKey),
    );
    if (confirmed === undefined) {
      throw new ReplicaScopeUnconfirmedError({ scope: scopeKey });
    }
    const [partitions, nodes] = await Promise.all([
      requestResult<number>(transaction.objectStore(COMMITTED).count(prefixRange(prefix))),
      requestResult<number>(
        transaction.objectStore(NODES).count(compoundPrefixRange(prefix)),
      ),
    ]);
    for (const family of PARTITION_KEYED_FAMILIES) {
      transaction.objectStore(family).delete(prefixRange(prefix));
    }
    for (const family of PARTITION_PREFIXED_FAMILIES) {
      transaction.objectStore(family).delete(compoundPrefixRange(prefix));
    }
    generations.delete(prefixRange(replicaSweepPrefix(prefix)));
    const bindingStore = transaction.objectStore(CREDENTIAL_BINDINGS);
    const candidateStore = transaction.objectStore(CACHE_CANDIDATES);
    const routeStore = transaction.objectStore(ROUTE_SLOTS);
    const [bindingRecords, candidateRecords, routeRecords] = await Promise.all([
      requestResult<CredentialBindingRecord[]>(bindingStore.getAll()),
      requestResult<CacheCandidateRecord[]>(candidateStore.getAll()),
      requestResult<RouteSlotRecord[]>(routeStore.getAll()),
    ]);
    let bindings = 0;
    for (const binding of bindingRecords) {
      if (!identityInScope(binding.identity, scope)) continue;
      bindingStore.delete(binding.fingerprint);
      bindings++;
    }
    let candidates = 0;
    for (const candidate of candidateRecords) {
      if (!identityInScope(candidate.identity, scope)) continue;
      candidateStore.delete([candidate.selector, candidate.routeSlot]);
      candidates++;
    }
    let routeObservations = 0;
    for (const observation of routeRecords) {
      if (!(observation.replicaScopes ?? []).includes(scopeKey)) continue;
      routeObservations++;
      const remaining = withoutConfirmedScope(observation.replicaScopes, scopeKey);
      if (remaining.length === 0) {
        routeStore.delete([observation.scope, observation.pathKey]);
      } else {
        routeStore.put({ ...observation, replicaScopes: remaining } satisfies RouteSlotRecord);
      }
    }
    const mutations = await clearMutationScope(transaction, scope);
    const generation = confirmed.generation + 1;
    const clearedAt = await this.advanceBarrier(generations);
    generations.put({
      ...confirmed,
      generation,
      fencedAt: Date.now(),
      clearedAt,
    } satisfies GenerationRecord);
    await this.boundaries.checkpoint("replica.clear");
    return Object.freeze({
      scope: scopeKey,
      generation,
      partitions,
      nodes,
      bindings,
      candidates,
      routeObservations,
      queued: mutations.queued,
      clientRefs: mutations.clientRefs,
      layers: mutations.layers,
    });
  }

  async evictDatabase(scope: ReplicaDatabaseScope): Promise<ReplicaEvictOutcome> {
    const scopeKey = this.assertScopeLive(scope);
    const databaseKey = replicaDatabaseKey(scope);
    const pins = this.registry.pins.get(databaseKey) ?? 0;
    if (pins > 0) throw new ReplicaDatabaseActiveError({ database: databaseKey, pins });
    const prefix = replicaDatabasePartitionPrefix(scope);
    const transaction = this.database.transaction([
      ...PARTITION_KEYED_FAMILIES,
      ...PARTITION_PREFIXED_FAMILIES,
      ...IDENTITY_KEYED_FAMILIES,
      GENERATIONS,
    ], "readwrite");
    let outcome: ReplicaEvictOutcome;
    try {
      outcome = await this.stageEviction(transaction, scope, scopeKey, databaseKey, prefix);
    } catch (error) {
      await abortTransaction(transaction);
      throw error;
    }
    await commitTransaction(transaction);
    this.announce(replicaNotice("reset", scope, scope));
    await this.closeMatching((participant) =>
      participant.database !== undefined &&
      replicaDatabaseKey(participant.database) === databaseKey
    );
    return outcome;
  }

  private async stageEviction(
    transaction: IDBTransaction,
    scope: ReplicaDatabaseScope,
    scopeKey: string,
    databaseKey: string,
    prefix: string,
  ): Promise<ReplicaEvictOutcome> {
    const generations = transaction.objectStore(GENERATIONS);
    const [confirmed, current] = await Promise.all([
      requestResult<GenerationRecord | undefined>(generations.get(scopeKey)),
      requestResult<GenerationRecord | undefined>(generations.get(databaseKey)),
    ]);
    if (confirmed === undefined) {
      throw new ReplicaScopeUnconfirmedError({ scope: scopeKey });
    }
    const [partitions, nodes] = await Promise.all([
      requestResult<number>(transaction.objectStore(COMMITTED).count(prefixRange(prefix))),
      requestResult<number>(
        transaction.objectStore(NODES).count(compoundPrefixRange(prefix)),
      ),
    ]);
    for (const family of PARTITION_KEYED_FAMILIES) {
      transaction.objectStore(family).delete(prefixRange(prefix));
    }
    for (const family of PARTITION_PREFIXED_FAMILIES) {
      transaction.objectStore(family).delete(compoundPrefixRange(prefix));
    }
    generations.delete(prefixRange(replicaSweepPrefix(prefix)));
    const bindingStore = transaction.objectStore(CREDENTIAL_BINDINGS);
    const candidateStore = transaction.objectStore(CACHE_CANDIDATES);
    const [bindingRecords, candidateRecords] = await Promise.all([
      requestResult<CredentialBindingRecord[]>(bindingStore.getAll()),
      requestResult<CacheCandidateRecord[]>(candidateStore.getAll()),
    ]);
    let bindings = 0;
    for (const binding of bindingRecords) {
      if (!identityInDatabase(binding.identity, scope)) continue;
      bindingStore.delete(binding.fingerprint);
      bindings++;
    }
    let candidates = 0;
    for (const candidate of candidateRecords) {
      if (!identityInDatabase(candidate.identity, scope)) continue;
      candidateStore.delete([candidate.selector, candidate.routeSlot]);
      candidates++;
    }
    const generation = (current?.generation ?? 0) + 1;
    generations.put({
      key: databaseKey,
      kind: "database",
      scope: scopeKey,
      generation,
      confirmedAt: current?.confirmedAt ?? Date.now(),
      fencedAt: Date.now(),
    } satisfies GenerationRecord);
    await this.boundaries.checkpoint("replica.evict");
    return Object.freeze({
      database: databaseKey,
      generation,
      partitions,
      nodes,
      bindings,
      candidates,
    });
  }

  async collectGarbage(
    options: { readonly scope?: ReplicaScope | undefined } = {},
  ): Promise<ReplicaGcOutcome> {
    let prefix: string | undefined;
    if (options.scope !== undefined) {
      this.assertScopeLive(options.scope);
      prefix = replicaScopePartitionPrefix(options.scope);
    }
    const survey = await this.surveyPartitions(prefix);
    const superseded = supersededPartitions(
      survey.keys(),
      await this.surveyReferences(),
    );
    let partitions = 0;
    let swept = 0;
    let skipped = 0;
    let nodes = 0;
    let retained = 0;
    let staging = 0;
    for (const [partition, hashes] of survey) {
      const scopeKey = replicaPartitionScopeKey(partition);
      if (scopeKey !== undefined && this.clearedScopes.has(scopeKey)) continue;
      partitions++;
      const discard = superseded.has(partition);
      const stored = await this.surveyManifest(partition, hashes);
      const live = await this.liveNodeHashes(partition, stored, discard);
      if (live === undefined) {
        skipped++;
        continue;
      }
      const garbage = unreachableNodeHashes(stored.hashes, live);
      await this.boundaries.checkpoint("replica.gc.planned");
      const outcome = await this.sweepPartition(partition, stored, garbage, live, discard);
      if (outcome === undefined) {
        skipped++;
        continue;
      }
      retained += stored.hashes.length - outcome.nodes;
      nodes += outcome.nodes;
      staging += outcome.staging;
      if (outcome.nodes > 0 || outcome.staging > 0 || outcome.discarded) swept++;
      if (!outcome.discarded) continue;
      const discarded = replicaManifestIdentity(stored.record);
      if (discarded !== undefined) this.announce(identityNotice("reset", discarded));
    }
    return Object.freeze({ partitions, swept, skipped, nodes, retained, staging });
  }

  private async surveyPartitions(
    prefix: string | undefined,
  ): Promise<ReadonlyMap<string, string[]>> {
    const transaction = this.database.transaction([COMMITTED, NODES, STAGING], "readonly");
    const keysOf = (store: string, compound: boolean): Promise<IDBValidKey[]> =>
      requestResult<IDBValidKey[]>(
        prefix === undefined
          ? transaction.objectStore(store).getAllKeys()
          : transaction.objectStore(store).getAllKeys(
            compound ? compoundPrefixRange(prefix) : prefixRange(prefix),
          ),
      );
    const [manifestKeys, nodeKeys, stagingKeys] = await Promise.all([
      keysOf(COMMITTED, false),
      keysOf(NODES, true),
      keysOf(STAGING, false),
    ]);
    await transactionDone(transaction);
    const survey = new Map<string, string[]>();
    const at = (partition: string): string[] => {
      const existing = survey.get(partition);
      if (existing !== undefined) return existing;
      const created: string[] = [];
      survey.set(partition, created);
      return created;
    };
    for (const key of nodeKeys) {
      if (!Array.isArray(key) || typeof key[0] !== "string" || typeof key[1] !== "string") {
        continue;
      }
      at(key[0]).push(key[1]);
    }
    for (const keys of [stagingKeys, manifestKeys]) {
      for (const key of keys) if (typeof key === "string") at(key);
    }
    return survey;
  }

  private async surveyReferences(): Promise<ReadonlySet<string>> {
    const transaction = this.database.transaction(
      [...IDENTITY_KEYED_FAMILIES],
      "readonly",
    );
    const referenced = await readReferences(transaction);
    await transactionDone(transaction);
    return referenced;
  }

  private async surveyManifest(
    partition: string,
    hashes: string[],
  ): Promise<SurveyedPartition> {
    const transaction = this.database.transaction(COMMITTED, "readonly");
    const record = await requestResult<unknown>(
      transaction.objectStore(COMMITTED).get(partition),
    );
    await transactionDone(transaction);
    return { hashes, fingerprint: replicaManifestFingerprint(record), record };
  }

  private async liveNodeHashes(
    partition: string,
    stored: SurveyedPartition,
    discard: boolean,
  ): Promise<ReadonlySet<string> | undefined> {
    const live = new Set<string>();
    if (!discard && stored.record !== undefined) {
      const expected = storedReadCompatibilityHash(stored.record);
      if (expected === undefined) return undefined;
      const manifest = validateReplicaManifest(stored.record, {
        partition,
        readCompatibilityHash: expected,
      });
      if (Result.isFailure(manifest)) return undefined;
      if (await validateReachableNodes(this.database, manifest.success, live) !== undefined) {
        return undefined;
      }
    }
    const retained = this.retainedRoots(partition);
    if (retained.length > 0) {
      const walk = await reachableFromRoots(this.database, partition, retained);
      if (!walk.complete) return undefined;
      for (const hash of walk.reachable) live.add(hash);
    }
    return live;
  }

  private retainedRoots(partition: string): readonly string[] {
    const roots: string[] = [];
    for (const held of this.registry.retained.get(partition)?.values() ?? []) {
      roots.push(...held);
    }
    return roots;
  }

  private async sweepPartition(
    partition: string,
    stored: SurveyedPartition,
    garbage: readonly string[],
    live: ReadonlySet<string>,
    discard: boolean,
  ): Promise<
    { readonly nodes: number; readonly staging: number; readonly discarded: boolean }
      | undefined
  > {
    if (this.registry.materializing.has(partition)) return undefined;
    if (this.retainedRoots(partition).some((hash) => !live.has(hash))) return undefined;
    if (discard && this.retainedRoots(partition).length > 0) return undefined;
    const transaction = this.database.transaction(
      discard
        ? [
          COMMITTED,
          COMMITTED_HEADS,
          NODES,
          STAGING,
          STAGING_CHUNKS,
          GENERATIONS,
          ...IDENTITY_KEYED_FAMILIES,
        ]
        : [COMMITTED, NODES, STAGING, STAGING_CHUNKS, GENERATIONS],
      "readwrite",
    );
    let sweptStaging = false;
    try {
      const sweepKey = replicaSweepKey(partition);
      const [current, staged, sweep] = await Promise.all([
        requestResult<unknown>(transaction.objectStore(COMMITTED).get(partition)),
        requestResult<StagingRecord | undefined>(
          transaction.objectStore(STAGING).get(partition),
        ),
        requestResult<GenerationRecord | undefined>(
          transaction.objectStore(GENERATIONS).get(sweepKey),
        ),
      ]);
      if (replicaManifestFingerprint(current) !== stored.fingerprint) {
        await abortTransaction(transaction);
        return undefined;
      }
      if (
        discard &&
        !supersededPartitions([partition], await readReferences(transaction)).has(partition)
      ) {
        await abortTransaction(transaction);
        return undefined;
      }
      sweptStaging = staged !== undefined &&
        (discard || stagingIsSweepable(staged, storedRevision(current)));
      if (garbage.length === 0 && !sweptStaging && !discard) {
        await transactionDone(transaction);
        return { nodes: 0, staging: 0, discarded: false };
      }
      const nodes = transaction.objectStore(NODES);
      for (const hash of garbage) nodes.delete([partition, hash]);
      if (sweptStaging) {
        transaction.objectStore(STAGING).delete(partition);
        transaction.objectStore(STAGING_CHUNKS).delete(chunkRange(partition));
      }
      if (discard) {
        transaction.objectStore(COMMITTED).delete(partition);
        transaction.objectStore(COMMITTED_HEADS).delete(partition);
      }
      if (garbage.length > 0 || discard) {
        transaction.objectStore(GENERATIONS).put({
          key: sweepKey,
          kind: "partition",
          scope: replicaPartitionScopeKey(partition) ?? "",
          generation: (sweep?.generation ?? 0) + 1,
          confirmedAt: sweep?.confirmedAt ?? Date.now(),
          fencedAt: Date.now(),
        } satisfies GenerationRecord);
      }
      await this.boundaries.checkpoint("replica.sweep");
    } catch (error) {
      await abortTransaction(transaction);
      throw error;
    }
    await commitTransaction(transaction);
    return { nodes: garbage.length, staging: sweptStaging ? 1 : 0, discarded: discard };
  }

  private async committed(identity: ReplicationIdentity): Promise<unknown> {
    const transaction = this.database.transaction(COMMITTED, "readonly");
    const record = await requestResult<unknown>(
      transaction.objectStore(COMMITTED).get(replicaPartitionKey(identity)),
    );
    await transactionDone(transaction);
    return record;
  }

  private async priorManifest(
    identity: ReplicationIdentity,
  ): Promise<CommittedRecord | undefined> {
    return await this.committed(identity) as CommittedRecord | undefined;
  }

  private async quarantinePartition(
    identity: ReplicationIdentity,
    options: {
      readonly expect: string;
      readonly fingerprint?: string;
      readonly lease?: ReplicaLease;
    },
  ): Promise<boolean> {
    const partition = replicaPartitionKey(identity);
    const fence = replicaFence(options.lease ?? await this.leaseFor(identity), identity);
    const transaction = this.database.transaction(
      [COMMITTED, COMMITTED_HEADS, CREDENTIAL_BINDINGS, CACHE_CANDIDATES, GENERATIONS],
      "readwrite",
    );
    try {
      await enforceFence(transaction, fence);
      const current = await requestResult<unknown>(
        transaction.objectStore(COMMITTED).get(partition),
      );
      if (replicaManifestFingerprint(current) !== options.expect) {
        await abortTransaction(transaction);
        return false;
      }
      transaction.objectStore(COMMITTED).delete(partition);
      transaction.objectStore(COMMITTED_HEADS).delete(partition);
      const bindings = transaction.objectStore(CREDENTIAL_BINDINGS);
      if (options.fingerprint !== undefined) {
        bindings.delete(options.fingerprint);
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
      await this.boundaries.checkpoint("replica.quarantine");
    } catch (error) {
      await abortTransaction(transaction);
      throw error;
    }
    await commitTransaction(transaction);
    return true;
  }

  private async validated(
    record: unknown,
    identity: ReplicationIdentity,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
    fingerprint?: string,
  ): Promise<ReplicaRestoreOutcome<RetainedRecord>> {
    let current = record;
    for (let attempt = 1; attempt <= REPLICA_SWEEP_RESTORE_ATTEMPTS; attempt++) {
      const outcome = await this.validatedOnce(
        current,
        identity,
        attributes,
        readCompatibilityHash,
        fingerprint,
      );
      if (outcome !== RECORD_MOVED) return outcome;
      current = await this.committed(identity);
      if (current === undefined) return replicaAbsent();
      const stored = replicaManifestIdentity(current);
      if (stored !== undefined && !sameReplicationIdentity(stored, identity)) {
        return replicaAbsent();
      }
    }
    return replicaContended(
      replicaPartitionKey(identity),
      REPLICA_SWEEP_RESTORE_ATTEMPTS,
    );
  }

  private async validatedOnce(
    record: unknown,
    identity: ReplicationIdentity,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
    fingerprint?: string,
  ): Promise<ReplicaRestoreOutcome<RetainedRecord> | typeof RECORD_MOVED> {
    const partition = replicaPartitionKey(identity);
    const expect = replicaManifestFingerprint(record);
    const lease = await this.leaseFor(identity);
    const sweep = await this.sweepGeneration(partition);
    const quarantine = async (
      reason: Parameters<typeof replicaUnusable>[1],
      detail: string,
    ): Promise<ReplicaRestoreOutcome<RetainedRecord> | typeof RECORD_MOVED> => {
      await this.boundaries.checkpoint("replica.refused");
      const removed = await this.quarantinePartition(identity, {
        expect,
        lease,
        ...(fingerprint === undefined ? {} : { fingerprint }),
      });
      return removed
        ? replicaUnusable<RetainedRecord>(partition, reason, detail)
        : RECORD_MOVED;
    };
    if (identity.readCompatibilityHash !== readCompatibilityHash) {
      return quarantine(
        "read-compatibility",
        "the selected identity does not confirm this client's read compatibility",
      );
    }
    const manifest = validateReplicaManifest(record, { partition, readCompatibilityHash });
    if (Result.isFailure(manifest)) {
      return quarantine(manifest.failure.reason, manifest.failure.detail);
    }
    if (!sameReplicaAttributes(manifest.success.attributes, replicaAttributes(attributes))) {
      return quarantine(
        "schema-metadata",
        "replica attribute metadata is incompatible with the committed read view",
      );
    }
    const invalid = await validateReachableNodes(this.database, manifest.success);
    if (invalid !== undefined) return quarantine(invalid.reason, invalid.detail);
    await this.boundaries.checkpoint("replica.validated");
    const retention = this.retainRoots(identity, manifest.success.roots);
    if (!await this.confirmGuardingGenerations(lease, identity, sweep)) {
      retention();
      return RECORD_MOVED;
    }
    return replicaRestored({ record: manifest.success, release: retention });
  }

  private async confirmNoSweep(
    transaction: IDBTransaction,
    partition: string,
    observed: number,
  ): Promise<void> {
    const key = replicaSweepKey(partition);
    const record = await requestResult<GenerationRecord | undefined>(
      transaction.objectStore(GENERATIONS).get(key),
    );
    const current = record?.generation ?? 0;
    if (current === observed) return;
    await abortTransaction(transaction);
    throw new ReplicaFencedError({ key, expected: observed, observed: current });
  }

  private async sweepGeneration(partition: string): Promise<number> {
    const transaction = this.database.transaction(GENERATIONS, "readonly");
    const record = await requestResult<GenerationRecord | undefined>(
      transaction.objectStore(GENERATIONS).get(replicaSweepKey(partition)),
    );
    await transactionDone(transaction);
    return record?.generation ?? 0;
  }

  private async confirmGuardingGenerations(
    lease: ReplicaLease,
    identity: ReplicationIdentity,
    sweep: number,
  ): Promise<boolean> {
    const transaction = this.database.transaction(GENERATIONS, "readonly");
    await enforceFence(transaction, replicaFence(lease, identity));
    const record = await requestResult<GenerationRecord | undefined>(
      transaction.objectStore(GENERATIONS).get(
        replicaSweepKey(replicaPartitionKey(identity)),
      ),
    );
    await transactionDone(transaction);
    return (record?.generation ?? 0) === sweep;
  }

  async boundIdentity(
    fingerprint: string,
  ): Promise<ReplicationIdentity | undefined> {
    const transaction = this.database.transaction(CREDENTIAL_BINDINGS, "readonly");
    const record = await requestResult<CredentialBindingRecord | undefined>(
      transaction.objectStore(CREDENTIAL_BINDINGS).get(fingerprint),
    );
    await transactionDone(transaction);
    return record?.identity;
  }

  async unbindCredential(fingerprint: string): Promise<void> {
    const transaction = this.database.transaction(CREDENTIAL_BINDINGS, "readwrite");
    transaction.objectStore(CREDENTIAL_BINDINGS).delete(fingerprint);
    await commitTransaction(transaction);
  }

  async restoreOutcome(
    identity: ReplicationIdentity,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<ReplicaRestoreOutcome<RestoredReplica>> {
    this.assertScopeLive(replicaScopeOf(identity));
    const record = await this.committed(identity);
    if (record === undefined) return replicaAbsent();
    const stored = replicaManifestIdentity(record);
    if (stored !== undefined && !sameReplicationIdentity(stored, identity)) {
      return replicaAbsent();
    }
    const validated = await this.validated(
      record,
      identity,
      attributes,
      readCompatibilityHash,
    );
    if (validated._tag !== "restored") return validated;
    return replicaRestored({
      db: dbFromRecord(this.database, validated.replica.record, readCompatibilityHash),
      revision: validated.replica.record.revision,
      ordinal: validated.replica.record.ordinal,
      settled: validated.replica.record.settled,
      handles: recordHandles(validated.replica.record),
      release: validated.replica.release,
    });
  }

  async restore(
    identity: ReplicationIdentity,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<RestoredReplica | undefined> {
    return restoredReplica(
      await this.restoreOutcome(identity, attributes, readCompatibilityHash),
    );
  }

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
      !isReplicationOrdinal(head.ordinal) ||
      !sameReplicationIdentity(head.identity, binding.identity)
    ) {
      return undefined;
    }
    return Object.freeze({
      identity: binding.identity,
      revision: head.revision,
      ordinal: head.ordinal,
    });
  }

  async committedPosition(
    identity: ReplicationIdentity,
  ): Promise<ReplicaCommittedPosition | undefined> {
    const partition = replicaPartitionKey(identity);
    const transaction = this.database.transaction(COMMITTED_HEADS, "readonly");
    const head = await requestResult<CommittedHeadRecord | undefined>(
      transaction.objectStore(COMMITTED_HEADS).get(partition),
    );
    await transactionDone(transaction);
    if (
      head === undefined ||
      head.storageVersion !== REPLICA_STORAGE_VERSION ||
      head.partition !== partition ||
      head.readCompatibilityHash !== identity.readCompatibilityHash ||
      !isReplicationOrdinal(head.ordinal) ||
      !isReplicationSettlement(head.settled) ||
      !sameReplicationIdentity(head.identity, identity)
    ) {
      return undefined;
    }
    return Object.freeze({
      revision: head.revision,
      ordinal: head.ordinal,
      settled: head.settled,
    });
  }

  async restoreCandidateOutcome(
    candidate: ReplicaCacheCandidate,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<ReplicaRestoreOutcome<BoundRestoredReplica>> {
    this.assertScopeLive(replicaScopeOf(candidate.identity));
    const record = await this.committed(candidate.identity);
    if (record === undefined) return replicaAbsent();
    const stored = replicaManifestIdentity(record);
    if (stored !== undefined && !sameReplicationIdentity(stored, candidate.identity)) {
      return replicaAbsent();
    }
    const validated = await this.validated(
      record,
      candidate.identity,
      attributes,
      readCompatibilityHash,
    );
    if (validated._tag !== "restored") return validated;
    if (validated.replica.record.revision !== candidate.revision) {
      validated.replica.release();
      return replicaAbsent();
    }
    return replicaRestored({
      identity: candidate.identity,
      db: dbFromRecord(this.database, validated.replica.record, readCompatibilityHash),
      revision: validated.replica.record.revision,
      ordinal: validated.replica.record.ordinal,
      settled: validated.replica.record.settled,
      handles: recordHandles(validated.replica.record),
      release: validated.replica.release,
    });
  }

  async restoreConfirmedCandidate(
    candidate: ReplicaCacheCandidate,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<BoundRestoredReplica | undefined> {
    return restoredReplica(
      await this.restoreCandidateOutcome(candidate, attributes, readCompatibilityHash),
    );
  }

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

  async bindAuthenticated(
    binding: ReplicaAuthenticatedBinding,
    options: ReplicaInstallOptions = {},
  ): Promise<void> {
    const scopeKey = this.assertScopeLive(replicaScopeOf(binding.identity));
    const databaseKey = replicaDatabaseKey(replicaDatabaseScopeOf(binding.identity));
    const transaction = this.database.transaction(
      [CREDENTIAL_BINDINGS, CACHE_CANDIDATES, ROUTE_SLOTS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      const generations = transaction.objectStore(GENERATIONS);
      const candidates = transaction.objectStore(CACHE_CANDIDATES);
      const [scopeRecord, databaseRecord, existingRoute] = await Promise.all([
        requestResult<GenerationRecord | undefined>(generations.get(scopeKey)),
        requestResult<GenerationRecord | undefined>(generations.get(databaseKey)),
        binding.route === undefined
          ? undefined
          : requestResult<RouteSlotRecord | undefined>(
            transaction.objectStore(ROUTE_SLOTS).get([binding.route.scope, binding.route.pathKey]),
          ),
      ]);
      for (const seeded of confirmationRecords(binding.identity, Date.now())) {
        const existing = seeded.kind === "scope" ? scopeRecord : databaseRecord;
        if (existing === undefined) generations.put(seeded);
      }
      if (options.lease !== undefined) {
        try {
          options.lease.observe(scopeKey, scopeRecord?.generation ?? 1);
          options.lease.observe(databaseKey, databaseRecord?.generation ?? 1);
          options.lease.admit(scopeKey, scopeRecord?.clearedAt ?? 0);
        } catch (error) {
          await abortTransaction(transaction);
          throw error;
        }
      }
      const replaced = await this.stageReplacedPrincipals(
        transaction,
        binding.identity,
        binding.candidateKey?.selector,
      );
      transaction.objectStore(CREDENTIAL_BINDINGS).put({
        fingerprint: binding.fingerprint,
        identity: binding.identity,
      } satisfies CredentialBindingRecord);
      if (binding.candidateKey !== undefined) {
        candidates.put({
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
          replicaScopes: withConfirmedScope(
            existingRoute?.slot === binding.route.slot
              ? existingRoute.replicaScopes
              : undefined,
            scopeKey,
          ),
        } satisfies RouteSlotRecord);
      }
      await commitTransaction(transaction);
      for (const scope of replaced) this.announce(replicaNotice("reset", scope));
      this.announce(identityNotice("selector", binding.identity));
    } finally {
      removeAbort();
    }
  }

  private async stageReplacedPrincipals(
    transaction: IDBTransaction,
    confirmed: ReplicationIdentity,
    selector: string | undefined,
  ): Promise<readonly ReplicaScope[]> {
    if (selector === undefined) return [];
    const candidates = transaction.objectStore(CACHE_CANDIDATES);
    const held = await requestResult<CacheCandidateRecord[]>(
      candidates.getAll(compoundPrefixRange(selector)),
    );
    const replaced = new Map<string, ReplicaScope>();
    for (const candidate of held) {
      const previous = replicaScopeOf(candidate.identity);
      if (identityInScope(confirmed, previous)) continue;
      candidates.delete([candidate.selector, candidate.routeSlot]);
      replaced.set(replicaScopeKey(previous), previous);
    }
    if (replaced.size === 0) return [];
    const generations = transaction.objectStore(GENERATIONS);
    const clearedAt = await this.advanceBarrier(generations);
    for (const key of replaced.keys()) {
      const record = await requestResult<GenerationRecord | undefined>(
        generations.get(key),
      );
      generations.put({
        key,
        kind: "scope",
        scope: key,
        generation: (record?.generation ?? 0) + 1,
        confirmedAt: record?.confirmedAt ?? Date.now(),
        fencedAt: Date.now(),
        clearedAt,
      } satisfies GenerationRecord);
    }
    return Object.freeze([...replaced.values()]);
  }

  private async advanceBarrier(
    generations: IDBObjectStore,
    held?: GenerationRecord | undefined,
  ): Promise<number> {
    const barrier = held ?? await requestResult<GenerationRecord | undefined>(
      generations.get(REPLICA_CLEAR_BARRIER_KEY),
    );
    const generation = (barrier?.generation ?? 0) + 1;
    generations.put({
      key: REPLICA_CLEAR_BARRIER_KEY,
      kind: "barrier",
      scope: REPLICA_CLEAR_BARRIER_KEY,
      generation,
      confirmedAt: barrier?.confirmedAt ?? Date.now(),
      fencedAt: Date.now(),
    } satisfies GenerationRecord);
    return generation;
  }

  async bindCredential(
    fingerprint: string,
    identity: ReplicationIdentity,
    options: ReplicaInstallOptions = {},
  ): Promise<void> {
    await this.bindAuthenticated({ fingerprint, identity }, options);
  }

  async restoreBoundOutcome(
    fingerprint: string,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<ReplicaRestoreOutcome<BoundRestoredReplica>> {
    const transaction = this.database.transaction(
      [CREDENTIAL_BINDINGS, COMMITTED],
      "readonly",
    );
    const binding = await requestResult<CredentialBindingRecord | undefined>(
      transaction.objectStore(CREDENTIAL_BINDINGS).get(fingerprint),
    );
    if (binding === undefined) {
      await transactionDone(transaction);
      return replicaAbsent();
    }
    const record = await requestResult<unknown>(
      transaction.objectStore(COMMITTED).get(replicaPartitionKey(binding.identity)),
    );
    await transactionDone(transaction);
    if (record === undefined) return replicaAbsent();
    const stored = replicaManifestIdentity(record);
    if (stored !== undefined && !sameReplicationIdentity(stored, binding.identity)) {
      await this.unbindCredential(fingerprint);
      return replicaAbsent();
    }
    const validated = await this.validated(
      record,
      binding.identity,
      attributes,
      readCompatibilityHash,
      fingerprint,
    );
    if (validated._tag !== "restored") return validated;
    return replicaRestored({
      identity: binding.identity,
      db: dbFromRecord(this.database, validated.replica.record, readCompatibilityHash),
      revision: validated.replica.record.revision,
      ordinal: validated.replica.record.ordinal,
      settled: validated.replica.record.settled,
      handles: recordHandles(validated.replica.record),
      release: validated.replica.release,
    });
  }

  async restoreBound(
    fingerprint: string,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<BoundRestoredReplica | undefined> {
    return restoredReplica(
      await this.restoreBoundOutcome(fingerprint, attributes, readCompatibilityHash),
    );
  }

  async resetStaging(
    identity: ReplicationIdentity,
    options: ReplicaInstallOptions = {},
  ): Promise<void> {
    this.assertScopeLive(replicaScopeOf(identity));
    const fence = replicaFence(options.lease, identity);
    const partition = replicaPartitionKey(identity);
    const transaction = this.database.transaction(
      [STAGING, STAGING_CHUNKS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      await enforceFence(transaction, fence);
      transaction.objectStore(STAGING).delete(partition);
      transaction.objectStore(STAGING_CHUNKS).delete(chunkRange(partition));
      await commitTransaction(transaction);
      this.announce(identityNotice("reset", identity));
    } finally {
      removeAbort();
    }
  }

  async startSnapshot(
    frame: SnapshotStart,
    options: ReplicaInstallOptions = {},
  ): Promise<void> {
    this.assertScopeLive(replicaScopeOf(frame.identity));
    const fence = replicaFence(options.lease, frame.identity);
    const partition = replicaPartitionKey(frame.identity);
    const transaction = this.database.transaction(
      [COMMITTED, STAGING, STAGING_CHUNKS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      await enforceFence(transaction, fence);
      const staging = transaction.objectStore(STAGING);
      const [current, committed] = await Promise.all([
        requestResult<StagingRecord | undefined>(staging.get(partition)),
        requestResult<CommittedRecord | undefined>(
          transaction.objectStore(COMMITTED).get(partition),
        ),
      ]);
      if (
        current !== undefined && current.snapshot === frame.snapshot &&
        current.revision === frame.revision &&
        sameReplicationIdentity(current.identity, frame.identity) &&
        current.baseRevision === (committed?.revision ?? null)
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
      this.meter.staging++;
    } finally {
      removeAbort();
    }
  }

  async stageSnapshotChunk(
    frame: SnapshotChunk,
    options: ReplicaInstallOptions = {},
  ): Promise<void> {
    this.assertScopeLive(replicaScopeOf(frame.identity));
    const fence = replicaFence(options.lease, frame.identity);
    const partition = replicaPartitionKey(frame.identity);
    const transaction = this.database.transaction(
      [STAGING, STAGING_CHUNKS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      await enforceFence(transaction, fence);
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
        chunks.put({
          partition,
          index: frame.index,
          datoms: frame.datoms,
          handles: frame.handles,
        } satisfies StagingChunkRecord);
        await commitTransaction(transaction);
        this.meter.stagingChunks++;
        return;
      }
      await commitTransaction(transaction);
    } finally {
      removeAbort();
    }
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
      protocol: REPLICATION_PROTOCOL_VERSION,
      identity: staging.identity,
      snapshot: staging.snapshot,
      revision: staging.revision,
    });
    for (const chunk of chunks.sort((a, b) => a.index - b.index)) {
      state = transition(state, {
        type: "SnapshotChunk",
        protocol: REPLICATION_PROTOCOL_VERSION,
        identity: staging.identity,
        snapshot: staging.snapshot,
        index: chunk.index,
        datoms: chunk.datoms,
        handles: chunk.handles ?? [],
      });
    }
    return { state: transition(state, frame), baseRevision: staging.baseRevision };
  }

  private async installWithQuotaRecovery<A>(
    partition: string,
    signal: AbortSignal | undefined,
    install: () => Promise<A>,
  ): Promise<A> {
    let reclaimedNodes = 0;
    for (let attempt = 1;; attempt++) {
      try {
        return await install();
      } catch (error) {
        const recovery = replicaQuotaRecovery(attempt, classifyReplicaStorageFailure(error));
        if (recovery === "propagate") throw error;
        if (recovery === "exhausted") {
          throw new ReplicaQuotaExhaustedError({ partition, reclaimedNodes });
        }
        signal?.throwIfAborted();
        await this.boundaries.checkpoint("replica.quota");
        try {
          reclaimedNodes = (await this.collectGarbage()).nodes;
        } catch (sweepError) {
          if (classifyReplicaStorageFailure(sweepError) !== "quota") throw sweepError;
        }
      }
    }
  }

  async commitSnapshot(
    frame: SnapshotCommit,
    attributes: readonly AttributeSpec[],
    options: ReplicaInstallOptions = {},
  ): Promise<RestoredReplica | undefined> {
    this.assertScopeLive(replicaScopeOf(frame.identity));
    const installed = await this.installWithQuotaRecovery(
      replicaPartitionKey(frame.identity),
      options.signal,
      () => this.commitSnapshotOnce(frame, attributes, options),
    );
    if (installed !== undefined) {
      this.announce(identityNotice("replica", frame.identity));
    }
    return installed;
  }

  private async commitSnapshotOnce(
    frame: SnapshotCommit,
    attributes: readonly AttributeSpec[],
    options: ReplicaInstallOptions,
  ): Promise<RestoredReplica | undefined> {
    const fence = replicaFence(options.lease, frame.identity);
    const [staged, prior] = await Promise.all([
      this.stagedState(frame),
      this.priorManifest(frame.identity),
    ]);
    const committed = staged.state.committed;
    if (committed?.revision !== frame.revision) return undefined;
    if ((prior?.revision ?? null) !== staged.baseRevision) return undefined;
    const partition = replicaPartitionKey(frame.identity);
    const materializing = this.markMaterializing(partition);
    try {
      const sweep = await this.sweepGeneration(partition);
      return await this.installSnapshot(
        frame,
        attributes,
        options,
        committed,
        staged.baseRevision,
        prior,
        fence,
        partition,
        sweep,
      );
    } finally {
      materializing();
    }
  }

  private async installSnapshot(
    frame: SnapshotCommit,
    attributes: readonly AttributeSpec[],
    options: ReplicaInstallOptions,
    committed: CommittedReplica,
    baseRevision: string | null,
    prior: CommittedRecord | undefined,
    fence: ReplicaFence | undefined,
    partition: string,
    sweep: number,
  ): Promise<RestoredReplica | undefined> {
    const built = await materialize(
      this.database,
      frame.identity,
      committed,
      attributes,
      prior,
      options.signal,
      fence,
      this.meter,
    );
    options.signal?.throwIfAborted();
    await this.boundaries.checkpoint("replica.installing");
    const transaction = this.database.transaction(
      [COMMITTED, COMMITTED_HEADS, STAGING, STAGING_CHUNKS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(transaction, options.signal);
    let settled = built.record.settled;
    try {
      await enforceFence(transaction, fence);
      await this.confirmNoSweep(transaction, partition, sweep);
      const current = await requestResult<StagingRecord | undefined>(
        transaction.objectStore(STAGING).get(built.record.partition),
      );
      const currentCommitted = await requestResult<CommittedRecord | undefined>(
        transaction.objectStore(COMMITTED).get(built.record.partition),
      );
      const head = await requestResult<CommittedHeadRecord | undefined>(
        transaction.objectStore(COMMITTED_HEADS).get(built.record.partition),
      );
      if (
        current === undefined || current.snapshot !== frame.snapshot ||
        current.revision !== frame.revision ||
        !sameReplicationIdentity(current.identity, frame.identity) ||
        (currentCommitted?.revision ?? null) !== baseRevision
      ) {
        await abortTransaction(transaction);
        return undefined;
      }
      if (!supersedesStoredHead(storedOrdinal(head, currentCommitted), built.record)) {
        await abortTransaction(transaction);
        throw new ReplicaSupersededError({
          partition,
          revision: frame.revision,
          ordinal: frame.ordinal,
        });
      }
      const installed = mergedSettlement(built.record, currentCommitted, head);
      settled = installed.settled;
      transaction.objectStore(COMMITTED).put(installed);
      transaction.objectStore(COMMITTED_HEADS).put(committedHead(installed));
      transaction.objectStore(STAGING).delete(built.record.partition);
      transaction.objectStore(STAGING_CHUNKS).delete(chunkRange(built.record.partition));
      await this.boundaries.checkpoint("replica.install");
      await commitTransaction(transaction);
      this.meter.manifests++;
      this.meter.heads++;
    } catch (error) {
      await abortTransaction(transaction);
      throw error;
    } finally {
      removeAbort();
    }
    return {
      db: built.db,
      revision: built.record.revision,
      ordinal: built.record.ordinal,
      settled,
      handles: recordHandles(built.record),
      release: this.retainRoots(frame.identity, built.record.roots),
    };
  }

  async acknowledgeOrdinal(
    acknowledgement: ReplicaOrdinalAcknowledgement,
    options: ReplicaInstallOptions = {},
  ): Promise<AcknowledgedReplicaPosition | undefined> {
    this.assertScopeLive(replicaScopeOf(acknowledgement.identity));
    const fence = replicaFence(options.lease, acknowledgement.identity);
    const partition = replicaPartitionKey(acknowledgement.identity);
    const sweep = await this.sweepGeneration(partition);
    options.signal?.throwIfAborted();
    await this.boundaries.checkpoint("replica.installing");
    const write = this.database.transaction(
      [COMMITTED, COMMITTED_HEADS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(write, options.signal);
    try {
      await enforceFence(write, fence);
      await this.confirmNoSweep(write, partition, sweep);
      const [current, head] = await Promise.all([
        requestResult<CommittedRecord | undefined>(
          write.objectStore(COMMITTED).get(partition),
        ),
        requestResult<CommittedHeadRecord | undefined>(
          write.objectStore(COMMITTED_HEADS).get(partition),
        ),
      ]);
      if (
        current === undefined ||
        current.revision !== acknowledgement.revision
      ) {
        await abortTransaction(write);
        return undefined;
      }
      const merged = mergedSettlement(
        { ...current, settled: acknowledgement.settled },
        current,
        head,
      );
      const settled = merged.settled;
      if (
        current.ordinal >= acknowledgement.ordinal &&
        settled === current.settled
      ) {
        if (recordOrdinal(head) === undefined) {
          write.objectStore(COMMITTED_HEADS).put(committedHead(current));
          await commitTransaction(write);
          this.meter.heads++;
          return positionOf(current);
        }
        await transactionDone(write);
        return positionOf(current);
      }
      const acknowledged: CommittedRecord = {
        ...merged,
        ordinal: Math.max(current.ordinal, acknowledgement.ordinal),
      };
      write.objectStore(COMMITTED).put(acknowledged);
      write.objectStore(COMMITTED_HEADS).put(committedHead(acknowledged));
      await this.boundaries.checkpoint("replica.install");
      await commitTransaction(write);
      this.meter.manifests++;
      this.meter.heads++;
      if (settled > current.settled) {
        this.announce(identityNotice("replica", acknowledgement.identity));
      }
      return positionOf(acknowledged);
    } catch (error) {
      await abortTransaction(write);
      throw error;
    } finally {
      removeAbort();
    }
  }

  private async settleCommitted(
    identity: ReplicationIdentity,
    options: ReplicaInstallOptions,
    partition: string,
    fence: ReplicaFence | undefined,
    settlement: {
      readonly revision: string;
      readonly stored: number;
      readonly observed: number;
    },
  ): Promise<number> {
    const sweep = await this.sweepGeneration(partition);
    options.signal?.throwIfAborted();
    await this.boundaries.checkpoint("replica.installing");
    const write = this.database.transaction(
      [COMMITTED, COMMITTED_HEADS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(write, options.signal);
    try {
      await enforceFence(write, fence);
      await this.confirmNoSweep(write, partition, sweep);
      const [current, head] = await Promise.all([
        requestResult<CommittedRecord | undefined>(
          write.objectStore(COMMITTED).get(partition),
        ),
        requestResult<CommittedHeadRecord | undefined>(
          write.objectStore(COMMITTED_HEADS).get(partition),
        ),
      ]);
      if (current === undefined || current.revision !== settlement.revision) {
        await abortTransaction(write);
        return settlement.stored;
      }
      const merged = mergedSettlement(
        { ...current, settled: settlement.observed },
        current,
        head,
      );
      if (merged.settled === current.settled) {
        await transactionDone(write);
        return current.settled;
      }
      write.objectStore(COMMITTED).put(merged);
      write.objectStore(COMMITTED_HEADS).put(committedHead(merged));
      await this.boundaries.checkpoint("replica.install");
      await commitTransaction(write);
      this.meter.manifests++;
      this.meter.heads++;
      this.announce(identityNotice("replica", identity));
      return merged.settled;
    } catch (error) {
      await abortTransaction(write);
      throw error;
    } finally {
      removeAbort();
    }
  }

  async applyChange(
    frame: Change,
    options: ReplicaInstallOptions = {},
  ): Promise<RestoredReplica | undefined> {
    this.assertScopeLive(replicaScopeOf(frame.identity));
    const installed = await this.installWithQuotaRecovery(
      replicaPartitionKey(frame.identity),
      options.signal,
      () => this.applyChangeOnce(frame, options),
    );
    if (installed !== undefined) {
      this.announce(identityNotice("replica", frame.identity));
    }
    return installed;
  }

  private async applyChangeOnce(
    frame: Change,
    options: ReplicaInstallOptions,
  ): Promise<RestoredReplica | undefined> {
    const fence = replicaFence(options.lease, frame.identity);
    const partition = replicaPartitionKey(frame.identity);
    const read = this.database.transaction(COMMITTED, "readonly");
    const prior = await requestResult<CommittedRecord | undefined>(
      read.objectStore(COMMITTED).get(partition),
    );
    await transactionDone(read);
    if (prior === undefined) return undefined;
    const state = transition({
      identity: prior.identity,
      committed: {
        revision: prior.revision,
        ordinal: prior.ordinal,
        settled: prior.settled,
        datoms: prior.datoms,
        handles: new Map(prior.entityHandles),
      },
      closed: false,
    }, frame);
    if (state.committed === undefined || state.committed.revision === prior.revision) {
      const settled = state.committed !== undefined &&
          state.committed.settled > prior.settled
        ? await this.settleCommitted(frame.identity, options, partition, fence, {
          revision: prior.revision,
          stored: prior.settled,
          observed: state.committed.settled,
        })
        : prior.settled;
      return {
        db: dbFromRecord(this.database, prior, frame.identity.readCompatibilityHash),
        revision: prior.revision,
        ordinal: prior.ordinal,
        settled,
        handles: recordHandles(prior),
        release: this.retainRoots(frame.identity, prior.roots),
      };
    }
    const materializing = this.markMaterializing(partition);
    try {
      const sweep = await this.sweepGeneration(partition);
      return await this.installChange(
        frame,
        options,
        state.committed,
        prior,
        fence,
        partition,
        sweep,
      );
    } finally {
      materializing();
    }
  }

  private async installChange(
    frame: Change,
    options: ReplicaInstallOptions,
    committed: CommittedReplica,
    prior: CommittedRecord,
    fence: ReplicaFence | undefined,
    partition: string,
    sweep: number,
  ): Promise<RestoredReplica | undefined> {
    const built = await materialize(
      this.database,
      frame.identity,
      committed,
      prior.attributes,
      prior,
      options.signal,
      fence,
      this.meter,
    );
    options.signal?.throwIfAborted();
    await this.boundaries.checkpoint("replica.installing");
    const write = this.database.transaction(
      [COMMITTED, COMMITTED_HEADS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(write, options.signal);
    let settled = built.record.settled;
    try {
      await enforceFence(write, fence);
      await this.confirmNoSweep(write, partition, sweep);
      const current = await requestResult<CommittedRecord | undefined>(
        write.objectStore(COMMITTED).get(partition),
      );
      const head = await requestResult<CommittedHeadRecord | undefined>(
        write.objectStore(COMMITTED_HEADS).get(partition),
      );
      if (current?.revision !== prior.revision) {
        await abortTransaction(write);
        return undefined;
      }
      if (!supersedesStoredHead(storedOrdinal(head, current), built.record)) {
        await abortTransaction(write);
        throw new ReplicaSupersededError({
          partition,
          revision: frame.revision,
          ordinal: frame.ordinal,
        });
      }
      const installed = mergedSettlement(built.record, current, head);
      settled = installed.settled;
      write.objectStore(COMMITTED).put(installed);
      write.objectStore(COMMITTED_HEADS).put(committedHead(installed));
      await this.boundaries.checkpoint("replica.install");
      await commitTransaction(write);
      this.meter.manifests++;
      this.meter.heads++;
    } catch (error) {
      await abortTransaction(write);
      throw error;
    } finally {
      removeAbort();
    }
    return {
      db: built.db,
      revision: built.record.revision,
      ordinal: built.record.ordinal,
      settled,
      handles: recordHandles(built.record),
      release: this.retainRoots(frame.identity, built.record.roots),
    };
  }
}
