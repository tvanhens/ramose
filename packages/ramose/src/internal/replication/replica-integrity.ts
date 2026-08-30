/**
 * Integrity validation and corruption classification for one persisted replica
 * partition (#474 slice 9).
 *
 * A restored replica is a content-addressed value: the manifest names four
 * index roots, and every node reachable from a root is stored under the hash of
 * its own compressed body. Nothing outside this process guarantees any of that
 * still holds — a browser can lose or rewrite records, and a partial
 * maintenance pass can leave a manifest pointing at nodes that are gone. So a
 * restore verifies the whole reachable value *before* it can become observable:
 * a partial walk must never yield a partial `Db`.
 *
 * Everything here is pure. The storage adapter owns the IndexedDB reads, the
 * hashing, and the decompression; this module owns the decisions:
 *
 *   - {@link validateReplicaManifest} — is the stored manifest a complete,
 *     self-consistent description of the requested partition?
 *   - {@link validateReplicaNode} — does one decoded node match the reference
 *     that led to it (position, kind, counts, order)?
 *   - {@link replicaRecoveryAction} — what does the caller do about it?
 *
 * Corruption is classified precisely for diagnosis (missing node, hash
 * mismatch, structural invariant, undecodable record) but collapses to exactly
 * one outcome for the caller: this partition cannot be used and must be
 * replaced by a fresh snapshot. Incompatibility — a replica whose read
 * compatibility or schema metadata disagrees with the installed client
 * catalog — is the other outcome: the client must update before anything in
 * this partition can be interpreted.
 */

import * as Data from "effect/Data";
import * as Result from "effect/Result";
import type { ReadCompatibilityHash } from "../authorization/identities.ts";
import { COMPARATORS, type IndexId, IndexName } from "../core/datom.ts";
import type { Roots } from "../core/db.ts";
import { FIRST_USER_EID, Schema } from "../core/schema.ts";
import { NodeKind, type NodeRef, type TreeNode } from "../core/tree.ts";
import { REPLICA_STORAGE_VERSION, type LogicalDatom, type ReplicationIdentity } from "./protocol.ts";
import type { ReplicaAttributeSpec } from "./replica-schema.ts";

