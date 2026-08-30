/** Native IndexedDB persistence for one complete logical client replica. */

import * as Result from "effect/Result";
import type { ReadCompatibilityHash } from "../authorization/identities.ts";
import { ALL_INDEXES, type Datom } from "../core/datom.ts";
import { buildRoots } from "../core/conn.ts";
import { sha256Hex } from "../core/bytes.ts";
import { Db, rootFor } from "../core/db.ts";
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
  REPLICA_STORAGE_VERSION,
  type Change,
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
  identityInDatabase,
  identityInScope,
  REPLICA_GENERATIONS_STORE,
  replicaDatabaseKey,
  replicaDatabasePartitionPrefix,
  replicaDatabaseScopeOf,
  replicaPartitionKey,
  replicaScopeKey,
  replicaScopeOf,
  replicaScopePartitionPrefix,
  withConfirmedScope,
  withoutConfirmedScope,
  ReplicaDatabaseActiveError,
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

/** The IndexedDB version that introduced replica storage version 2. */
const STORAGE_V2_DATABASE_VERSION = 5;
/** The IndexedDB version that added the durable lifecycle generation records. */
const LIFECYCLE_DATABASE_VERSION = 6;
/**
 * The version that added #475's mutation queue store families, and the one
 * that added their global-identity indexes.
 *
 * Version 7 existed only inside this unreleased change.
 *
 * Opening at an unchanged version never fires `upgradeneeded`, so a database
 * an earlier build of this same unreleased format already created would keep
 * the older index shape and fail at the first allocating enqueue. The bump is
 * what makes {@link createMutationStores} run again and reconcile them.
 */
const MUTATION_INDEX_DATABASE_VERSION = 8;
const DATABASE_VERSION = MUTATION_INDEX_DATABASE_VERSION;
const COMMITTED = "replica-committed-v1";
const COMMITTED_HEADS = "replica-committed-heads-v1";
const STAGING = "replica-staging-v1";
const STAGING_CHUNKS = "replica-staging-chunks-v1";
const NODES = "replica-nodes-v1";
const CREDENTIAL_BINDINGS = "replica-credential-bindings-v1";
const CACHE_CANDIDATES = "replica-cache-candidates-v1";
const ROUTE_SLOTS = "replica-route-slots-v1";
const GENERATIONS = REPLICA_GENERATIONS_STORE;
const USER_T = 2;

/**
 * Every store family this storage format owns. The pre-public migration resets
 * exactly these.
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
  GENERATIONS,
] as const;

/**
 * Families keyed by the replica partition key alone.
 *
 * Scoped clear and database eviction delete one prefix range from each family
 * below. #475's mutation families are *not* here: they are keyed by the stable
 * server/principal/database triple rather than by the read-view-bearing
 * replica partition, precisely so a compatible schema change or a cache
 * eviction cannot discard unsubmitted work. A scoped clear removes them
 * through {@link clearMutationScope}, in the very same transaction.
 */
const PARTITION_KEYED_FAMILIES = [COMMITTED, COMMITTED_HEADS, STAGING] as const;

/** Families whose compound key begins with the replica partition key. */
const PARTITION_PREFIXED_FAMILIES = [STAGING_CHUNKS, NODES] as const;

/** Families holding one authenticated identity per record. */
const IDENTITY_KEYED_FAMILIES = [CREDENTIAL_BINDINGS, CACHE_CANDIDATES] as const;

export const DEFAULT_REPLICA_DATABASE_NAME = "ramose-replicas";

/** Authenticator and catalog rotation do not create another stored partition. */
export { replicaPartitionKey } from "./replica-lifecycle.ts";

/**
 * The manifest shape lives in `replica-integrity.ts` because validating it is
 * the only thing that turns a structured-clone result into one.
 */
type CommittedRecord = ReplicaManifest;

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
  /**
   * Replica scopes that have confirmed this observation. An observation is
   * looked up before any identity is known, so it cannot be keyed by
   * principal; this list lets a scoped clear withdraw only its own
   * confirmation and delete the record only once nobody else claims it.
   */
  readonly replicaScopes?: readonly string[];
};

