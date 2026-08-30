import * as Data from "effect/Data";
import * as Result from "effect/Result";
import { ENTITY_ID_PATTERN } from "../../db/refs.ts";
import type { ReadCompatibilityHash } from "../authorization/identities.ts";
import { COMPARATORS, type Datom, type IndexId, IndexName } from "../core/datom.ts";
import type { Roots } from "../core/db.ts";
import { FIRST_USER_EID, Schema } from "../core/schema.ts";
import { NodeKind, type NodeRef, type TreeNode } from "../core/tree.ts";
import {
  REPLICA_STORAGE_VERSION,
  type LogicalDatom,
  type LogicalValue,
  type ReplicationIdentity,
} from "./protocol.ts";
import {
  replicaBootstrapDatoms,
  replicaFactDatom,
  replicaSchema,
  type ReplicaAttributeSpec,
} from "./replica-schema.ts";

export type ReplicaManifest = {
  readonly partition: string;
  readonly storageVersion: typeof REPLICA_STORAGE_VERSION;
  readonly identity: ReplicationIdentity;
  readonly readCompatibilityHash: ReadCompatibilityHash;
  readonly revision: string;
  readonly datoms: readonly LogicalDatom[];
  readonly attributes: readonly ReplicaAttributeSpec[];
  readonly entityIds: readonly (readonly [string, number])[];
  readonly entityHandles: readonly (readonly [string, string])[];
  readonly attributeIds: readonly (readonly [string, number])[];
  readonly roots: Roots;
  readonly nextLocalId: number;
  readonly installId?: string | undefined;
};

export type ReplicaCorruptionReason =
  | "manifest-undecodable"
  | "manifest-invariant"
  | "node-missing"
  | "node-hash"
  | "node-undecodable"
  | "node-kind"
  | "node-invariant";

export type ReplicaIncompatibilityReason =
  | "read-compatibility"
  | "schema-metadata";

export type ReplicaUnusableReason = ReplicaCorruptionReason | ReplicaIncompatibilityReason;

export type ReplicaRecoveryAction = "replacement-required" | "update-required";

export const replicaRecoveryAction = (
  reason: ReplicaUnusableReason,
): ReplicaRecoveryAction =>
  reason === "read-compatibility" || reason === "schema-metadata"
    ? "update-required"
    : "replacement-required";

export type ReplicaIntegrityFailure = {
  readonly reason: ReplicaCorruptionReason;
  readonly detail: string;
  readonly index?: IndexId;
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

export class ReplicaCorruptError extends Data.TaggedError("ReplicaCorruptError")<{
  readonly partition: string;
  readonly reason: ReplicaUnusableReason;
  readonly detail: string;
}> {}

export type ReplicaRestoreOutcome<A> =
  | { readonly _tag: "restored"; readonly replica: A }
  | { readonly _tag: "absent" }
  | { readonly _tag: "contended"; readonly partition: string; readonly attempts: number }
  | {
    readonly _tag: "replacement-required";
    readonly partition: string;
    readonly reason: ReplicaUnusableReason;
    readonly detail: string;
  }
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

export const replicaContended = <A>(
  partition: string,
  attempts: number,
): ReplicaRestoreOutcome<A> => Object.freeze({ _tag: "contended", partition, attempts });

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

export const restoredReplica = <A>(outcome: ReplicaRestoreOutcome<A>): A | undefined =>
  outcome._tag === "restored" ? outcome.replica : undefined;

export const replicaRefused = <A>(
  outcome: ReplicaRestoreOutcome<A>,
): outcome is Extract<
  ReplicaRestoreOutcome<A>,
  { readonly _tag: "replacement-required" | "update-required" }
> => outcome._tag === "replacement-required" || outcome._tag === "update-required";

const HEX_64 = /^[0-9a-f]{64}$/;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const isReplicationIdentityShape = (value: unknown): value is ReplicationIdentity =>
  isRecord(value) && value.version === 1 &&
  ["server", "principal", "database", "catalog", "readView", "readCompatibilityHash",
    "authenticator"].every((field) => typeof value[field] === "string") &&
  Array.isArray(value.graphLineage) &&
  value.graphLineage.every((entity: unknown) => typeof entity === "string");

export const replicaManifestIdentity = (
  record: unknown,
): ReplicationIdentity | undefined =>
  isRecord(record) && isReplicationIdentityShape(record.identity)
    ? record.identity as unknown as ReplicationIdentity
    : undefined;

export const replicaManifestFingerprint = (record: unknown): string => {
  const manifest = isRecord(record) ? record : {};
  const roots = isRecord(manifest.roots) ? manifest.roots : {};
  const size = (value: unknown): number => Array.isArray(value) ? value.length : -1;
  return JSON.stringify([
    typeof manifest.revision === "string" ? manifest.revision : null,
    ...(["eavt", "aevt", "avet", "vaet"] as const).map((name) => {
      const ref = roots[name];
      return isRecord(ref) && typeof ref.hash === "string" ? ref.hash : null;
    }),
    typeof manifest.installId === "string" ? manifest.installId : null,
    typeof roots.t === "number" ? roots.t : null,
    typeof manifest.nextLocalId === "number" ? manifest.nextLocalId : null,
    size(manifest.datoms),
    size(manifest.attributes),
    size(manifest.entityIds),
    size(manifest.attributeIds),
  ]);
};

const isLogicalValue = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "long":
    case "instant":
      return typeof value.value === "number" && Number.isSafeInteger(value.value);
    case "double":
      return (typeof value.value === "number" && Number.isFinite(value.value)) ||
        value.value === "positive-infinity" || value.value === "negative-infinity";
    case "boolean":
      return typeof value.value === "boolean";
    case "string":
    case "ref":
    case "uuid":
      return typeof value.value === "string";
    case "bytes":
      return typeof value.value === "string" && isCanonicalBase64(value.value);
    default:
      return false;
  }
};