/** One committed replica exactly as a partition stores it. */
export type ReplicaManifest = {
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

/**
 * Why one stored partition cannot produce an observable `Db`.
 *
 * The first four describe damage to the content-addressed value; the last two
 * describe a value that is intact but disagrees with the installed client.
 */
export type ReplicaCorruptionReason =
  /** The manifest record is missing fields, or carries values of the wrong shape. */
  | "manifest-undecodable"
  /** The manifest decodes but contradicts itself or the requested partition. */
  | "manifest-invariant"
  /** A referenced content node is not in this partition's node store. */
  | "node-missing"
  /** A node's stored body does not hash to the address it is stored under. */
  | "node-hash"
  /** A node body cannot be decompressed or decoded. */
  | "node-undecodable"
  /** A node's kind or index disagrees with the reference that led to it. */
  | "node-kind"
  /** A node's counts, arity, or datom order break a tree invariant. */
  | "node-invariant";

/** Why one intact partition is nonetheless unusable by this client. */
export type ReplicaIncompatibilityReason =
  /** The stored read compatibility hash is not the one this client confirmed. */
  | "read-compatibility"
  /** The stored replica schema is not the installed client catalog's schema. */
  | "schema-metadata";

export type ReplicaUnusableReason = ReplicaCorruptionReason | ReplicaIncompatibilityReason;

/**
 * What the caller must do. Corruption is always recoverable by re-fetching the
 * authorized value; incompatibility is not, because no local data can be
 * interpreted until client and server agree on the read schema again.
 */
export type ReplicaRecoveryAction = "replacement-required" | "update-required";

/**
 * Collapse every damage class to one caller outcome. Distinguishing a missing
 * node from a flipped byte matters for diagnosis and for tests; it must never
 * matter for recovery, or a rarer corruption class would get a rarer — and
 * therefore less exercised — recovery path.
 */
export const replicaRecoveryAction = (
  reason: ReplicaUnusableReason,
): ReplicaRecoveryAction =>
  reason === "read-compatibility" || reason === "schema-metadata"
    ? "update-required"
    : "replacement-required";

/** One located reason a partition failed validation. */
export type ReplicaIntegrityFailure = {
  readonly reason: ReplicaCorruptionReason;
  readonly detail: string;
  /** The index whose tree was being walked, when the failure is a node's. */
  readonly index?: IndexId;
  /** The content address the failure was found at. */
  readonly hash?: string;
};

const failure = (
  reason: ReplicaCorruptionReason,
  detail: string,
  located?: {
    readonly index?: IndexId | undefined;
    readonly hash?: string | undefined;
  },
): ReplicaIntegrityFailure =>
  Object.freeze({
    reason,
    detail,
    ...(located?.index === undefined ? {} : { index: located.index }),
    ...(located?.hash === undefined ? {} : { hash: located.hash }),
  });

/** A restore refused a stored partition. Carries the classification, not a stack. */
export class ReplicaCorruptError extends Data.TaggedError("ReplicaCorruptError")<{
  readonly partition: string;
  readonly reason: ReplicaUnusableReason;
  readonly detail: string;
}> {}

/**
 * What one restore path produces. `restored` is the only variant that carries
 * an observable value; the other three are ordinary data the caller branches
 * on, never a thrown internal error.
 */
export type ReplicaRestoreOutcome<A> =
  /** A fully validated replica. */
  | { readonly _tag: "restored"; readonly replica: A }
  /** Nothing is stored for this selection. Not an error; snapshot from scratch. */
  | { readonly _tag: "absent" }
  /** The partition was quarantined; the caller must re-snapshot it. */
  | {
    readonly _tag: "replacement-required";
    readonly partition: string;
    readonly reason: ReplicaUnusableReason;
    readonly detail: string;
  }
  /** Client and server must agree on the read schema before any restore. */
  | {
    readonly _tag: "update-required";
    readonly partition: string;
    readonly reason: ReplicaUnusableReason;
    readonly detail: string;
  };

export const replicaRestored = <A>(replica: A): ReplicaRestoreOutcome<A> =>
  Object.freeze({ _tag: "restored", replica });

export const replicaAbsent = <A>(): ReplicaRestoreOutcome<A> =>
  Object.freeze({ _tag: "absent" });

/** Build the outcome a reason implies, so classification lives in one place. */
export const replicaUnusable = <A>(
  partition: string,
  reason: ReplicaUnusableReason,
  detail: string,
): ReplicaRestoreOutcome<A> =>
  Object.freeze({
    _tag: replicaRecoveryAction(reason),
    partition,
    reason,
    detail,
  });

/** The replica an outcome restored, or `undefined` for every other outcome. */
export const restoredReplica = <A>(outcome: ReplicaRestoreOutcome<A>): A | undefined =>
  outcome._tag === "restored" ? outcome.replica : undefined;

/** True when the outcome quarantined or refused a stored partition. */
export const replicaRefused = <A>(
  outcome: ReplicaRestoreOutcome<A>,
): outcome is Extract<
  ReplicaRestoreOutcome<A>,
  { readonly _tag: "replacement-required" | "update-required" }
> => outcome._tag === "replacement-required" || outcome._tag === "update-required";

// ---------------------------------------------------------------------------
// Shape checks
// ---------------------------------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A node reference is the only thing a manifest or a directory node hands the
 * walk, so its own shape has to be checked before it can be followed: an
 * address that is not a sha-256 hex digest can never name a stored node, and a
 * kind outside the two the codec defines has no legal position anywhere.
 */
export const validateReplicaNodeRef = (
  ref: unknown,
  where: string,
  index?: IndexId,
): ReplicaIntegrityFailure | undefined => {
  if (!isRecord(ref)) return failure("manifest-undecodable", `${where} is not a node reference`, { index });
  if (typeof ref.hash !== "string" || !HEX_64.test(ref.hash)) {
    return failure("manifest-undecodable", `${where} has no content address`, { index });
  }
  if (ref.kind !== NodeKind.Leaf && ref.kind !== NodeKind.Dir) {
    return failure("node-kind", `${where} declares an unknown node kind`, {
      index,
      hash: ref.hash,
    });
  }
  if (!isCount(ref.count)) {
    return failure("node-invariant", `${where} has no subtree count`, {
      index,
      hash: ref.hash,
    });
  }
  return undefined;
};

/**
 * The four roots of one committed value. EAVT and AEVT index every datom, so
 * they must agree exactly; AVET and VAET index declared subsets and can only
 * ever be smaller. A manifest that breaks either relation describes a value no
 * build could have produced.
 */
export const validateReplicaRoots = (
  roots: unknown,
): ReplicaIntegrityFailure | undefined => {
  if (!isRecord(roots)) return failure("manifest-undecodable", "manifest has no roots");
  if (!isCount(roots.t)) return failure("manifest-undecodable", "roots carry no basis");
  for (const [name, index] of [["eavt", 0], ["aevt", 1], ["avet", 2], ["vaet", 3]] as const) {
    const invalid = validateReplicaNodeRef(roots[name], `root ${name}`, index);
    if (invalid !== undefined) return invalid;
  }
  const counts = roots as unknown as Roots;
  if (counts.eavt.count !== counts.aevt.count) {
    return failure("manifest-invariant", "eavt and aevt index different datom counts");
  }
  for (const name of ["avet", "vaet"] as const) {
    if (counts[name].count > counts.eavt.count) {
      return failure("manifest-invariant", `${name} indexes more datoms than eavt`);
    }
  }
  return undefined;
};

/**
 * The identity a stored record claims, before anything else about it is known.
 *
 * A restore needs this to tell "some other value is filed here" — which selects
 * nothing and is not damage — from "this partition's record is unusable".
 * `undefined` means the record cannot even state an identity, which is damage
 * and is left to {@link validateReplicaManifest} to classify.
 */
export const replicaManifestIdentity = (
  record: unknown,
): ReplicationIdentity | undefined =>
  isRecord(record) && isRecord(record.identity)
    ? record.identity as unknown as ReplicationIdentity
    : undefined;

/** What the caller already knows about the partition it asked to restore. */
export type ReplicaManifestExpectation = {
  /** The partition key the record was read from. */
  readonly partition: string;
  /** The read compatibility hash this client has installed and confirmed. */
  readonly readCompatibilityHash: ReadCompatibilityHash;
};

const localIds = (
  entries: unknown,
  what: string,
): Result.Result<ReadonlyMap<string, number>, ReplicaIntegrityFailure> => {
  if (!Array.isArray(entries)) {
    return Result.fail(failure("manifest-undecodable", `manifest has no ${what} map`));
  }
  const map = new Map<string, number>();
  const used = new Set<number>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return Result.fail(failure("manifest-undecodable", `malformed ${what} entry`));
    }
    const [name, id] = entry as readonly unknown[];
    if (typeof name !== "string" || !isCount(id)) {
      return Result.fail(failure("manifest-undecodable", `malformed ${what} entry`));
    }
    if (map.has(name)) {
      return Result.fail(failure("manifest-invariant", `duplicate ${what} ${name}`));
    }
    if (used.has(id)) {
      return Result.fail(failure("manifest-invariant", `${what} ${name} reuses a local id`));
    }
    map.set(name, id);
    used.add(id);
  }
  return Result.succeed(map);
};

