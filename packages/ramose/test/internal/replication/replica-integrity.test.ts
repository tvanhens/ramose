import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import { ReadCompatibilityHash } from "../../../src/internal/authorization/identities.ts";
import { Index, ValueTag, type Datom } from "../../../src/internal/core/datom.ts";
import type { Roots } from "../../../src/internal/core/db.ts";
import { FIRST_USER_EID } from "../../../src/internal/core/schema.ts";
import { NodeKind, type NodeRef, type TreeNode } from "../../../src/internal/core/tree.ts";
import type { ReplicationIdentity } from "../../../src/internal/replication/protocol.ts";
import {
  ReplicaCorruptError,
  digestReplicaDatoms,
  emptyReplicaIndexDigest,
  expectedReplicaContents,
  replicaAbsent,
  replicaManifestFingerprint,
  replicaManifestIdentity,
  replicaRecoveryAction,
  replicaRefused,
  replicaRestored,
  replicaUnusable,
  restoredReplica,
  sameReplicaIndexContents,
  validateReplicaContents,
  validateReplicaManifest,
  validateReplicaNode,
  validateReplicaNodeRef,
  validateReplicaRoots,
  type ReplicaCorruptionReason,
  type ReplicaIncompatibilityReason,
} from "../../../src/internal/replication/replica-integrity.ts";
import { replicaPartitionKey } from "../../../src/internal/replication/replica-lifecycle.ts";
import { sealedHandle } from "../../replication-fixtures.ts";

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
  storageVersion: 6,
  identity: identity(),
  readCompatibilityHash: READ_COMPATIBILITY,
  revision: opaque("r"),
  ordinal: 1,
  settled: 0,
  datoms: [
    { entity: opaque("e"), field: ":item/name", value: { type: "string", value: "x" }, op: "add" },
    { entity: opaque("e"), field: ":item/friend", value: { type: "ref", value: opaque("f") }, op: "add" },
  ],
  attributes: [],
  entityIds: [[opaque("e"), 1000], [opaque("f"), 1001]],
  entityHandles: [
    [opaque("e"), sealedHandle(opaque("e"))],
    [opaque("f"), sealedHandle(opaque("f"))],
  ],
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

    for (const reason of corruption) {
      expect(replicaRecoveryAction(reason)).toBe("replacement-required");
    }
    const incompatibility: readonly ReplicaIncompatibilityReason[] = [
      "read-compatibility",
      "schema-metadata",
    ];

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
    if (Result.isSuccess(result)) {
      expect(result.success.revision).toBe(opaque("r"));
      expect(result.success.ordinal).toBe(1);
      expect(result.success.settled).toBe(0);
    }
  });

  test("a manifest carries the settlement watermark it was stored with", () => {
    const result = validated({ settled: 4 });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.settled).toBe(4);
  });

  test("a record that cannot state its shape is undecodable", () => {
    expect(reasonOf(validated({ identity: undefined }))).toBe("manifest-undecodable");
    for (const ordinal of [undefined, 0, -1, 1.5, "1"]) {
      expect(reasonOf(validated({ ordinal }))).toBe("manifest-undecodable");
    }
    for (const settled of [undefined, -1, 1.5, "1"]) {
      expect(reasonOf(validated({ settled }))).toBe("manifest-undecodable");
    }
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

    expect(reasonOf(validated({ attributeIds: [[":item/name", 1000]] })))
      .toBe("manifest-invariant");
  });

  test("stored attributes must be well formed and numbered", () => {
    const spec = {
      ident: ":item/name",
      valueType: 3,
      cardinality: "one",
      index: true,
      isComponent: false,
      optional: false,
    };
    expect(Result.isSuccess(validated({
      attributes: [spec],
      attributeIds: [[":item/name", 1002], [":item/friend", 1003]],
    }))).toBe(true);

    expect(reasonOf(validated({ attributes: [{ ...spec, valueType: ":db.type/string" }] })))
      .toBe("manifest-undecodable");
    expect(reasonOf(validated({ attributes: [{ ...spec, cardinality: "several" }] })))
      .toBe("manifest-undecodable");
    expect(reasonOf(validated({ attributes: [{ ...spec, unique: "sometimes" }] })))
      .toBe("manifest-undecodable");

    expect(reasonOf(validated({ attributes: [{ ...spec, ident: ":item/absent" }] })))
      .toBe("manifest-invariant");
  });

  test("local ids inside the bootstrap range are refused", () => {

    expect(reasonOf(validated({ attributeIds: [[":item/name", 1], [":item/friend", 1003]] })))
      .toBe("manifest-invariant");
    expect(reasonOf(validated({ entityIds: [[opaque("e"), 0], [opaque("f"), 1001]] })))
      .toBe("manifest-invariant");
    expect(reasonOf(validated({ entityIds: [[opaque("e"), FIRST_USER_EID - 1], [opaque("f"), 1001]] })))
      .toBe("manifest-invariant");
  });

  test("the stored journal must be complete: the next change rebuilds from it", () => {
    const base = { entity: opaque("e"), field: ":item/name" };

    expect(reasonOf(validated({
      datoms: [{ ...base, value: { type: "string", value: "x" }, op: "retract" }],
    }))).toBe("manifest-undecodable");
    for (
      const value of [
        undefined,
        null,
        { type: "string", value: 7 },
        { type: "long", value: 1.5 },
        { type: "double", value: "infinity" },
        { type: "boolean", value: "true" },
        { type: "instant", value: "2026-01-01" },
        { type: "geo", value: "x" },
      ]
    ) {
      expect(reasonOf(validated({ datoms: [{ ...base, value, op: "add" }] })))
        .toBe("manifest-undecodable");
    }

    for (const value of ["%%%", "AAA", "a===", "AA=A"]) {
      expect(reasonOf(validated({ datoms: [{ ...base, value: { type: "bytes", value }, op: "add" }] })))
        .toBe("manifest-undecodable");
    }

    for (
      const value of [
        { type: "string", value: "x" },
        { type: "long", value: 7 },
        { type: "double", value: 1.5 },
        { type: "double", value: "positive-infinity" },
        { type: "double", value: "negative-infinity" },
        { type: "boolean", value: true },
        { type: "uuid", value: "e5b8f0ec-0000-4000-8000-000000000000" },
        { type: "instant", value: 1 },
        { type: "bytes", value: "AAAA" },
        { type: "ref", value: opaque("f") },
      ]
    ) {
      expect(Result.isSuccess(validated({ datoms: [{ ...base, value, op: "add" }] }))).toBe(true);
    }
  });

  test("the claimed identity is readable before anything else about the record is", () => {
    expect(replicaManifestIdentity(manifest())).toMatchObject({ server: opaque("s") });
    expect(replicaManifestIdentity({ identity: "not a record" })).toBeUndefined();
    expect(replicaManifestIdentity(undefined)).toBeUndefined();
  });

  test("a partly damaged identity is never handed out for comparison", () => {

    for (
      const damaged of [
        { ...identity(), graphLineage: undefined },
        { ...identity(), graphLineage: [7] },
        { ...identity(), authenticator: undefined },
        { ...identity(), version: 2 },
      ]
    ) {
      expect(replicaManifestIdentity({ ...manifest(), identity: damaged })).toBeUndefined();
      expect(reasonOf(validated({ identity: damaged }))).toBe("manifest-undecodable");
    }
  });

  test("the quarantine fingerprint changes with the manifest it names", () => {
    const stored = manifest();
    expect(replicaManifestFingerprint(stored)).toBe(replicaManifestFingerprint({ ...stored }));

    expect(replicaManifestFingerprint({ ...stored, revision: opaque("R") }))
      .not.toBe(replicaManifestFingerprint(stored));
    expect(replicaManifestFingerprint({
      ...stored,
      roots: roots({ eavt: ref({ hash: hash("9"), count: 4 }) }),
    })).not.toBe(replicaManifestFingerprint(stored));

    for (
      const repaired of [
        { ...stored, datoms: [] },
        { ...stored, entityIds: [[opaque("e"), 1000]] },
        { ...stored, attributeIds: [] },
        { ...stored, attributes: [{ ident: ":item/name" }] },
        { ...stored, nextLocalId: 1005 },
        { ...stored, roots: roots({ t: 3 }) },
      ]
    ) {
      expect(replicaManifestFingerprint(repaired))
        .not.toBe(replicaManifestFingerprint(stored));
    }

    const installed = { ...stored, installId: "a".repeat(32) };
    expect(replicaManifestFingerprint(installed))
      .not.toBe(replicaManifestFingerprint({ ...installed, installId: "b".repeat(32) }));
    expect(replicaManifestFingerprint(installed))
      .not.toBe(replicaManifestFingerprint(stored));

    expect(replicaManifestFingerprint(stored))
      .toBe(replicaManifestFingerprint({ ...stored, installId: undefined }));
    expect(replicaManifestFingerprint(stored))
      .toBe(replicaManifestFingerprint({ ...stored, installId: 7 }));

    expect(replicaManifestFingerprint({ revision: 7 }))
      .toBe(replicaManifestFingerprint({ roots: "gone" }));
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

  test("a separator must be the first datom of the subtree it files", () => {
    const node = leaf([second, datom(1002, 20, "c")]);
    const reference = ref({ count: 2 });

    expect(validateReplicaNode(Index.EAVT, reference, { index: Index.EAVT, node }, second))
      .toBeUndefined();
    expect(validateReplicaNode(Index.EAVT, reference, { index: Index.EAVT, node }, first)?.reason)
      .toBe("node-invariant");

    const branch = dir([second, datom(1003, 20, "d")], [
      ref({ hash: hash("b"), count: 1 }),
      ref({ hash: hash("c"), count: 1 }),
    ]);
    expect(validateReplicaNode(Index.EAVT, ref({ kind: NodeKind.Dir, count: 2 }), {
      index: Index.EAVT,
      node: branch,
    }, second)).toBeUndefined();
    expect(validateReplicaNode(Index.EAVT, ref({ kind: NodeKind.Dir, count: 2 }), {
      index: Index.EAVT,
      node: branch,
    }, first)?.reason).toBe("node-invariant");

    expect(validateReplicaNode(Index.EAVT, ref({ count: 0 }), {
      index: Index.EAVT,
      node: leaf([]),
    })).toBeUndefined();
    expect(validateReplicaNode(Index.EAVT, ref({ count: 0 }), {
      index: Index.EAVT,
      node: leaf([]),
    }, first)?.reason).toBe("node-invariant");
  });
});