const isCanonicalBase64 = (value: string): boolean => {
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
};

export type ReplicaManifestExpectation = {
  readonly partition: string;
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
    if (id < FIRST_USER_EID) {
      return Result.fail(failure("manifest-invariant", `${what} ${name} is a reserved local id`));
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

const sealedHandles = (
  entries: unknown,
): Result.Result<ReadonlyMap<string, string>, ReplicaIntegrityFailure> => {
  if (!Array.isArray(entries)) {
    return Result.fail(failure("manifest-undecodable", "manifest has no entity handle map"));
  }
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return Result.fail(failure("manifest-undecodable", "malformed entity handle entry"));
    }
    const [identity, handle] = entry as readonly unknown[];
    if (typeof identity !== "string" || typeof handle !== "string") {
      return Result.fail(failure("manifest-undecodable", "malformed entity handle entry"));
    }
    if (!ENTITY_ID_PATTERN.test(handle)) {
      return Result.fail(
        failure("manifest-undecodable", `entity handle for ${identity} is not a sealed handle`),
      );
    }
    if (map.has(identity)) {
      return Result.fail(failure("manifest-invariant", `duplicate entity handle ${identity}`));
    }
    if (used.has(handle)) {
      return Result.fail(
        failure("manifest-invariant", `entity handle ${identity} reuses another entity's handle`),
      );
    }
    map.set(identity, handle);
    used.add(handle);
  }
  return Result.succeed(map);
};

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
    const identity = record.identity;
    if (!isReplicationIdentityShape(identity) || typeof record.revision !== "string") {
      return yield* Result.fail(
        failure("manifest-undecodable", "manifest has no complete identity or revision"),
      );
    }
    if (
      record.readCompatibilityHash !== identity.readCompatibilityHash ||
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
    const handles = yield* sealedHandles(record.entityHandles);
    const attributeIds = yield* localIds(record.attributeIds, "attribute id");
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
    for (const datom of record.datoms as readonly LogicalDatom[]) {
      if (
        !isRecord(datom) || typeof datom.entity !== "string" ||
        typeof datom.field !== "string" || datom.op !== "add" ||
        !isLogicalValue(datom.value)
      ) {
        return yield* Result.fail(failure("manifest-undecodable", "malformed logical datom"));
      }
      if (!entities.has(datom.entity)) {
        return yield* Result.fail(
          failure("manifest-invariant", `fact entity ${datom.entity} has no local id`),
        );
      }
      if (!handles.has(datom.entity)) {
        return yield* Result.fail(
          failure("manifest-invariant", `fact entity ${datom.entity} has no sealed handle`),
        );
      }
      if (bootstrap.attr(datom.field) === undefined && !attributeIds.has(datom.field)) {
        return yield* Result.fail(
          failure("manifest-invariant", `fact field ${datom.field} has no local id`),
        );
      }
      if ((datom.value as LogicalValue).type === "ref") {
        const target = (datom.value as Extract<LogicalValue, { type: "ref" }>).value;
        if (!entities.has(target)) {
          return yield* Result.fail(
            failure("manifest-invariant", "logical reference has no local entity"),
          );
        }
        if (!handles.has(target)) {
          return yield* Result.fail(
            failure("manifest-invariant", "logical reference has no sealed handle"),
          );
        }
      }
    }
    return record as unknown as ReplicaManifest;
  });

export type ReplicaIndexDigest = {
  datoms: number;
  sum: number;
  xor: number;
  basis: number;
};

export const emptyReplicaIndexDigest = (): ReplicaIndexDigest =>
  ({ datoms: 0, sum: 0, xor: 0, basis: 0 });

const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;

const mix = (hash: number, word: number): number =>
  Math.imul(hash ^ (word >>> 0), FNV_PRIME) >>> 0;

const scratch = new DataView(new ArrayBuffer(8));

const mixNumber = (hash: number, value: number): number => {
  scratch.setFloat64(0, value);
  return mix(mix(hash, scratch.getUint32(0)), scratch.getUint32(4));
};