/**
 * Validate one stored manifest against the partition and client that asked for
 * it. This runs before any node is read, so a manifest that cannot describe a
 * complete value never starts a walk.
 *
 * `record` is deliberately `unknown`: it comes back from structured clone and
 * nothing but these checks makes it a {@link ReplicaManifest}.
 */
export const validateReplicaManifest = (
  record: unknown,
  expected: ReplicaManifestExpectation,
): Result.Result<ReplicaManifest, ReplicaIntegrityFailure> =>
  Result.gen(function* () {
    if (!isRecord(record)) {
      return yield* Result.fail(failure("manifest-undecodable", "manifest is not a record"));
    }
    if (record.storageVersion !== REPLICA_STORAGE_VERSION) {
      return yield* Result.fail(
        failure("manifest-invariant", "manifest is not this storage version"),
      );
    }
    if (record.partition !== expected.partition) {
      return yield* Result.fail(
        failure("manifest-invariant", "manifest is stored under another partition"),
      );
    }
    if (!isRecord(record.identity) || typeof record.revision !== "string") {
      return yield* Result.fail(
        failure("manifest-undecodable", "manifest has no identity or revision"),
      );
    }
    // The compatibility hash is duplicated onto the record so a restore can
    // refuse before touching the identity; the two must never disagree.
    if (
      record.readCompatibilityHash !== record.identity.readCompatibilityHash ||
      record.readCompatibilityHash !== expected.readCompatibilityHash
    ) {
      return yield* Result.fail(
        failure("manifest-invariant", "manifest does not confirm this read compatibility"),
      );
    }
    if (!Array.isArray(record.datoms) || !Array.isArray(record.attributes)) {
      return yield* Result.fail(
        failure("manifest-undecodable", "manifest has no datoms or attributes"),
      );
    }
    const rootsInvalid = validateReplicaRoots(record.roots);
    if (rootsInvalid !== undefined) return yield* Result.fail(rootsInvalid);
    if (!isCount(record.nextLocalId) || record.nextLocalId < FIRST_USER_EID) {
      return yield* Result.fail(
        failure("manifest-invariant", "manifest has no local id allocator"),
      );
    }
    const entities = yield* localIds(record.entityIds, "entity id");
    const attributeIds = yield* localIds(record.attributeIds, "attribute id");
    // Entities and attributes are numbered by one partition-local allocator, so
    // an id may be claimed once in total, not once per map.
    const allocated = new Set<number>();
    for (const [what, ids] of [["entity", entities], ["attribute", attributeIds]] as const) {
      for (const [name, id] of ids) {
        if (id >= record.nextLocalId) {
          return yield* Result.fail(
            failure("manifest-invariant", `${what} ${name} was never allocated`),
          );
        }
        if (allocated.has(id)) {
          return yield* Result.fail(
            failure("manifest-invariant", `${what} ${name} reuses a local id`),
          );
        }
        allocated.add(id);
      }
    }
    const bootstrap = Schema.bootstrap();
    // Materialization projects these straight into the restored schema, so a
    // malformed one is damage rather than a client disagreement, and one the
    // allocator never numbered would leave a restored attribute with no local
    // id at all.
    for (const spec of record.attributes as readonly unknown[]) {
      if (
        !isRecord(spec) || typeof spec.ident !== "string" ||
        typeof spec.valueType !== "number" ||
        (spec.cardinality !== "one" && spec.cardinality !== "many") ||
        typeof spec.index !== "boolean" || typeof spec.isComponent !== "boolean" ||
        typeof spec.optional !== "boolean" ||
        (spec.unique !== undefined && spec.unique !== "identity" && spec.unique !== "value")
      ) {
        return yield* Result.fail(failure("manifest-undecodable", "malformed replica attribute"));
      }
      if (bootstrap.attr(spec.ident) === undefined && !attributeIds.has(spec.ident)) {
        return yield* Result.fail(
          failure("manifest-invariant", `attribute ${spec.ident} has no local id`),
        );
      }
    }
    // Every fact the manifest keeps must be interpretable: its entity, its
    // field, and any entity it references all need a partition-local id, or
    // materialization would have to invent one and the restored value would
    // silently differ from the committed one.
    for (const datom of record.datoms as readonly LogicalDatom[]) {
      if (!isRecord(datom) || typeof datom.entity !== "string" || typeof datom.field !== "string") {
        return yield* Result.fail(failure("manifest-undecodable", "malformed logical datom"));
      }
      if (!entities.has(datom.entity)) {
        return yield* Result.fail(
          failure("manifest-invariant", `fact entity ${datom.entity} has no local id`),
        );
      }
      if (bootstrap.attr(datom.field) === undefined && !attributeIds.has(datom.field)) {
        return yield* Result.fail(
          failure("manifest-invariant", `fact field ${datom.field} has no local id`),
        );
      }
      if (
        isRecord(datom.value) && datom.value.type === "ref" &&
        (typeof datom.value.value !== "string" || !entities.has(datom.value.value))
      ) {
        return yield* Result.fail(
          failure("manifest-invariant", "logical reference has no local entity"),
        );
      }
    }
    return record as unknown as ReplicaManifest;
  });

