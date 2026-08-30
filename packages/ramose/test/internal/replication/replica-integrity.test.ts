import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import { ReadCompatibilityHash } from "../../../src/internal/authorization/identities.ts";
import { Index, ValueTag, type Datom } from "../../../src/internal/core/datom.ts";
import { FIRST_USER_EID } from "../../../src/internal/core/schema.ts";
import { NodeKind, type NodeRef, type TreeNode } from "../../../src/internal/core/tree.ts";
import type { ReplicationIdentity } from "../../../src/internal/replication/protocol.ts";
import {
  ReplicaCorruptError,
  replicaAbsent,
  replicaManifestIdentity,
  replicaNodeChildren,
  replicaRecoveryAction,
  replicaRefused,
  replicaRestored,
  replicaUnusable,
  restoredReplica,
  validateReplicaManifest,
  validateReplicaNode,
  validateReplicaNodeRef,
  validateReplicaRoots,
  type ReplicaCorruptionReason,
  type ReplicaIncompatibilityReason,
} from "../../../src/internal/replication/replica-integrity.ts";
import { replicaPartitionKey } from "../../../src/internal/replication/replica-lifecycle.ts";

const opaque = (character: string): string => character.repeat(43);
const READ_COMPATIBILITY = ReadCompatibilityHash.make(opaque("k"));

const identity = (overrides: Partial<ReplicationIdentity> = {}): ReplicationIdentity => ({
  version: 1,
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: READ_COMPATIBILITY,
  graphLineage: [],
  authenticator: opaque("a"),
  ...overrides,
});

const hash = (character: string): string => character.repeat(64);

const ref = (overrides: Partial<NodeRef> = {}): NodeRef => ({
  hash: hash("a"),
  kind: NodeKind.Leaf,
  count: 0,
  ...overrides,
});

const roots = (overrides: Record<string, unknown> = {}) => ({
  t: 2,
  eavt: ref({ hash: hash("1"), count: 4 }),
  aevt: ref({ hash: hash("2"), count: 4 }),
  avet: ref({ hash: hash("3"), count: 1 }),
  vaet: ref({ hash: hash("4"), count: 0 }),
  ...overrides,
});

const datom = (e: number, a: number, v: string): Datom => ({
  e,
  a,
  vt: ValueTag.Str,
  v,
  t: 2,
  op: true,
});

const manifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  partition: replicaPartitionKey(identity()),
  storageVersion: 2,
  identity: identity(),
  readCompatibilityHash: READ_COMPATIBILITY,
  revision: opaque("r"),
  datoms: [
    { entity: opaque("e"), field: ":item/name", value: { type: "string", value: "x" }, op: "add" },
    { entity: opaque("e"), field: ":item/friend", value: { type: "ref", value: opaque("f") }, op: "add" },
  ],
  attributes: [],
  entityIds: [[opaque("e"), 1000], [opaque("f"), 1001]],
  attributeIds: [[":item/name", 1002], [":item/friend", 1003]],
  roots: roots(),
  nextLocalId: 1004,
  ...overrides,
});

const validated = (overrides: Record<string, unknown> = {}) =>
  validateReplicaManifest(manifest(overrides), {
    partition: replicaPartitionKey(identity()),
    readCompatibilityHash: READ_COMPATIBILITY,
  });

const reasonOf = (result: ReturnType<typeof validated>): string =>
  Result.isFailure(result) ? result.failure.reason : "no failure";