const mixString = (hash: number, value: string): number => {
  let mixed = mix(hash, value.length);
  for (let i = 0; i < value.length; i++) mixed = mix(mixed, value.charCodeAt(i));
  return mixed;
};

const datomHash = (datom: Datom): number => {
  let hash = mix(mix(mix(mix(FNV_OFFSET, datom.e), datom.a), datom.t), datom.vt);
  hash = mix(hash, datom.op ? 1 : 0);
  const value = datom.v;
  if (typeof value === "number") return mixNumber(hash, value);
  if (typeof value === "string") return mixString(hash, value);
  if (typeof value === "boolean") return mix(hash, value ? 1 : 0);
  let mixed = mix(hash, value.length);
  for (let i = 0; i < value.length; i++) mixed = mix(mixed, value[i]);
  return mixed;
};

export const digestReplicaDatoms = (
  digest: ReplicaIndexDigest,
  datoms: readonly Datom[],
): void => {
  for (const datom of datoms) {
    const hash = datomHash(datom);
    digest.datoms++;
    digest.sum = (digest.sum + hash) >>> 0;
    digest.xor = (digest.xor ^ hash) >>> 0;
    if (datom.t > digest.basis) digest.basis = datom.t;
  }
};

export const sameReplicaIndexContents = (
  left: ReplicaIndexDigest,
  right: ReplicaIndexDigest,
): boolean =>
  left.datoms === right.datoms && left.sum === right.sum && left.xor === right.xor &&
  left.basis === right.basis;

export type ReplicaIndexDigests = Record<IndexId, ReplicaIndexDigest>;

const emptyDigests = (): ReplicaIndexDigests => ({
  0: emptyReplicaIndexDigest(),
  1: emptyReplicaIndexDigest(),
  2: emptyReplicaIndexDigest(),
  3: emptyReplicaIndexDigest(),
});

export const expectedReplicaContents = (
  manifest: ReplicaManifest,
): Result.Result<ReplicaIndexDigests, ReplicaIntegrityFailure> => {
  const entities = new Map(manifest.entityIds);
  const built = replicaSchema(manifest.attributes, new Map(manifest.attributeIds));
  if (built === undefined) {
    return Result.fail(failure("manifest-invariant", "a stored attribute has no local id"));
  }
  const digests = emptyDigests();
  const fold = (datom: Datom): void => {
    digestReplicaDatoms(digests[0], [datom]);
    digestReplicaDatoms(digests[1], [datom]);
    if (built.schema.isAvet(datom.a)) digestReplicaDatoms(digests[2], [datom]);
    if (built.schema.isVaet(datom.a)) digestReplicaDatoms(digests[3], [datom]);
  };
  try {
    for (const datom of replicaBootstrapDatoms()) fold(datom);
    for (const datom of built.datoms) fold(datom);
    for (const logical of manifest.datoms) {
      const fact = replicaFactDatom(logical, built.schema, entities);
      if (typeof fact === "string") {
        return Result.fail(
          failure("manifest-invariant", `stored fact on ${logical.field} cannot be materialized`),
        );
      }
      fold(fact);
    }
  } catch {
    return Result.fail(failure("manifest-undecodable", "a stored fact cannot be materialized"));
  }
  return Result.succeed(digests);
};

export const validateReplicaContents = (
  roots: Roots,
  walked: ReplicaIndexDigests,
  expected: ReplicaIndexDigests,
): ReplicaIntegrityFailure | undefined => {
  for (const index of [0, 1, 2, 3] as const) {
    if (!sameReplicaIndexContents(walked[index], expected[index])) {
      return failure(
        "manifest-invariant",
        `${IndexName[index]} does not hold the datoms this manifest describes`,
        { index },
      );
    }
  }
  if (roots.t !== expected[0].basis) {
    return failure("manifest-invariant", "the manifest basis is not the indexed basis");
  }
  return undefined;
};

const nodeCount = (node: TreeNode): number => {
  if (node.kind === NodeKind.Leaf) return node.datoms.length;
  let total = 0;
  for (const ref of node.refs) total += ref.count;
  return total;
};

export const replicaNodeChildren = (node: TreeNode): readonly NodeRef[] =>
  node.kind === NodeKind.Dir ? node.refs : [];

export const validateReplicaNode = (
  index: IndexId,
  ref: NodeRef,
  decoded: { readonly index: IndexId; readonly node: TreeNode },
  expectedKey?: Datom,
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
  const smallest = node.kind === NodeKind.Leaf ? node.datoms[0] : node.keys[0];
  if (expectedKey !== undefined) {
    if (smallest === undefined) {
      return failure("node-invariant", "a linked subtree holds no datoms", located);
    }
    if (comparator(expectedKey, smallest) !== 0) {
      return failure(
        "node-invariant",
        "directory separator is not the first datom of its subtree",
        located,
      );
    }
  }
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
