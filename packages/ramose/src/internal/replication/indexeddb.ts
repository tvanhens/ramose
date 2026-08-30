/** Native IndexedDB persistence for one complete logical client replica. */

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
  REPLICA_STORAGE_VERSION,
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
  unreachableNodeHashes,
  type ReplicaGcOutcome,
} from "./replica-gc.ts";
import {
  identityInDatabase,
  identityInScope,
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
 * The version that added #475's mutation queue store families, and the ones
 * that added their global-identity indexes.
 *
 * Versions 7 and 8 existed only inside this unreleased change.
 *
 * Opening at an unchanged version never fires `upgradeneeded`, so a database
 * an earlier build of this same unreleased format already created would keep
 * the older index shape and fail at the first allocating enqueue. The bump is
 * what makes {@link createMutationStores} run again and reconcile them.
 */
/**
 * Version 9 moved global invocation ownership onto the receipt store.
 *
 * The outbox's own `by-invocation` index only holds while the row does, and an
 * acknowledgement removes the row — so after one, the same globally unique
 * invocation id could be queued again for a *sibling* database and execute a
 * second time. Receipts outlive their rows, so they are where that ownership
 * belongs.
 */
const MUTATION_INDEX_DATABASE_VERSION = 9;
/**
 * Version 10 added #476's optimistic-layer family.
 *
 * A new store needs an `upgradeneeded` transaction to exist at all, and the
 * bump is also what makes {@link createMutationStores} run again over a
 * database an earlier build of this unreleased format already created. Kept as
 * a named boundary the migration below reasons about: an origin at 10 holds
 * queued invocations and durable fence state, so the version-3 reset has to be
 * narrower than the version-2 one that predates both.
 */
const OPTIMISTIC_LAYER_DATABASE_VERSION = 10;
/**
 * Version 11 is replica storage version 3: the persisted sealed-`EntityId`
 * binding (#477).
 *
 * A manifest written before it has no binding, so a row it holds could be read
 * and never addressed — which is exactly what carrying the handle exists to
 * prevent. There is no gradual adapter, so those manifests are reset, and the
 * bump is what makes an `upgradeneeded` transaction exist to do it: an origin
 * already at version 10 fires no upgrade at all, so a storage-version constant
 * alone would have left the old records in place and unreadable.
 */
const MANIFEST_V3_DATABASE_VERSION = OPTIMISTIC_LAYER_DATABASE_VERSION + 1;
/**
 * The version this build opens at. Exported so a test that inspects the raw
 * database cannot pin a stale number and start failing on the next bump.
 */
export const REPLICA_DATABASE_VERSION = MANIFEST_V3_DATABASE_VERSION;
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
 * The families a *manifest-format* reset clears: everything that describes or
 * selects one stored committed value.
 *
 * {@link GENERATIONS} is deliberately absent. It holds lifecycle fence state —
 * the generation a scope or a stable database is currently at — which a
 * replica reset has no business moving: clearing it would recreate every
 * generation at 1, silently unfencing work a completed `clearLocalData()` had
 * already fenced off. The mutation families are absent for the same reason
 * they are absent from {@link PARTITION_KEYED_FAMILIES}: unsubmitted work does
 * not expire because the committed value's storage shape changed.
 */
const REPLICA_VALUE_FAMILIES = REPLICA_STORE_FAMILIES.filter(
  (family) => family !== GENERATIONS,
);

/**
 * The sweep-bookkeeping prefix storage version 2 wrote.
 *
 * Sweep records are keyed by the replica partition key, which moves with the
 * manifest version — so once version 3's partitions replace them, the version-2
 * rows name partitions that no longer exist and nothing will ever read or
 * delete them again. They are pure garbage-collection bookkeeping, never fence
 * state, so the migration removes exactly this prefix and nothing else in
 * {@link GENERATIONS}.
 */
const STORAGE_V2_SWEEP_PREFIX = "ramose-replica-sweep-v2:";

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
export {
  ReplicaQuotaExhaustedError,
  replicaSweepKey,
  type ReplicaGcOutcome,
} from "./replica-gc.ts";

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
  /** The chunk's sealed-handle bindings, staged with the datoms they name. */
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
  /**
   * `partition` records are the sweep generation reachability GC bumps. They
   * are guarded by the restore publish fence alone, never by an install, so a
   * sweep of superseded roots leaves every live session running.
   */
  readonly kind: "scope" | "database" | "partition";
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

/**
 * How many records of each family this handle has actually written.
 *
 * These are plain counters on the real write paths — every increment sits
 * immediately after the IndexedDB transaction that performed the write
 * committed, so a number here is a write that really happened. Nothing reads
 * them to make a decision; they exist so the scale probe (#474 slice 10) can
 * state node and manifest write amplification from the production adapter
 * rather than from an estimate, and so slice 11 can state what a GC pass
 * rewrote.
 */
export type ReplicaWriteCounts = {
  /** Content nodes stored under their own address. */
  readonly nodes: number;
  /** Committed manifests installed. */
  readonly manifests: number;
  /** Committed head sidecars installed. */
  readonly heads: number;
  /** Staging records opened for a snapshot. */
  readonly staging: number;
  /** Snapshot chunks durably staged. */
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
  /**
   * The sealed `EntityId` → partition-local eid binding for this value.
   *
   * The whole point of carrying the handle on the wire: a row read out of
   * {@link RestoredReplica.db} is numbered by a local allocator, and this is
   * the only thing that can turn that number back into the opaque identity a
   * mutation may target — or resolve a handle an optimistic layer names.
   */
  readonly handles: ReadonlyMap<string, number>;
  /**
   * Release this value's claim on the nodes it reads.
   *
   * A `Db` holds its roots and its node store directly, so a reachability
   * sweep that reclaimed those roots would turn it into a value that throws
   * mid-query. Every value handed out here is therefore already retained when
   * the caller receives it — taken synchronously, before the transaction that
   * cleared it to be handed out, which is the only ordering under which the
   * publish fence and a sweep's own synchronous re-check compose.
   *
   * The caller owns exactly one release per value and must call it when it
   * drops the value; a leaked release pins that value's nodes for the life of
   * the storage handle. Closing the handle releases whatever is left.
   */
  readonly release: () => void;
};

/** A validated manifest and the retention taken for it before its fence. */
type RetainedRecord = {
  readonly record: CommittedRecord;
  readonly release: () => void;
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
  /** Optimistic layers (#476) removed in that same transaction. */
  readonly layers: number;
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
  /**
   * Root sets an in-process holder still reads, by partition. A sweep keeps
   * every node reachable from one of these, which is how a published `Db`
   * survives a sweep that reclaims the roots it superseded — and how a stale
   * value published over a quarantined partition keeps working.
   */
  readonly retained: Map<string, Map<number, readonly string[]>>;
  /**
   * Partitions with a materialization in flight. A sweep skips them entirely:
   * their fresh nodes have no roots yet, so no reachability statement can
   * describe them.
   */
  readonly materializing: Map<string, number>;
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

/** The four index root addresses of one committed value. */
const rootHashes = (roots: Roots): readonly string[] =>
  ALL_INDEXES.map((index) => rootFor(roots, index).hash);

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

/**
 * An identifier for one act of installing, not for the value installed.
 *
 * Sixteen random bytes rather than `crypto.randomUUID`, which exists only in a
 * secure context; `getRandomValues` is available wherever this adapter can
 * run. Nothing authorizes anything with it and it never leaves the device: its
 * only job is to make two installs of one revision distinguishable to the
 * quarantine CAS (see {@link replicaManifestFingerprint}).
 */
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
    datoms: Object.freeze([...committed.datoms]),
    attributes: Object.freeze(specs),
    entityIds: Object.freeze([...entities]),
    // Exactly the entities this value names, in the order they were numbered,
    // so the stored binding and the stored id map describe one set.
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

/**
 * The sealed-handle binding one stored manifest describes.
 *
 * Composed from the two stored maps rather than persisted a third time: the
 * manifest binds wire identity → sealed handle and wire identity → local eid,
 * and the value every caller wants is their join.
 */
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
  /** Filled with every address the walk reached, for a caller that needs the set. */
  reached?: Set<string>,
): Promise<ReplicaIntegrityFailure | undefined> => {
  // A bulk build slices one strictly sorted datom list into disjoint leaves and
  // groups those into disjoint directories, and the index tag is part of every
  // body, so no two reachable nodes of one committed value can share an
  // address. A repeat is therefore not sharing to deduplicate — it is a link
  // into a subtree that already has a parent, which also bounds the walk.
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

/**
 * Reach every node one set of roots depends on, without validating any of it.
 *
 * A sweep asks a different question than a restore: not "is this value intact"
 * but "which addresses must survive". It does not classify damage — that is the
 * restore walk's job, and the only path that can act on it — but it must still
 * refuse to *believe* a record it cannot authenticate, because a body believed
 * wrongly under-reports children and would turn intact descendants into
 * garbage.
 *
 * The content address is exactly the check that makes belief safe, and it is
 * sufficient on its own. A body that hashes to the address it is filed under is
 * the node that address names, so the children it lists are that node's real
 * children; a body that does not — a valid leaf stored under a directory's
 * address, a half-written record, anything at all — is refused, and the walk is
 * incomplete. An incomplete walk sweeps nothing, so no amount of damage can
 * become deletion.
 */
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

/**
 * The compatibility hash a stored manifest claims, read defensively.
 *
 * A sweep has no client catalog to compare against and does not need one: it
 * decides what is reachable, not what this client may read. Passing the
 * record's own claim makes that one comparison inside
 * {@link validateReplicaManifest} tautological and leaves every other check —
 * the ones that decide whether these roots describe a real value — in force.
 */
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

/** One partition as the survey found it, before anything is decided about it. */
type SurveyedPartition = {
  /** Every content address stored under this partition. */
  readonly hashes: readonly string[];
  /** The committed manifest as of the survey; absent manifests fingerprint too. */
  readonly fingerprint: string;
  /** The stored manifest record, or `undefined` when none is stored. */
  readonly record: unknown;
};

/** Distinguishes one retention from another without leaking the roots it holds. */
let retentionToken = 0;

/**
 * This attempt read a record that is no longer the stored one, or walked nodes
 * a sweep has since reclaimed. Either way it describes the attempt, not the
 * partition — so it is not a restore outcome and never reaches a caller; the
 * record is read again and walked again instead.
 */
const RECORD_MOVED = Symbol("replica.record-moved");

/**
 * How many times a restore re-reads and re-walks a partition that moved under
 * it. Installs and sweeps are bounded events and each attempt is a whole walk,
 * so a small constant both keeps ordinary concurrency invisible and stops a
 * pathologically busy neighbour from making a restore unbounded.
 */
const REPLICA_SWEEP_RESTORE_ATTEMPTS = 3;

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
  /** Counters over this handle's real writes; see {@link ReplicaWriteCounts}. */
  private readonly meter = new WriteMeter();

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
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      // #475's mutation families. Version 6 and earlier could not queue an
      // invocation, and version 7 only ever existed inside this unreleased
      // change — so anything already there predates the global identity
      // indexes and is discarded before they are created, rather than aborting
      // the upgrade on a row that was legal under the older shape. Indexes are
      // reconciled here rather than assumed.
      if (request.transaction !== null) {
        createMutationStores(
          database,
          request.transaction,
          oldVersion > 0 && oldVersion < MUTATION_INDEX_DATABASE_VERSION,
        );
      }
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
      if (
        oldVersion > 0 && oldVersion < MANIFEST_V3_DATABASE_VERSION &&
        request.transaction !== null
      ) {
        // Storage version 3's own reset. A manifest written before it carries
        // no sealed-handle binding, so a row it holds could be read and never
        // addressed; there is no gradual adapter, so every record describing or
        // selecting a stored value goes, in the same upgrade transaction.
        //
        // Separate from the version-2 branch above rather than folded into it,
        // and narrower: that one predates the mutation queue entirely and may
        // clear the whole format, while this one runs against origins holding
        // queued invocations and durable fence state. Neither the mutation
        // families nor the generation records may be touched, and the lifecycle
        // key space is versioned independently precisely so this reset cannot
        // re-key them either.
        const upgrade = request.transaction;
        for (const store of REPLICA_VALUE_FAMILIES) upgrade.objectStore(store).clear();
        // The one thing in `GENERATIONS` that this reset does own: sweep
        // bookkeeping for partitions that no longer exist.
        upgrade.objectStore(GENERATIONS).delete(prefixRange(STORAGE_V2_SWEEP_PREFIX));
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

  /** Records this handle has written since it opened or last reset the meter. */
  writeCounts(): ReplicaWriteCounts {
    return this.meter.counts();
  }

  /** Start a fresh write measurement window. */
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
   * Keep every content node reachable from one value's roots alive.
   *
   * A `Db` holds its roots and its node store directly and stops depending on
   * the manifest the moment it exists, so a reachability sweep that reclaimed
   * superseded roots would turn a published value into one that throws
   * mid-query. A session therefore retains the roots of the value it currently
   * publishes; the returned callback releases them and is idempotent, and
   * closing this handle releases every retention it took.
   *
   * A value older than the one its holder currently publishes is deliberately
   * not retained. Superseded roots are where the garbage comes from — one
   * changed datom orphans most of a replica — so reclaiming them is the point,
   * and a holder that needs an older value to stay readable must say so.
   */
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

  /**
   * Mark one partition as materializing for the duration of an install.
   *
   * Nodes written before their manifest exists are reachable from nothing, so
   * no reachability statement can describe them. The mark is taken
   * synchronously before the first node transaction and released only after the
   * install transaction settles; a sweep reads it and creates its own
   * transaction in one synchronous block, so it either skips this partition or
   * is ordered before every node transaction this install goes on to create.
   *
   * Unlike a pin or a retention this is deliberately not released by
   * {@link IndexedDbReplicaStorage.close}. Closing an IndexedDB connection lets
   * the transactions it has already created run to completion, so a handle
   * closed mid-install still commits its manifest — and releasing the mark
   * there would let another handle's sweep slip between the last node write and
   * that commit. Only the install's own `finally` clears it.
   */
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
    // The sweep generations guarding exactly the partitions just deleted. They
    // are named after those partitions, so nothing would ever remove them once
    // the partitions are gone.
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
      layers: mutations.layers,
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
    // The sweep generations guarding exactly the partitions just deleted. They
    // are named after those partitions, so nothing would ever remove them once
    // the partitions are gone.
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

  /**
   * Reclaim every content node and staged snapshot nothing can reach.
   *
   * Reachability is partition-local: node records are keyed by
   * `[partition, hash]`, so no partition can keep another's node alive, and the
   * live root sets of one partition are its committed manifest's roots plus
   * every root set an in-process holder retained. A partition with a
   * materialization in flight is skipped outright, a partition whose manifest
   * moved under the pass is skipped by the fingerprint CAS, and a partition
   * whose reachability walk could not complete is skipped because damage must
   * never become deletion.
   *
   * Nothing here writes a manifest, a head, a credential binding, or a cache
   * candidate, so no install identifier can be dropped or minted by a sweep and
   * no selection changes. The #475 mutation families are not merely skipped but
   * structurally out of reach: no transaction below names those stores, so
   * IndexedDB itself would refuse a write to one. Content is re-fetchable; a
   * durable operation identity is not, and storage pressure is no reason to
   * discard work the user has not yet had acknowledged. A sweep that removed at least one node bumps that
   * partition's sweep generation, which is the record the restore publish fence
   * re-observes; live sessions do not lease it, so reclaiming the roots they
   * superseded leaves them running.
   *
   * Passing a scope restricts the pass to that server/principal realm.
   */
  async collectGarbage(
    options: { readonly scope?: ReplicaScope | undefined } = {},
  ): Promise<ReplicaGcOutcome> {
    let prefix: string | undefined;
    if (options.scope !== undefined) {
      this.assertScopeLive(options.scope);
      prefix = replicaScopePartitionPrefix(options.scope);
    }
    const survey = await this.surveyPartitions(prefix);
    let partitions = 0;
    let swept = 0;
    let skipped = 0;
    let nodes = 0;
    let retained = 0;
    let staging = 0;
    for (const [partition, hashes] of survey) {
      const scopeKey = replicaPartitionScopeKey(partition);
      // A scope this handle cleared is terminal for it: the handle may not read
      // it, and it certainly may not write a generation record into it.
      if (scopeKey !== undefined && this.clearedScopes.has(scopeKey)) continue;
      partitions++;
      // One manifest at a time. A committed record carries the whole logical
      // journal, so reading every partition's at once would put the entire
      // stored corpus in memory; the sweep needs no more than one.
      const stored = await this.surveyManifest(partition, hashes);
      const live = await this.liveNodeHashes(partition, stored);
      if (live === undefined) {
        skipped++;
        continue;
      }
      const garbage = unreachableNodeHashes(stored.hashes, live);
      // The boundary between computing what this partition may lose and acting
      // on it — the last point at which a manifest can move or a holder can
      // retain roots without the sweep noticing. Inert in production; the
      // source-only testing assembly parks here to prove both re-checks.
      await this.boundaries.checkpoint("replica.gc.planned");
      const outcome = await this.sweepPartition(partition, stored, garbage, live);
      if (outcome === undefined) {
        skipped++;
        continue;
      }
      retained += stored.hashes.length - outcome.nodes;
      nodes += outcome.nodes;
      staging += outcome.staging;
      if (outcome.nodes > 0 || outcome.staging > 0) swept++;
    }
    return Object.freeze({ partitions, swept, skipped, nodes, retained, staging });
  }

  /**
   * Every partition that holds a content node, a staged snapshot, or a
   * committed manifest, with the addresses stored under it.
   *
   * Only keys are read here. A committed record carries the whole logical
   * journal, so pulling every one of them into memory to find four root
   * addresses would cost more than the sweep saves; each manifest is read on
   * its own when its partition's turn comes.
   */
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

  /**
   * One partition's committed manifest as it stands right now.
   *
   * The fingerprint recorded here is what the sweep transaction re-confirms; an
   * absent manifest fingerprints too, so a partition that gains one mid-pass is
   * skipped exactly like one whose manifest was replaced. The record itself is
   * whatever structured clone returned and is read defensively — unreadable
   * roots make the partition unsweepable rather than empty.
   */
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

  /**
   * The addresses one partition must keep, or `undefined` when that cannot be
   * established — an unreadable manifest, or a walk that hit a node it could
   * not read or decode. An unknown live set sweeps nothing.
   */
  private async liveNodeHashes(
    partition: string,
    stored: SurveyedPartition,
  ): Promise<ReadonlySet<string> | undefined> {
    const live = new Set<string>();
    if (stored.record !== undefined) {
      // A content address authenticates a node: a body that hashes to the
      // address its parent filed it under is that node, so the children it
      // lists are the real ones. A manifest authenticates nothing — it is an
      // ordinary stored record, and its four roots are just hashes. Damage that
      // swapped one for another correctly stored node of the same index and
      // count would still pass every address check and hand the sweep a live
      // set describing some other value, which would then delete the current
      // one. The manifest therefore gets the full restore-strength validation,
      // ending in the digest fold that proves the walked trees are the ones
      // this manifest's own journal describes; nothing less separates a real
      // root from a plausible one.
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
    // Retained roots are values this process restored through that same walk or
    // materialized itself, so following them needs only the address check.
    const retained = this.retainedRoots(partition);
    if (retained.length > 0) {
      const walk = await reachableFromRoots(this.database, partition, retained);
      if (!walk.complete) return undefined;
      for (const hash of walk.reachable) live.add(hash);
    }
    return live;
  }

  /** Every root address an in-process holder currently retains for a partition. */
  private retainedRoots(partition: string): readonly string[] {
    const roots: string[] = [];
    for (const held of this.registry.retained.get(partition)?.values() ?? []) {
      roots.push(...held);
    }
    return roots;
  }

  /**
   * Remove one partition's unreachable nodes and impossible staging in a single
   * transaction, or nothing at all.
   *
   * The in-process checks and the transaction creation are one synchronous
   * block on purpose. Either this pass saw the materialization mark and left
   * the partition alone, or the install had not yet created a node transaction
   * — and IndexedDB serializes overlapping `readwrite` transactions in creation
   * order, so every node it writes afterwards lands after these deletes rather
   * than being erased by them.
   *
   * Retention is re-read in the same block, because a restore that validated an
   * older manifest publishes after this pass computed its live set: the session
   * retains those roots synchronously as it publishes, and the manifest CAS
   * below cannot see it, since the manifest never moved. A root that has
   * appeared since and is not already live is exactly that case, so the
   * partition is skipped and the next pass computes a live set that includes
   * it. A root that has *gone* is harmless — the live set was merely more
   * generous than it needed to be — so it does not skip anything.
   */
  private async sweepPartition(
    partition: string,
    stored: SurveyedPartition,
    garbage: readonly string[],
    live: ReadonlySet<string>,
  ): Promise<{ readonly nodes: number; readonly staging: number } | undefined> {
    if (this.registry.materializing.has(partition)) return undefined;
    if (this.retainedRoots(partition).some((hash) => !live.has(hash))) return undefined;
    const transaction = this.database.transaction(
      [COMMITTED, NODES, STAGING, STAGING_CHUNKS, GENERATIONS],
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
      // The manifest the live set was computed against must still be the stored
      // one, install identifier included, or this pass is describing a value it
      // never examined.
      if (replicaManifestFingerprint(current) !== stored.fingerprint) {
        await abortTransaction(transaction);
        return undefined;
      }
      sweptStaging = stagingIsSweepable(staged, storedRevision(current));
      if (garbage.length === 0 && !sweptStaging) {
        await transactionDone(transaction);
        return { nodes: 0, staging: 0 };
      }
      const nodes = transaction.objectStore(NODES);
      for (const hash of garbage) nodes.delete([partition, hash]);
      if (sweptStaging) {
        transaction.objectStore(STAGING).delete(partition);
        transaction.objectStore(STAGING_CHUNKS).delete(chunkRange(partition));
      }
      if (garbage.length > 0) {
        transaction.objectStore(GENERATIONS).put({
          key: sweepKey,
          kind: "partition",
          // A quarantined partition has no manifest left to name its identity,
          // so the owning scope is recovered from the partition key itself.
          scope: replicaPartitionScopeKey(partition) ?? "",
          generation: (sweep?.generation ?? 0) + 1,
          confirmedAt: sweep?.confirmedAt ?? Date.now(),
          fencedAt: Date.now(),
        } satisfies GenerationRecord);
      }
      // The last boundary before this sweep becomes durable. Inert in
      // production; the source-only testing assembly arms it to cut here, and
      // the partition then stays exactly as it was.
      await this.boundaries.checkpoint("replica.sweep");
    } catch (error) {
      await abortTransaction(transaction);
      throw error;
    }
    await commitTransaction(transaction);
    return { nodes: garbage.length, staging: sweptStaging ? 1 : 0 };
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
   *
   * Two endings say nothing about the partition and only about the attempt: a
   * sweep landing in the walk's window, and a refusal whose withdrawal lost its
   * CAS because the stored manifest had already moved on. Both are the ordinary
   * shape of a concurrent install followed by a reclaim of the roots it
   * superseded — the partition commonly holds exactly the value the caller
   * asked for — and reporting an absence would strand an offline restore that
   * has no other way to obtain it. The record is therefore read again and
   * walked again, a bounded number of times, before anything is concluded.
   */
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
    // The partition kept moving under every attempt. Nothing is damaged and
    // nothing was withdrawn, and something is certainly stored — so this is
    // reported as contention rather than as an absence the caller would read
    // as an empty partition worth re-snapshotting from scratch.
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
    // The generations guarding this partition as they stood when the record was
    // read. Validation takes as long as reading the replica, and a clear or an
    // eviction in another handle sees no pin and no enrolled session yet — the
    // caller registers only once it has a value — so the walk has to carry the
    // fence itself rather than rely on being visible to maintenance.
    const lease = await this.leaseFor(identity);
    // Reachability GC is the second writer that deletes content nodes, and it
    // deliberately moves no scope or database generation, so the walk records
    // this partition's sweep generation as well and re-reads it before
    // anything derived from the walk can be published.
    const sweep = await this.sweepGeneration(partition);
    const quarantine = async (
      reason: Parameters<typeof replicaUnusable>[1],
      detail: string,
    ): Promise<ReplicaRestoreOutcome<RetainedRecord> | typeof RECORD_MOVED> => {
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
      // nothing was removed and this refusal describes nothing that is stored.
      // It is the same situation as a sweep landing under the walk — the
      // attempt is stale, not the partition — and a sweep that reclaimed the
      // refused manifest's now-superseded nodes is exactly how a healthy
      // partition reaches this branch. Read the record again and walk that.
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
    // Retain before the fence transaction exists, synchronously, with no await
    // in between — this is what makes the fence and the sweep's own
    // synchronous re-check compose rather than pass each other.
    //
    // A sweep decides in one synchronous block: read the retentions, then
    // create its transaction. So exactly one of two orders can hold. If the
    // sweep's block ran before this line, its transaction was created before
    // the fence's, IndexedDB orders the generation bump ahead of the fence's
    // read, and the fence sees it and refuses. If it runs after, it sees this
    // retention covering the very roots it was about to reclaim and skips the
    // partition. There is no third interleaving: without this line the sweep
    // could plan while nothing was retained and still transact after a fence
    // that had already read a generation of zero, and the published value
    // would be left reading nodes the sweep then deleted.
    //
    // The retention outlives this method on the success path and belongs to
    // whoever receives the value; every failure path below releases it here.
    const retention = this.retainRoots(identity, manifest.success.roots);
    if (!await this.confirmGuardingGenerations(lease, identity, sweep)) {
      // A sweep removed nodes from this partition while the walk was running.
      // Nothing is damaged and nothing was withdrawn — the reclaimed roots were
      // superseded by an install this walk did not see — but the manifest this
      // walk read is no longer safe to construct a `Db` over. The caller reads
      // the stored record again and walks it again.
      retention();
      return RECORD_MOVED;
    }
    return replicaRestored({ record: manifest.success, release: retention });
  }

  /**
   * Re-confirm, inside the transaction that installs, that no sweep has
   * reclaimed nodes from this partition since materialization began.
   *
   * The realm-local materialization mark keeps an in-process sweep away from
   * an install's fresh nodes, so in one realm this value cannot move inside
   * that window and no live session is ever fenced by it. Another tab has no
   * view of that mark, and its sweep would see nodes reachable from nothing —
   * because the manifest naming them is not committed yet — and could delete
   * them while the base-revision CAS still passes. The sweep generation is the
   * durable trace such a sweep leaves, so re-reading it here turns that into a
   * refused install rather than a manifest committed over deleted nodes. #478's
   * all-tab barrier replaces the mark; this record is what makes the interval
   * safe until it does.
   */
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

  /** The sweep generation guarding one partition; absent reads as zero. */
  private async sweepGeneration(partition: string): Promise<number> {
    const transaction = this.database.transaction(GENERATIONS, "readonly");
    const record = await requestResult<GenerationRecord | undefined>(
      transaction.objectStore(GENERATIONS).get(replicaSweepKey(partition)),
    );
    await transactionDone(transaction);
    return record?.generation ?? 0;
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
   *     inside the very transaction that installs;
   *   - a restored replica also re-confirms the partition's sweep generation,
   *     because reachability GC deletes nodes without moving a manifest or a
   *     scope/database generation. Installs deliberately do not lease that
   *     record: a sweep may reclaim the roots a running session superseded,
   *     and fencing the session for it would defeat the whole pass.
   *
   * Returns false when the sweep generation moved. A lost scope or database
   * generation is still the ordinary thrown fence error, because that means the
   * realm itself was cleared or evicted out from under the caller.
   */
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

  /**
   * Remove one exact binding without touching its shared partition.
   *
   * Two callers, one rule: a binding is a *selector*, and a selector that the
   * client has direct evidence is no longer good must stop selecting. It is
   * stale when the partition it named now holds another value, and it is
   * withdrawn when the server has refused the credential it was minted for —
   * otherwise a later offline start would restore and publish the revoked
   * principal's rows through a binding the server has already rejected.
   *
   * The partition itself is untouched: whose data it is has not changed, and
   * deleting it is `clearLocalData()`'s decision, not this one's.
   */
  async unbindCredential(fingerprint: string): Promise<void> {
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
      db: dbFromRecord(this.database, validated.replica.record, readCompatibilityHash),
      revision: validated.replica.record.revision,
      handles: recordHandles(validated.replica.record),
      release: validated.replica.release,
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
    if (validated.replica.record.revision !== candidate.revision) {
      validated.replica.release();
      return replicaAbsent();
    }
    return replicaRestored({
      identity: candidate.identity,
      db: dbFromRecord(this.database, validated.replica.record, readCompatibilityHash),
      revision: validated.replica.record.revision,
      handles: recordHandles(validated.replica.record),
      release: validated.replica.release,
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
      db: dbFromRecord(this.database, validated.replica.record, readCompatibilityHash),
      revision: validated.replica.record.revision,
      handles: recordHandles(validated.replica.record),
      release: validated.replica.release,
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
        // A chunk staged before this storage version carries none, so the
        // replay leaves the entities it names unbound and the commit refuses
        // rather than installing a value with no mutation targets. The version
        // bump drops those records anyway; this is the belt-and-braces path.
        handles: chunk.handles ?? [],
      });
    }
    return { state: transition(state, frame), baseRevision: staging.baseRevision };
  }

  /**
   * Run one install, and if native storage is exhausted reclaim once and try
   * again exactly once.
   *
   * The pass runs between the two attempts — after the first released its
   * materialization mark, before the retry takes one — so the partition that
   * needs the space is not the one partition a sweep skips, and the failed
   * attempt's own nodes are reachable from nothing and are reclaimed with the
   * superseded roots. The pass is unscoped because storage pressure belongs to
   * the origin, not to one principal, and it can still only delete what is
   * provably unreachable: no active or root data is ever evicted to make room.
   *
   * A second exhaustion is a typed outcome, not another pass. Nothing was
   * installed — materialization writes only content nodes and the install is
   * one atomic transaction — so the previously committed manifest is exactly as
   * it was and the old-or-new guarantee holds.
   */
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
        // An aborted install has no business reclaiming or retrying: the
        // session that asked for it is gone.
        signal?.throwIfAborted();
        // The boundary between classifying an exhaustion and reclaiming for it.
        await this.boundaries.checkpoint("replica.quota");
        try {
          reclaimedNodes = (await this.collectGarbage()).nodes;
        } catch (sweepError) {
          // Storage so full that even the sweep's own bookkeeping cannot be
          // written. The install still gets its one retry — it may need less
          // room than the sweep did — and the caller still hears about the
          // exhaustion rather than about the pass. Anything else is a real
          // fault and must not be hidden behind a quota outcome.
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
    return this.installWithQuotaRecovery(
      replicaPartitionKey(frame.identity),
      options.signal,
      () => this.commitSnapshotOnce(frame, attributes, options),
    );
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
    // Held across the build and the install: until the manifest exists, the
    // nodes below are reachable from nothing and a sweep must not judge them.
    const partition = replicaPartitionKey(frame.identity);
    const materializing = this.markMaterializing(partition);
    try {
      // What the mark cannot cover: a sweep in another realm. Recorded here and
      // re-confirmed inside the install transaction.
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
    // The boundary between having written the nodes and opening the
    // transaction that names them — the window in which they are reachable
    // from nothing. Inert in production; the source-only testing assembly
    // parks here to leave the durable trace another tab's sweep would.
    await this.boundaries.checkpoint("replica.installing");
    // The generation store is always in scope: even an unfenced install has to
    // re-confirm that no sweep reclaimed the nodes it has just written.
    const transaction = this.database.transaction(
      [COMMITTED, COMMITTED_HEADS, STAGING, STAGING_CHUNKS, GENERATIONS],
      "readwrite",
    );
    const removeAbort = abortWithSignal(transaction, options.signal);
    try {
      await enforceFence(transaction, fence);
      await this.confirmNoSweep(transaction, partition, sweep);
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
        (currentCommitted?.revision ?? null) !== baseRevision
      ) {
        await abortTransaction(transaction);
        return undefined;
      }
      transaction.objectStore(COMMITTED).put(built.record);
      transaction.objectStore(COMMITTED_HEADS).put(committedHead(built.record));
      transaction.objectStore(STAGING).delete(built.record.partition);
      transaction.objectStore(STAGING_CHUNKS).delete(chunkRange(built.record.partition));
      // The last boundary before an install becomes durable. Inert in
      // production; the source-only testing assembly arms it to fail here with
      // a real native error, which is how bounded quota recovery is exercised
      // without filling the origin's real storage.
      await this.boundaries.checkpoint("replica.install");
      await commitTransaction(transaction);
      this.meter.manifests++;
      this.meter.heads++;
    } catch (error) {
      // IndexedDB auto-commits a transaction with no pending request, so a
      // failure between the puts above and the commit — an exhausted quota, or
      // an armed boundary standing in for one — must roll them back explicitly
      // or a half-install would become durable.
      await abortTransaction(transaction);
      throw error;
    } finally {
      removeAbort();
    }
    // Retained before this method returns, so the value is never momentarily
    // unclaimed: an install that supersedes it immediately afterwards makes
    // these roots garbage, and the caller has not had a chance to retain yet.
    return {
      db: built.db,
      revision: built.record.revision,
      handles: recordHandles(built.record),
      release: this.retainRoots(frame.identity, built.record.roots),
    };
  }

  async applyChange(
    frame: Change,
    options: ReplicaInstallOptions = {},
  ): Promise<RestoredReplica | undefined> {
    this.assertScopeLive(replicaScopeOf(frame.identity));
    return this.installWithQuotaRecovery(
      replicaPartitionKey(frame.identity),
      options.signal,
      () => this.applyChangeOnce(frame, options),
    );
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
        datoms: prior.datoms,
        handles: new Map(prior.entityHandles),
      },
      closed: false,
    }, frame);
    if (state.committed === undefined || state.committed.revision === prior.revision) {
      // A duplicate or out-of-order `Change`: the frame names a revision this
      // partition already holds, or one that does not follow from it, so there
      // is nothing to install and the caller gets the value that is already
      // committed.
      //
      // This is the one `dbFromRecord` call site not preceded by `validated()`,
      // and #474 slice 10 decided to leave it that way rather than add a
      // consistency check here. A full walk is the only check that would mean
      // anything — a partial one would let exactly the damage it skipped
      // through — and it costs a complete read of the replica: at 100k datoms
      // the measured walk is the same work as the whole cold restore, and a
      // reconnect that replays a handful of frames would pay it once per
      // duplicate. Nor does the walk have a cold record to catch here: a
      // session only reaches `applyChange` after it restored this partition
      // through `validated()` or installed a snapshot into it, so the manifest
      // read above is that one or a strictly later install some live client
      // materialized — never a record taken off disk unverified. Damage that
      // appears afterwards is found by the next restore's walk, which is where
      // every other stored-node failure is found too.
      //
      // This value is derived from a manifest read a moment ago rather than
      // from one this call installed, so it is retained here for the same
      // reason a restore retains before its fence: a sweep that planned while
      // nothing held these roots must find them claimed before it transacts.
      return {
        db: dbFromRecord(this.database, prior, frame.identity.readCompatibilityHash),
        revision: prior.revision,
        handles: recordHandles(prior),
        release: this.retainRoots(frame.identity, prior.roots),
      };
    }
    // Held across the build and the install, for the same reason a snapshot
    // commit holds one: the rebuilt nodes are reachable from nothing until the
    // manifest naming them is committed.
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
    try {
      await enforceFence(write, fence);
      await this.confirmNoSweep(write, partition, sweep);
      const current = await requestResult<CommittedRecord | undefined>(
        write.objectStore(COMMITTED).get(partition),
      );
      if (current?.revision !== prior.revision) {
        await abortTransaction(write);
        return undefined;
      }
      write.objectStore(COMMITTED).put(built.record);
      write.objectStore(COMMITTED_HEADS).put(committedHead(built.record));
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
    // Retained before this method returns, so the value is never momentarily
    // unclaimed: an install that supersedes it immediately afterwards makes
    // these roots garbage, and the caller has not had a chance to retain yet.
    return {
      db: built.db,
      revision: built.record.revision,
      handles: recordHandles(built.record),
      release: this.retainRoots(frame.identity, built.record.roots),
    };
  }
}