// ---------------------------------------------------------------------------
// Node checks
// ---------------------------------------------------------------------------

/** The datoms a node holds directly, or the total its children claim. */
const nodeCount = (node: TreeNode): number => {
  if (node.kind === NodeKind.Leaf) return node.datoms.length;
  let total = 0;
  for (const ref of node.refs) total += ref.count;
  return total;
};

/** The references a walk must follow out of one node. */
export const replicaNodeChildren = (node: TreeNode): readonly NodeRef[] =>
  node.kind === NodeKind.Dir ? node.refs : [];

/**
 * Validate one decoded node against the reference that led the walk to it.
 *
 * The content address already proves the body is exactly the bytes that were
 * written, so these checks are about *position*: a node whose body is intact
 * but which is reachable from somewhere it does not belong would otherwise
 * produce a well-formed `Db` over the wrong datoms. The index tag, the kind,
 * the subtree count, and the sort order are all recorded independently of the
 * reference, so each disagreement is a real inconsistency.
 */
export const validateReplicaNode = (
  index: IndexId,
  ref: NodeRef,
  decoded: { readonly index: IndexId; readonly node: TreeNode },
): ReplicaIntegrityFailure | undefined => {
  const located = { index, hash: ref.hash };
  if (decoded.index !== index) {
    return failure(
      "node-kind",
      `node belongs to index ${decoded.index}, not ${IndexName[index]}`,
      located,
    );
  }
  const node = decoded.node;
  if (node.kind !== ref.kind) return failure("node-kind", "node kind is not the referenced kind", located);
  if (nodeCount(node) !== ref.count) {
    return failure("node-invariant", "node does not hold the referenced datom count", located);
  }
  const comparator = COMPARATORS[index];
  if (node.kind === NodeKind.Leaf) {
    for (let i = 1; i < node.datoms.length; i++) {
      if (comparator(node.datoms[i - 1], node.datoms[i]) >= 0) {
        return failure("node-invariant", "leaf datoms are not in index order", located);
      }
    }
    return undefined;
  }
  if (node.refs.length !== node.keys.length) {
    return failure("node-invariant", "directory keys and children disagree", located);
  }
  // A directory with no children can never be reached by a descent, and a
  // build never produces one: an empty tree is an empty leaf root.
  if (node.refs.length === 0) return failure("node-invariant", "directory has no children", located);
  for (let i = 0; i < node.refs.length; i++) {
    const invalid = validateReplicaNodeRef(node.refs[i], `child ${i}`, index);
    if (invalid !== undefined) return invalid;
    if (i > 0 && comparator(node.keys[i - 1], node.keys[i]) >= 0) {
      return failure("node-invariant", "directory keys are not in index order", located);
    }
  }
  return undefined;
};