describe("replica recovery classification", () => {
  test("every damage class collapses to one caller outcome", () => {
    const corruption: readonly ReplicaCorruptionReason[] = [
      "manifest-undecodable",
      "manifest-invariant",
      "node-missing",
      "node-hash",
      "node-undecodable",
      "node-kind",
      "node-invariant",
    ];
    // A rarer corruption class must not get a rarer recovery path: the caller
    // re-snapshots, whatever the classification said.
    for (const reason of corruption) {
      expect(replicaRecoveryAction(reason)).toBe("replacement-required");
    }
    const incompatibility: readonly ReplicaIncompatibilityReason[] = [
      "read-compatibility",
      "schema-metadata",
    ];
    // Incompatibility is the other outcome: no local data can be interpreted
    // until client and server agree on the read schema again.
    for (const reason of incompatibility) {
      expect(replicaRecoveryAction(reason)).toBe("update-required");
    }
  });

  test("outcomes are ordinary data the caller branches on", () => {
    const restored = replicaRestored({ revision: opaque("r") });
    expect(restored._tag).toBe("restored");
    expect(restoredReplica(restored)).toEqual({ revision: opaque("r") });
    expect(replicaRefused(restored)).toBe(false);

    const absent = replicaAbsent<{ revision: string }>();
    expect(absent._tag).toBe("absent");
    expect(restoredReplica(absent)).toBeUndefined();
    expect(replicaRefused(absent)).toBe(false);

    const corrupt = replicaUnusable("partition", "node-missing", "gone");
    expect(corrupt).toEqual({
      _tag: "replacement-required",
      partition: "partition",
      reason: "node-missing",
      detail: "gone",
    });
    expect(restoredReplica(corrupt)).toBeUndefined();
    expect(replicaRefused(corrupt)).toBe(true);

    expect(replicaUnusable("partition", "read-compatibility", "stale")._tag)
      .toBe("update-required");
  });

  test("the typed error carries the classification, not a stack", () => {
    const error = new ReplicaCorruptError({
      partition: "partition",
      reason: "node-hash",
      detail: "flipped",
    });
    expect(error._tag).toBe("ReplicaCorruptError");
    expect(error.reason).toBe("node-hash");
    expect(replicaRecoveryAction(error.reason)).toBe("replacement-required");
  });
});

describe("node reference validation", () => {
  test("only a sha-256 address, a defined kind, and a count may be followed", () => {
    expect(validateReplicaNodeRef(ref(), "root eavt")).toBeUndefined();
    expect(validateReplicaNodeRef(undefined, "root eavt")?.reason).toBe("manifest-undecodable");
    expect(validateReplicaNodeRef({ ...ref(), hash: "short" }, "root eavt")?.reason)
      .toBe("manifest-undecodable");
    // Uppercase is not the digest spelling this format writes.
    expect(validateReplicaNodeRef({ ...ref(), hash: "A".repeat(64) }, "root eavt")?.reason)
      .toBe("manifest-undecodable");
    expect(validateReplicaNodeRef({ ...ref(), kind: 7 }, "root eavt")?.reason).toBe("node-kind");
    expect(validateReplicaNodeRef({ ...ref(), count: -1 }, "root eavt")?.reason)
      .toBe("node-invariant");
    expect(validateReplicaNodeRef({ ...ref(), count: 1.5 }, "root eavt")?.reason)
      .toBe("node-invariant");
  });

  test("the located failure names the index and the address it was found at", () => {
    const failure = validateReplicaNodeRef({ ...ref(), count: -1 }, "child 3", Index.AEVT);
    expect(failure).toMatchObject({ index: Index.AEVT, hash: hash("a") });
  });
});

describe("root validation", () => {
  test("eavt and aevt index the same datoms, avet and vaet a subset", () => {
    expect(validateReplicaRoots(roots())).toBeUndefined();
    expect(validateReplicaRoots(roots({ aevt: ref({ hash: hash("2"), count: 5 }) }))?.reason)
      .toBe("manifest-invariant");
    expect(validateReplicaRoots(roots({ avet: ref({ hash: hash("3"), count: 5 }) }))?.reason)
      .toBe("manifest-invariant");
    expect(validateReplicaRoots(roots({ vaet: ref({ hash: hash("4"), count: 5 }) }))?.reason)
      .toBe("manifest-invariant");
  });

  test("roots without a basis or a complete set of trees describe no value", () => {
    expect(validateReplicaRoots(undefined)?.reason).toBe("manifest-undecodable");
    expect(validateReplicaRoots(roots({ t: -1 }))?.reason).toBe("manifest-undecodable");
    expect(validateReplicaRoots(roots({ vaet: undefined }))?.reason).toBe("manifest-undecodable");
  });
});