/**
 * The durable fence guarding one scope or one stable graph database.
 *
 * Generations only ever increase, and the record survives a clear, so a
 * session leased under an older generation can never become writable again.
 * #478 extends this same record into the all-tab barrier: it is durable,
 * readable inside any write transaction, and independent of BroadcastChannel.
 */
type GenerationRecord = {
  readonly key: string;
  readonly kind: "scope" | "database";
  /** Owning scope key; a scope record owns itself. */
  readonly scope: string;
  readonly generation: number;
  /** When this realm was first confirmed by an authenticated response. */
  readonly confirmedAt: number;
  /** When the last destructive maintenance bumped this record. */
  readonly fencedAt: number | null;
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
  /**
   * The caller's lifecycle lease. Supplying one makes this write refuse to
   * install data whose scope or database was fenced by a clear or eviction.
   */
  readonly lease?: ReplicaLease | undefined;
};

/** What one scoped clear removed, for callers that report or assert on it. */
export type ReplicaClearOutcome = {
  readonly scope: string;
  readonly generation: number;
  readonly partitions: number;
  readonly nodes: number;
  readonly bindings: number;
  readonly candidates: number;
  readonly routeObservations: number;
  /** Queued invocations removed with the replicas, in the same transaction. */
  readonly queued: number;
  readonly clientRefs: number;
};

/** What one database eviction removed. */
export type ReplicaEvictOutcome = {
  readonly database: string;
  readonly generation: number;
  readonly partitions: number;
  readonly nodes: number;
  readonly bindings: number;
  readonly candidates: number;
};

/**
 * A live participant that destructive maintenance must close before it
 * returns. #478 replaces the same-realm registry with the all-tab barrier.
 */
export type ReplicaScopeParticipant = {
  readonly scope: ReplicaScope;
  /** Absent means the participant spans the whole scope. */
  readonly database?: ReplicaDatabaseScope | undefined;
  readonly close: () => Promise<void>;
};

type LifecycleRegistry = {
  readonly pins: Map<string, number>;
  readonly participants: Set<ReplicaScopeParticipant>;
};

/**
 * Pins and live sessions are properties of the stored database, not of one
 * adapter handle: two handles opened on the same name in one tab read and
 * write the very same records. Sharing the registry by database name is what
 * stops one handle from evicting a database another handle's session is
 * actively reading, or from clearing a scope without closing that session's
 * now-dangling `Db`. Registries are per JS realm; #478 raises the same
 * guarantee to the other tabs.
 */
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

/**
 * Adopt the confirmations a pre-generation database already proves.
 *
 * Manifests, exact credential bindings, and cache candidates are written only
 * from a server-authenticated response, so each one is durable evidence that
 * its scope was confirmed. Without this seed a replica installed before the
 * generation store existed would look unconfirmed forever — a session that
 * restores an exact binding never revisits `bindAuthenticated` — and its owner
 * could never clear their own local data.
 */
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
  // Issued after the reads above, so it observes the complete scope set. A
  // pre-generation route observation records no owner, and origin and root
  // text cannot name one, so every scope this database confirmed claims it:
  // the row then disappears when the last of them clears instead of being
  // orphaned by the first. The list is deletion ownership only — the lookup
  // has never consulted it. With nothing confirmed, nothing can own the row.
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
  const created: LifecycleRegistry = { pins: new Map(), participants: new Set() };
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

/** The durable generation records one write must still be leasing. */
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

/**
 * Read both guarding generations inside the caller's own transaction and hold
 * the lease to them. A lease that lost either generation aborts the
 * transaction, so a fenced session can never interleave old-generation data
 * with a completed clear or eviction.
 */
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
    return ref;
  }
}

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
  fence?: ReplicaFence | undefined,
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
  // The very projection a restore replays to prove the stored journal, id maps,
  // and physical indexes still describe one value.
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

  const store = new IndexedDbNodeStore(database, partition, signal, fence);
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