describe("whole-tree contents", () => {
  const first = datom(1000, 20, "a");
  const second = datom(1001, 20, "b");
  const digestOf = (datoms: readonly Datom[]) => {
    const digest = emptyReplicaIndexDigest();
    digestReplicaDatoms(digest, datoms);
    return digest;
  };

  test("the fold is order independent and sees a changed value", () => {
    expect(sameReplicaIndexContents(digestOf([first, second]), digestOf([second, first])))
      .toBe(true);

    expect(sameReplicaIndexContents(
      digestOf([first, second]),
      digestOf([first, datom(1001, 20, "different")]),
    )).toBe(false);
    expect(sameReplicaIndexContents(digestOf([first]), digestOf([first, second]))).toBe(false);
    for (
      const changed of [
        { ...first, e: 1002 },
        { ...first, a: 21 },
        { ...first, t: 3 },
        { ...first, op: false },
        { ...first, vt: ValueTag.Bool, v: true },
      ] as readonly Datom[]
    ) {
      expect(sameReplicaIndexContents(digestOf([first]), digestOf([changed]))).toBe(false);
    }
  });

  test("values of every stored shape take part in the fold", () => {
    const shaped = (v: Datom["v"], vt: Datom["vt"]): Datom => ({ ...first, vt, v });
    expect(sameReplicaIndexContents(
      digestOf([shaped(1.5, ValueTag.Double)]),
      digestOf([shaped(2.5, ValueTag.Double)]),
    )).toBe(false);
    expect(sameReplicaIndexContents(
      digestOf([shaped(new Uint8Array([1, 2]), ValueTag.Bytes)]),
      digestOf([shaped(new Uint8Array([1, 3]), ValueTag.Bytes)]),
    )).toBe(false);
    expect(sameReplicaIndexContents(
      digestOf([shaped(new Uint8Array([1, 2]), ValueTag.Bytes)]),
      digestOf([shaped(new Uint8Array([1, 2]), ValueTag.Bytes)]),
    )).toBe(true);
    expect(sameReplicaIndexContents(
      digestOf([shaped(true, ValueTag.Bool)]),
      digestOf([shaped(false, ValueTag.Bool)]),
    )).toBe(false);
  });

  test("each walked tree must hold the datoms the manifest describes", () => {
    const built = roots() as unknown as Roots;
    const expected = {
      0: digestOf([first, second]),
      1: digestOf([first, second]),
      2: digestOf([first]),
      3: digestOf([]),
    };

    const walked = { ...expected, 1: digestOf([second, first]) };
    expect(validateReplicaContents({ ...built, t: 2 }, walked, expected)).toBeUndefined();

    for (const index of [0, 1] as const) {
      expect(validateReplicaContents({ ...built, t: 2 }, {
        ...walked,
        [index]: digestOf([first, datom(1001, 20, "elsewhere")]),
      }, expected)?.reason).toBe("manifest-invariant");
    }

    expect(validateReplicaContents({ ...built, t: 2 }, {
      ...walked,
      2: digestOf([second]),
    }, expected)?.reason).toBe("manifest-invariant");
    expect(validateReplicaContents({ ...built, t: 2 }, {
      ...walked,
      3: digestOf([first]),
    }, expected)?.reason).toBe("manifest-invariant");
  });

  test("the journal, the id maps, and the stored schema derive the expected trees", () => {
    const stored = (overrides: Record<string, unknown> = {}) => {
      const result = validateReplicaManifest(manifest({
        attributes: [{
          ident: ":item/name",
          valueType: ValueTag.Str,
          cardinality: "one",
          index: true,
          isComponent: false,
          optional: false,
        }, {
          ident: ":item/friend",
          valueType: ValueTag.Ref,
          cardinality: "one",
          index: false,
          isComponent: false,
          optional: false,
        }],
        ...overrides,
      }), {
        partition: replicaPartitionKey(identity()),
        readCompatibilityHash: READ_COMPATIBILITY,
      });
      if (Result.isFailure(result)) throw new Error(`manifest rejected: ${result.failure.detail}`);
      return expectedReplicaContents(result.success);
    };

    const base = stored();
    expect(Result.isSuccess(base)).toBe(true);
    if (!Result.isSuccess(base)) return;

    expect(base.success[0].datoms).toBe(base.success[1].datoms);
    expect(base.success[0].datoms).toBeGreaterThan(base.success[2].datoms);
    expect(base.success[2].datoms).toBeGreaterThan(0);
    expect(base.success[3].datoms).toBe(1);
    expect(base.success[0].basis).toBe(2);

    const drifted = stored({
      datoms: [
        { entity: opaque("e"), field: ":item/name", value: { type: "string", value: "other" }, op: "add" },
        { entity: opaque("e"), field: ":item/friend", value: { type: "ref", value: opaque("f") }, op: "add" },
      ],
    });
    if (!Result.isSuccess(drifted)) throw new Error("expected a derivable manifest");
    expect(sameReplicaIndexContents(base.success[0], drifted.success[0])).toBe(false);

    const renumbered = stored({
      entityIds: [[opaque("e"), 1004], [opaque("f"), 1005]],
      nextLocalId: 1006,
    });
    if (!Result.isSuccess(renumbered)) throw new Error("expected a derivable manifest");
    expect(sameReplicaIndexContents(base.success[0], renumbered.success[0])).toBe(false);

    const mistyped = stored({
      datoms: [{
        entity: opaque("e"),
        field: ":item/name",
        value: { type: "long", value: 7 },
        op: "add",
      }],
    });
    expect(Result.isFailure(mistyped)).toBe(true);
    if (Result.isFailure(mistyped)) expect(mistyped.failure.reason).toBe("manifest-invariant");
  });

  test("the manifest basis must be the basis the trees actually hold", () => {
    const built = roots() as unknown as Roots;
    const digests = {
      0: digestOf([first, second]),
      1: digestOf([first, second]),
      2: digestOf([]),
      3: digestOf([]),
    };

    expect(validateReplicaContents({ ...built, t: 1 }, digests, digests)?.reason)
      .toBe("manifest-invariant");
    expect(validateReplicaContents({ ...built, t: 3 }, digests, digests)?.reason)
      .toBe("manifest-invariant");
    expect(validateReplicaContents({ ...built, t: 2 }, digests, digests)).toBeUndefined();
  });
});