describe("manifest validation", () => {
  test("a complete manifest of the requested partition validates", () => {
    const result = validated();
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.revision).toBe(opaque("r"));
  });

  test("a record that cannot state its shape is undecodable", () => {
    expect(reasonOf(validated({ identity: undefined }))).toBe("manifest-undecodable");
    expect(reasonOf(validated({ datoms: undefined }))).toBe("manifest-undecodable");
    expect(reasonOf(validated({ attributes: "not an array" }))).toBe("manifest-undecodable");
    expect(reasonOf(validated({ entityIds: [["only one element"]] })))
      .toBe("manifest-undecodable");
    expect(reasonOf(validated({ datoms: [{ entity: 7, field: ":item/name" }] })))
      .toBe("manifest-undecodable");
  });

  test("a record that contradicts itself or its partition is an invariant failure", () => {
    expect(reasonOf(validated({ storageVersion: 1 }))).toBe("manifest-invariant");
    expect(reasonOf(validated({ partition: "elsewhere" }))).toBe("manifest-invariant");
    // The duplicated hash exists so a restore can refuse before reading the
    // identity; the two disagreeing is itself the corruption.
    expect(reasonOf(validated({ readCompatibilityHash: ReadCompatibilityHash.make(opaque("z")) })))
      .toBe("manifest-invariant");
    expect(reasonOf(
      validated({ identity: identity({ readCompatibilityHash: ReadCompatibilityHash.make(opaque("z")) }) }),
    )).toBe("manifest-invariant");
  });

  test("every fact must be interpretable by a partition-local id", () => {
    expect(reasonOf(validated({ entityIds: [[opaque("f"), 1001]] }))).toBe("manifest-invariant");
    expect(reasonOf(validated({
      datoms: [{
        entity: opaque("e"),
        field: ":item/friend",
        value: { type: "ref", value: opaque("missing") },
        op: "add",
      }],
    }))).toBe("manifest-invariant");
    expect(reasonOf(validated({ attributeIds: [[":item/name", 1002]] })))
      .toBe("manifest-invariant");
    // A built-in field needs no partition-local id: the bootstrap schema owns it.
    expect(Result.isSuccess(validated({
      datoms: [{ entity: opaque("e"), field: ":db/ident", value: { type: "string", value: "x" }, op: "add" }],
      attributeIds: [],
      nextLocalId: 1002,
    }))).toBe(true);
  });

  test("local ids must be allocated, distinct, and below the allocator", () => {
    expect(reasonOf(validated({ nextLocalId: 1001 }))).toBe("manifest-invariant");
    expect(reasonOf(validated({ nextLocalId: FIRST_USER_EID - 1 }))).toBe("manifest-invariant");
    expect(reasonOf(validated({ entityIds: [[opaque("e"), 1000], [opaque("f"), 1000]] })))
      .toBe("manifest-invariant");
    expect(reasonOf(validated({ entityIds: [[opaque("e"), 1000], [opaque("e"), 1001]] })))
      .toBe("manifest-invariant");
    // An entity id an attribute already owns would materialize two things onto
    // one local identifier.
    expect(reasonOf(validated({ attributeIds: [[":item/name", 1000]] })))
      .toBe("manifest-invariant");
  });

  test("the claimed identity is readable before anything else about the record is", () => {
    expect(replicaManifestIdentity(manifest())).toMatchObject({ server: opaque("s") });
    expect(replicaManifestIdentity({ identity: "not a record" })).toBeUndefined();
    expect(replicaManifestIdentity(undefined)).toBeUndefined();
  });
});