/**
 * How many node bodies one validation round reads before it starts hashing.
 *
 * An IndexedDB transaction ends as soon as its last request settles and control
 * returns to the event loop, so the walk cannot hash inside one: it issues a
 * bounded batch of reads together, lets that transaction finish, and then
 * verifies the bodies. The batch is what bounds resident memory — the walk
 * never holds more than this many node bodies at a time, whatever the replica's
 * size.
 */
const VALIDATION_BATCH = 32;

/** One queued reference and the separator its parent filed it under. */
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
  // Every request is issued synchronously here, so the transaction stays live
  // until the last of them settles.
  const pending = hashes.map((hash) =>
    requestResult<NodeRecord | undefined>(store.get([partition, hash]))
  );
  const records = await Promise.all(pending);
  await transactionDone(transaction);
  return records;
};

type DecodedNode = { readonly index: IndexId; readonly node: TreeNode };

/**
 * Verify one stored record against the reference that led to it: it exists, its
 * body hashes to the address it is filed under, it decodes, and it sits in a
 * position its own contents agree with.
 */
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

/**
 * Walk every content node reachable from one manifest's four index roots.
 *
 * The walk is depth-first over references, deduplicated by content address, so
 * it costs one read, one digest, and one decode per distinct reachable node —
 * O(reachable nodes), and O(reachable datoms) for the order checks inside
 * leaves. Resident memory is one batch of bodies plus the frontier, which a
 * depth-first order keeps at O(fanout × depth).
 *
 * Full verification runs on every restore by default. The sound place to make
 * it incremental later is a durable per-partition record naming the exact root
 * hashes this client last verified together with the generation they were
 * verified under: a manifest whose roots and generation both match it could
 * then skip the walk, and any other manifest — including one written by a
 * process this client never observed — could not. #474 slice 10 measures
 * whether the 100k budget needs that; nothing here assumes it.
 */
const validateReachableNodes = async (
  database: IDBDatabase,
  manifest: ReplicaManifest,
): Promise<ReplicaIntegrityFailure | undefined> => {
  // A bulk build slices one strictly sorted datom list into disjoint leaves and
  // groups those into disjoint directories, and the index tag is part of every
  // body, so no two reachable nodes of one committed value can share an
  // address. A repeat is therefore not sharing to deduplicate — it is a link
  // into a subtree that already has a parent, which also bounds the walk.
  const seen = new Set<string>();
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
    // Each pending reference carries the separator its parent filed it under,
    // so the child can settle whether that separator still routes to it.
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

export class IndexedDbReplicaStorage {
  /**
   * Scopes this handle has cleared. A cleared scope is terminal for this
   * instance: no read, restore, or install may touch it again, so the handle
   * cannot lazily repopulate what the user asked to delete. Fresh state for
   * that scope requires a fresh {@link IndexedDbReplicaStorage.open}, which is
   * how #477's `clearLocalData()` makes the clearing client terminal.
   */
  private readonly clearedScopes = new Set<string>();
  /** Shared with every other handle on the same stored database. */
  private readonly registry: LifecycleRegistry;
  /** Registrations this handle owns, released when it closes. */
  private readonly registrations = new Set<() => void>();

  private constructor(
    readonly name: string,
    private readonly database: IDBDatabase,
    private readonly boundaries: RuntimeBoundaries,
  ) {
    this.registry = lifecycleRegistry(name);
  }

  /**
   * `boundaries` is the repository's inert runtime boundary by default; only
   * the explicit source-only testing assembly injects an armable one.
   */
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
      // #475's mutation families. They are created empty and need no data
      // migration: version 6 and earlier could not queue an invocation, and
      // version 7 only ever existed inside this unreleased change. Indexes are
      // reconciled here rather than assumed.
      if (request.transaction !== null) createMutationStores(database, request.transaction);
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
      } else if (
        oldVersion >= STORAGE_V2_DATABASE_VERSION &&
        oldVersion < LIFECYCLE_DATABASE_VERSION && request.transaction !== null
      ) {
        seedConfirmedGenerations(request.transaction);
      }
    });
    const database = await requestResult(request);
    database.addEventListener("versionchange", () => database.close());
    return new IndexedDbReplicaStorage(name, database, boundaries);
  }

  close(): void {
    for (const release of [...this.registrations]) release();
    this.database.close();
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

  /**
   * The durable mutation queue over this same connection.
   *
   * It shares the handle rather than opening its own so that a scoped clear
   * can delete the replicas and the queue in one transaction, and so an
   * enqueue can read the very generation record that fences it.
   */
  outbox(): IndexedDbOutbox {
    return new IndexedDbOutbox(
      this.database,
      this.boundaries,
      (scope) => void this.assertScopeLive(scope),
    );
  }

  /**
   * A fresh in-process lease. One session holds exactly one and passes it to
   * every install, so a clear or eviction fences it deterministically.
   */
  lease(): ReplicaLease {
    return new ReplicaLease();
  }

  /**
   * A lease that already holds the generations guarding one identity.
   *
   * A session restored from an exact credential binding never revisits
   * `bindAuthenticated`, so an empty lease would adopt whatever generation its
   * first write happens to read — including one a concurrent clear had already
   * bumped, repopulating the scope it just emptied. Reading the generations up
   * front makes that first write lose the fence instead.
   */
  async leaseFor(identity: ReplicationIdentity): Promise<ReplicaLease> {
    this.assertScopeLive(replicaScopeOf(identity));
    const lease = new ReplicaLease();
    const transaction = this.database.transaction(GENERATIONS, "readonly");
    await enforceFence(transaction, replicaFence(lease, identity));
    await transactionDone(transaction);
    return lease;
  }

  /**
   * Pin one stable graph database for as long as a session is reading it.
   * Eviction refuses a pinned database; the returned callback releases the pin
   * and is idempotent.
   */
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

  /**
   * Enroll a live session so destructive maintenance closes it before
   * returning. The durable generation is what actually prevents an
   * old-generation write; closing makes the outcome observable and
   * deterministic. #478 extends this to the other tabs.
   */
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

  /**
   * Atomically remove every replica store family belonging to one confirmed
   * server/principal scope, fencing it first so no session can write
   * old-generation data afterwards. One IndexedDB transaction performs the
   * fence and the deletion together, so a crash cut leaves either the old
   * complete state or the fully cleared state.
   *
   * Only a scope this client previously or currently confirmed with the server
   * can be named: the confirmation record is written solely by
   * {@link IndexedDbReplicaStorage.bindAuthenticated}, so `cacheKey`, bearer
   * text, path text, and unconfirmed candidates cannot select a deletion. An
   * unconfirmed scope deletes nothing and fails with a typed error.
   *
   * Other principals, other servers, other applications' IndexedDB databases,
   * and store families this format does not own are untouched.
   */
  async clearScope(scope: ReplicaScope): Promise<ReplicaClearOutcome> {
    const scopeKey = this.assertScopeLive(scope);
    const prefix = replicaScopePartitionPrefix(scope);
    // Terminal from the moment the clear begins, not from the moment it
    // commits: a write this handle started concurrently must not be able to
    // land behind the deletion. A clear that fails releases the mark again,
    // leaving the old complete state readable and the clear retryable.
    this.clearedScopes.add(scopeKey);
    const transaction = this.database.transaction(
      [...REPLICA_STORE_FAMILIES, ...MUTATION_STORE_FAMILIES],
      "readwrite",
    );
    let outcome: ReplicaClearOutcome;
    try {
      outcome = await this.stageClear(transaction, scope, scopeKey, prefix);
    } catch (error) {
      // IndexedDB auto-commits a transaction with no pending request, so a
      // failure between the deletions and the commit must roll them back
      // explicitly or a partial clear would become durable.
      this.clearedScopes.delete(scopeKey);
      await abortTransaction(transaction);
      throw error;
    }
    await commitTransaction(transaction);
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
    // The user asked to delete this principal's local data, so the durable
    // queue goes with the replicas — in this transaction, not beside it.
    const mutations = await clearMutationScope(transaction, scope);
    const generation = confirmed.generation + 1;
    generations.put({
      ...confirmed,
      generation,
      fencedAt: Date.now(),
    } satisfies GenerationRecord);
    // The last boundary before this clear becomes durable. Inert in
    // production; the source-only testing assembly arms it to cut here.
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
    });
  }

  /**
   * Evict one inactive stable graph database as a unit: every read view it has
   * ever had, all of their content nodes, staged snapshots, and the bindings
   * and candidates that select them. Ancestors, siblings, other principals, and
   * the scope's future mutation families are untouched, and the durable route
   * observation is kept so a later re-activation still finds the same stable
   * slot — it simply needs a fresh snapshot from the server.
   *
   * Eviction bumps only this database's generation, so sibling sessions in the
   * same scope keep running. A database still pinned by a live session refuses
   * eviction and deletes nothing.
   */
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

  /**
   * The stored manifest, exactly as structured clone returned it. It is
   * deliberately `unknown`: nothing but {@link validateReplicaManifest} makes it
   * a manifest, and a restore must never read a field off it first.
   */
  private async committed(identity: ReplicationIdentity): Promise<unknown> {
    const transaction = this.database.transaction(COMMITTED, "readonly");
    const record = await requestResult<unknown>(
      transaction.objectStore(COMMITTED).get(replicaPartitionKey(identity)),
    );
    await transactionDone(transaction);
    return record;
  }

  /**
   * The manifest an install continues from. Snapshot commit and change apply
   * carry the previous partition-local id assignments forward and then rebuild
   * every node, so a damaged manifest here can only produce another manifest
   * the next restore's walk refuses — it can never be published unvalidated.
   */
  private async priorManifest(
    identity: ReplicationIdentity,
  ): Promise<CommittedRecord | undefined> {
    return await this.committed(identity) as CommittedRecord | undefined;
  }

  /**
   * Quarantine exactly one replica partition.
   *
   * Quarantine withdraws a partition from selection rather than erasing it: it
   * removes the committed manifest, its head, and the exact credential binding
   * and cache candidate that would nominate it again. Nothing can restore or
   * resume that partition afterwards, which is the whole point — but a `Db`
   * another session has already published keeps reading, because a constructed
   * value holds its roots and its node store directly and stops depending on
   * the manifest the moment it exists. Deleting the nodes underneath it would
   * turn a stale value into one that throws mid-query.
   *
   * The content nodes are therefore left to #474 slice 11's reachability GC,
   * which is what sweeps partition-local nodes no manifest references. They are
   * inert in the meantime: unreachable from any manifest, and re-installing the
   * same value rewrites each node under its own address, repairing a damaged
   * body in passing. Staging is left for the same reason — a stale staging
   * record is refused by its base revision and overwritten by the next
   * `SnapshotStart`.
   *
   * Sibling read views, sibling databases, other principals, other servers, the
   * scope's durable confirmations, and its route observations all survive, so
   * quarantining a corrupt partition never costs the user anything a fresh
   * snapshot cannot restore, and never re-poses the question of whether this
   * client ever confirmed the scope.
   *
   * The #475/#476 mutation families — outbox, receipts, ClientRef mappings,
   * optimistic layers — are deliberately not listed even once they key by the
   * same partition prefix. Content is re-fetchable; a durable operation
   * identity is not, and corruption of the committed read value is no reason to
   * discard work the user has not yet had acknowledged.
   *
   * Withdrawal is still destructive, so it is generation-fenced like every
   * other destructive path: the caller's lease is re-observed inside the
   * writing transaction, and a lease that lost its generation to a concurrent
   * clear or eviction surfaces the ordinary typed fence error instead of
   * writing under a realm it no longer belongs to.
   */
  private async quarantinePartition(
    identity: ReplicationIdentity,
    options: {
      /** The exact manifest the caller refused. */
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
      // Validating a partition takes as long as reading it, and another session
      // may install a complete replacement in that window. Withdrawing anything
      // is conditional on the refused manifest still being the stored one.
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
      // The last boundary before the quarantine becomes durable. Inert in
      // production; the source-only testing assembly arms it to cut here, and
      // the corrupt partition then stays exactly as it was.
      await this.boundaries.checkpoint("replica.quarantine");
    } catch (error) {
      // IndexedDB auto-commits a transaction with no pending request, so a
      // failure after the deletions must roll them back explicitly.
      await abortTransaction(transaction);
      throw error;
    }
    await commitTransaction(transaction);
    return true;
  }

  /**
   * Validate one stored partition completely, and quarantine it if it cannot
   * produce the value it claims to.
   *
   * Both halves run before the caller can hold anything observable: the
   * manifest first, because a manifest that contradicts itself cannot even name
   * a walk, and then every node reachable from its four roots. Only a partition
   * that survives both is handed to `dbFromRecord`, so a walk that stops
   * half-way yields no `Db` at all rather than one over the datoms it did
   * manage to read.
   */
  private async validated(
    record: unknown,
    identity: ReplicationIdentity,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
    fingerprint?: string,
  ): Promise<ReplicaRestoreOutcome<CommittedRecord>> {
    const partition = replicaPartitionKey(identity);
    const expect = replicaManifestFingerprint(record);
    // The generations guarding this partition as they stood when the record was
    // read. Validation takes as long as reading the replica, and a clear or an
    // eviction in another handle sees no pin and no enrolled session yet — the
    // caller registers only once it has a value — so the walk has to carry the
    // fence itself rather than rely on being visible to maintenance.
    const lease = await this.leaseFor(identity);
    const quarantine = async (
      reason: Parameters<typeof replicaUnusable>[1],
      detail: string,
    ): Promise<ReplicaRestoreOutcome<CommittedRecord>> => {
      // The boundary between deciding to refuse and removing anything. Inert in
      // production; the source-only testing assembly parks here to let another
      // session install a replacement and prove the removal is conditional.
      await this.boundaries.checkpoint("replica.refused");
      const removed = await this.quarantinePartition(identity, {
        expect,
        lease,
        ...(fingerprint === undefined ? {} : { fingerprint }),
      });
      // A concurrent install replaced the manifest this restore refused, so
      // nothing was removed and nothing here describes what is stored now. The
      // caller selects again from scratch rather than acting on a stale
      // refusal.
      return removed
        ? replicaUnusable<CommittedRecord>(partition, reason, detail)
        : replicaAbsent<CommittedRecord>();
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
    // Everything above described the partition as it was when the record was
    // read, and the walk takes as long as reading the replica. Re-observe the
    // guarding generations before anything observable is built.
    //
    // Only a clear or an eviction removes content nodes, and only those bump a
    // generation, so this is exactly the difference that matters here: a
    // concurrent *install* leaves the manifest this walk validated fully intact
    // and its nodes in place — publishing it is the older of the old-or-new
    // complete values the caller is promised, not a mixture. A clear or an
    // eviction is what would leave a value over deleted nodes, and it surfaces
    // the ordinary typed fence error instead.
    // The boundary between a completed walk and the fence that lets its result
    // be published. Inert in production; the source-only testing assembly parks
    // here to run a clear against a replica that has just validated.
    await this.boundaries.checkpoint("replica.validated");
    await this.confirmGuardingGenerations(lease, identity);
    return replicaRestored(manifest.success);
  }

  /**
   * The publish fence.
   *
   * Reading a partition and acting on it are never one atomic step: a walk
   * takes as long as reading the replica, and a staged snapshot outlives the
   * connection that began it. Destructive maintenance in another handle sees
   * neither — a restore holds no pin until its caller has a value, and staging
   * is not a participant — so every path states the same invariant instead:
   *
   *   Nothing derived from an earlier read of a partition may become
   *   observable or durable until, in one IndexedDB transaction at the moment
   *   it becomes load-bearing, the derivation re-confirms both the durable
   *   generations guarding that partition and the committed state it assumed.
   *
   * The generations are what a clear or an eviction moves, so re-observing
   * them is what distinguishes "the value I validated is still mine to
   * publish" from "its nodes were deleted while I was reading them". The
   * committed state is what an ordinary install moves, and each path names the
   * part of it that its own derivation depended on:
   *
   *   - a restored replica re-confirms the generations here, in the one place
   *     every restore path funnels through, before it can be handed back;
   *   - a quarantine re-confirms the exact manifest it refused, so it never
   *     withdraws a replacement it did not examine;
   *   - a snapshot start re-confirms that the base its staging recorded is
   *     still committed, and rebases when it is not;
   *   - a snapshot commit and a change apply re-confirm their base revision
   *     inside the very transaction that installs.
   */
  private async confirmGuardingGenerations(
    lease: ReplicaLease,
    identity: ReplicationIdentity,
  ): Promise<void> {
    const transaction = this.database.transaction(GENERATIONS, "readonly");
    await enforceFence(transaction, replicaFence(lease, identity));
    await transactionDone(transaction);
  }

  /** Remove one stale exact binding without touching its shared partition. */
  private async unbindCredential(fingerprint: string): Promise<void> {
    const transaction = this.database.transaction(CREDENTIAL_BINDINGS, "readwrite");
    transaction.objectStore(CREDENTIAL_BINDINGS).delete(fingerprint);
    await commitTransaction(transaction);
  }

  /**
   * Cold restore of one partition, with the full integrity walk.
   *
   * The outcome is ordinary data: `absent` when nothing is stored for this
   * selection, `replacement-required` when the stored partition was corrupt and
   * has been quarantined, `update-required` when it was intact but disagrees
   * with the installed client catalog. Only `restored` carries a `Db`.
   */
  async restoreOutcome(
    identity: ReplicationIdentity,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<ReplicaRestoreOutcome<RestoredReplica>> {
    this.assertScopeLive(replicaScopeOf(identity));
    const record = await this.committed(identity);
    if (record === undefined) return replicaAbsent();
    // A record filed under this partition whose identity differs outside the
    // partition key selects nothing: it is another value, not a damaged one.
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
      db: dbFromRecord(this.database, validated.replica, readCompatibilityHash),
      revision: validated.replica.revision,
    });
  }

  /**
   * The value {@link IndexedDbReplicaStorage.restoreOutcome} restored, for a
   * caller that has nothing different to do about a refusal. A refused
   * partition has already been quarantined either way.
   */
  async restore(
    identity: ReplicationIdentity,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<RestoredReplica | undefined> {
    return restoredReplica(
      await this.restoreOutcome(identity, attributes, readCompatibilityHash),
    );
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
    // The candidate nominated one exact revision and the response confirmed
    // that revision; a manifest that moved underneath is a concurrent install,
    // not damage, and this path simply fails closed.
    if (validated.replica.revision !== candidate.revision) return replicaAbsent();
    return replicaRestored({
      identity: candidate.identity,
      db: dbFromRecord(this.database, validated.replica, readCompatibilityHash),
      revision: validated.replica.revision,
    });
  }

  /** The value {@link IndexedDbReplicaStorage.restoreCandidateOutcome} restored. */
  async restoreConfirmedCandidate(
    candidate: ReplicaCacheCandidate,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<BoundRestoredReplica | undefined> {
    return restoredReplica(
      await this.restoreCandidateOutcome(candidate, attributes, readCompatibilityHash),
    );
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
    const scopeKey = this.assertScopeLive(replicaScopeOf(binding.identity));
    const databaseKey = replicaDatabaseKey(replicaDatabaseScopeOf(binding.identity));
    const transaction = this.database.transaction(
      [CREDENTIAL_BINDINGS, CACHE_CANDIDATES, ROUTE_SLOTS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      // This is the only path that carries a server-confirmed identity, so it
      // is also the only path that may record a scope as confirmed. A clear
      // request naming a scope no such response ever produced deletes nothing.
      const generations = transaction.objectStore(GENERATIONS);
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
        } catch (error) {
          await abortTransaction(transaction);
          throw error;
        }
      }
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
          // A re-keyed slot invalidates every other scope's confirmation of
          // this path text, so only the confirming scope survives it.
          replicaScopes: withConfirmedScope(
            existingRoute?.slot === binding.route.slot
              ? existingRoute.replicaScopes
              : undefined,
            scopeKey,
          ),
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
      // The binding selects a partition that now holds another value; drop the
      // stale selector without touching the partition it pointed at.
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
      db: dbFromRecord(this.database, validated.replica, readCompatibilityHash),
      revision: validated.replica.revision,
    });
  }

  /** The value {@link IndexedDbReplicaStorage.restoreBoundOutcome} restored. */
  async restoreBound(
    fingerprint: string,
    attributes: readonly AttributeSpec[],
    readCompatibilityHash: ReadCompatibilityHash,
  ): Promise<BoundRestoredReplica | undefined> {
    return restoredReplica(
      await this.restoreBoundOutcome(fingerprint, attributes, readCompatibilityHash),
    );
  }

  /** Reset abandons only incomplete staging; a same-identity committed value survives. */
  async resetStaging(
    identity: ReplicationIdentity,
    options: ReplicaInstallOptions = {},
  ): Promise<void> {
    this.assertScopeLive(replicaScopeOf(identity));
    const fence = replicaFence(options.lease, identity);
    const partition = replicaPartitionKey(identity);
    const transaction = this.database.transaction(
      fence === undefined
        ? [STAGING, STAGING_CHUNKS]
        : [STAGING, STAGING_CHUNKS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      await enforceFence(transaction, fence);
      transaction.objectStore(STAGING).delete(partition);
      transaction.objectStore(STAGING_CHUNKS).delete(chunkRange(partition));
      await commitTransaction(transaction);
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
      fence === undefined
        ? [COMMITTED, STAGING, STAGING_CHUNKS]
        : [COMMITTED, STAGING, STAGING_CHUNKS, GENERATIONS],
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
      // The publish fence again, for the one derivation that outlives its
      // connection. A snapshot identity is a deterministic function of the
      // identity and the revision, so a reconnect restarts the very same
      // snapshot and this fast path resumes the staging in place — but that
      // staging recorded a base revision read at some earlier moment, and
      // resuming it is only sound while that base is still the committed one.
      // A quarantine, or any other change of the committed value, in between
      // leaves a base `commitSnapshot` can never satisfy, stranding the
      // partition on every following attempt. Re-confirming it here rebases
      // instead.
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
      fence === undefined
        ? [STAGING, STAGING_CHUNKS]
        : [STAGING, STAGING_CHUNKS, GENERATIONS],
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
        } satisfies StagingChunkRecord);
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
    this.assertScopeLive(replicaScopeOf(frame.identity));
    const fence = replicaFence(options.lease, frame.identity);
    const [staged, prior] = await Promise.all([
      this.stagedState(frame),
      this.priorManifest(frame.identity),
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
      fence,
    );
    options.signal?.throwIfAborted();
    const transaction = this.database.transaction(
      fence === undefined
        ? [COMMITTED, COMMITTED_HEADS, STAGING, STAGING_CHUNKS]
        : [COMMITTED, COMMITTED_HEADS, STAGING, STAGING_CHUNKS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      await enforceFence(transaction, fence);
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
    this.assertScopeLive(replicaScopeOf(frame.identity));
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
      fence,
    );
    options.signal?.throwIfAborted();
    const write = this.database.transaction(
      fence === undefined
        ? [COMMITTED, COMMITTED_HEADS]
        : [COMMITTED, COMMITTED_HEADS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(write, options.signal);
    try {
      await enforceFence(write, fence);
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