describe("node validation", () => {
  const leaf = (datoms: readonly Datom[]): TreeNode => ({ kind: NodeKind.Leaf, datoms });
  const dir = (keys: readonly Datom[], refs: readonly NodeRef[]): TreeNode => ({
    kind: NodeKind.Dir,
    keys,
    refs,
  });
  const first = datom(1000, 20, "a");
  const second = datom(1001, 20, "b");

  test("a leaf holding exactly the referenced datoms in index order validates", () => {
    const node = leaf([first, second]);
    expect(validateReplicaNode(Index.EAVT, ref({ count: 2 }), {
      index: Index.EAVT,
      node,
    })).toBeUndefined();
    expect(replicaNodeChildren(node)).toEqual([]);
  });

  test("a node reached from the wrong index or the wrong kind is refused", () => {
    expect(validateReplicaNode(Index.EAVT, ref({ count: 2 }), {
      index: Index.AEVT,
      node: leaf([first, second]),
    })?.reason).toBe("node-kind");
    expect(validateReplicaNode(Index.EAVT, ref({ kind: NodeKind.Dir, count: 2 }), {
      index: Index.EAVT,
      node: leaf([first, second]),
    })?.reason).toBe("node-kind");
  });

  test("counts, arity, and order are the invariants a valid body can still break", () => {
    expect(validateReplicaNode(Index.EAVT, ref({ count: 3 }), {
      index: Index.EAVT,
      node: leaf([first, second]),
    })?.reason).toBe("node-invariant");
    expect(validateReplicaNode(Index.EAVT, ref({ count: 2 }), {
      index: Index.EAVT,
      node: leaf([second, first]),
    })?.reason).toBe("node-invariant");
    expect(validateReplicaNode(Index.EAVT, ref({ count: 2 }), {
      index: Index.EAVT,
      node: leaf([first, first]),
    })?.reason).toBe("node-invariant");
  });

  test("a directory must agree with its children about how many datoms they hold", () => {
    const children = [
      ref({ hash: hash("b"), count: 2 }),
      ref({ hash: hash("c"), count: 3 }),
    ];
    const node = dir([first, second], children);
    expect(validateReplicaNode(Index.EAVT, ref({ kind: NodeKind.Dir, count: 5 }), {
      index: Index.EAVT,
      node,
    })).toBeUndefined();
    expect(replicaNodeChildren(node)).toEqual(children);
    expect(validateReplicaNode(Index.EAVT, ref({ kind: NodeKind.Dir, count: 4 }), {
      index: Index.EAVT,
      node,
    })?.reason).toBe("node-invariant");
  });

  test("a directory with no children, mismatched keys, or unordered keys is refused", () => {
    const children = [ref({ hash: hash("b"), count: 2 })];
    expect(validateReplicaNode(Index.EAVT, ref({ kind: NodeKind.Dir, count: 0 }), {
      index: Index.EAVT,
      node: dir([], []),
    })?.reason).toBe("node-invariant");
    expect(validateReplicaNode(Index.EAVT, ref({ kind: NodeKind.Dir, count: 2 }), {
      index: Index.EAVT,
      node: dir([first, second], children),
    })?.reason).toBe("node-invariant");
    expect(validateReplicaNode(Index.EAVT, ref({ kind: NodeKind.Dir, count: 4 }), {
      index: Index.EAVT,
      node: dir([second, first], [
        ref({ hash: hash("b"), count: 2 }),
        ref({ hash: hash("c"), count: 2 }),
      ]),
    })?.reason).toBe("node-invariant");
  });

  test("a child reference the walk cannot follow is caught before it is queued", () => {
    expect(validateReplicaNode(Index.EAVT, ref({ kind: NodeKind.Dir, count: 2 }), {
      index: Index.EAVT,
      node: dir([first], [{ hash: "short", kind: NodeKind.Leaf, count: 2 }]),
    })?.reason).toBe("manifest-undecodable");
  });
});
