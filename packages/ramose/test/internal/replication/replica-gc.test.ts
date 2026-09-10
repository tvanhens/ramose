import { describe, expect, test } from "bun:test";
import {
  classifyReplicaStorageFailure,
  ReplicaQuotaExhaustedError,
  ReplicaReachability,
  replicaQuotaRecovery,
  replicaSweepKey,
  replicaSweepPrefix,
  stagingIsSweepable,
  supersededPartitions,
  unreachableNodeHashes,
} from "../../../src/internal/replication/replica-gc.ts";
import {
  replicaPartitionDatabasePrefix,
  replicaPartitionScopeKey,
} from "../../../src/internal/replication/replica-lifecycle.ts";

const walkAll = (
  roots: readonly string[],
  graph: Readonly<Record<string, readonly string[]>>,
  unreadable: ReadonlySet<string> = new Set(),
  batch = 2,
): ReplicaReachability => {
  const walk = new ReplicaReachability(roots);
  while (walk.pending) {
    for (const hash of walk.next(batch)) {
      if (unreadable.has(hash)) {
        walk.fail();
        return walk;
      }
      walk.expand(graph[hash] ?? []);
    }
  }
  return walk;
};

describe("reachability", () => {
  test("reaches every node a root transitively references", () => {
    const walk = walkAll(["r"], { r: ["a", "b"], a: ["c"], b: ["c", "d"] });
    expect(walk.complete).toBe(true);
    expect([...walk.reachable].sort()).toEqual(["a", "b", "c", "d", "r"]);
  });

  test("visits a shared address once and terminates on a cycle", () => {
    const expanded: string[] = [];
    const walk = new ReplicaReachability(["r", "r"]);
    while (walk.pending) {
      for (const hash of walk.next(4)) {
        expanded.push(hash);
        walk.expand(hash === "r" ? ["a"] : ["r", "a"]);
      }
    }
    expect(expanded).toEqual(["r", "a"]);
    expect(walk.complete).toBe(true);
  });

  test("several root sets contribute to one live set", () => {
    const walk = walkAll(["old", "new"], { old: ["shared", "stale"], new: ["shared", "fresh"] });
    expect([...walk.reachable].sort()).toEqual(["fresh", "new", "old", "shared", "stale"]);
  });

  test("a node that cannot be read leaves the walk incomplete", () => {
    const walk = walkAll(["r"], { r: ["a", "b"], a: [], b: [] }, new Set(["b"]));
    expect(walk.complete).toBe(false);

    expect(walk.reachable.has("r")).toBe(true);
  });

  test("an empty root set reaches nothing and is still complete", () => {
    const walk = walkAll([], {});
    expect(walk.complete).toBe(true);
    expect(walk.reachable.size).toBe(0);
  });
});

describe("sweep selection", () => {
  test("keeps every live address and sweeps exactly the rest", () => {
    expect(new Set(unreachableNodeHashes(["a", "b", "c", "d"], new Set(["b", "d"]))))
      .toEqual(new Set(["a", "c"]));
  });

  test("sweeps nothing when every stored address is live", () => {
    expect(unreachableNodeHashes(["a", "b"], new Set(["a", "b"]))).toEqual([]);
  });

  test("a repeated stored address yields one deletion", () => {
    expect(unreachableNodeHashes(["a", "a"], new Set())).toEqual(["a"]);
  });

  test("everything is garbage once no root set names the partition", () => {
    expect(unreachableNodeHashes(["a", "b"], new Set())).toEqual(["a", "b"]);
  });
});

describe("supersession", () => {
  const rotated = "ramose-replica-v6:s:p:d:w:h";
  const original = "ramose-replica-v6:s:p:d:v:h";

  test("a partition nothing references loses to a confirmed one over the same database", () => {
    expect([...supersededPartitions([original, rotated], new Set([rotated]))])
      .toEqual([original]);
  });

  test("the confirmed partition is never superseded by itself", () => {
    expect(supersededPartitions([rotated], new Set([rotated])).size).toBe(0);
  });

  test("nothing is superseded while the database has no confirmed partition", () => {
    expect(supersededPartitions([original, rotated], new Set()).size).toBe(0);
    expect(
      supersededPartitions([original], new Set(["ramose-replica-v6:s:p:e:v:h"])).size,
    ).toBe(0);
  });

  test("a confirmation for another principal or server supersedes nothing", () => {
    for (const other of ["ramose-replica-v6:s:q:d:v:h", "ramose-replica-v6:t:p:d:v:h"]) {
      expect(supersededPartitions([original], new Set([other])).size).toBe(0);
    }
  });

  test("two confirmed read views over one database keep each other alive", () => {
    expect(supersededPartitions([original, rotated], new Set([original, rotated])).size)
      .toBe(0);
  });

  test("a key that is not a partition key is never superseded and confirms nothing", () => {
    expect(supersededPartitions(["ramose-replica-v6:s:p:d:v"], new Set([rotated])).size)
      .toBe(0);
    expect(supersededPartitions([original], new Set(["ramose-replica-v2:s:p:d:v:h"])).size)
      .toBe(0);
  });

  test("a partition key names the database prefix that owns it", () => {
    expect(replicaPartitionDatabasePrefix(original))
      .toBe("ramose-replica-v6:s:p:d:");
    expect(replicaPartitionDatabasePrefix("ramose-replica-v6:s:p:d:v")).toBeUndefined();
    expect(replicaPartitionDatabasePrefix("")).toBeUndefined();
  });
});

describe("staging", () => {
  test("staging whose base has moved can never commit and is swept", () => {
    expect(stagingIsSweepable({ baseRevision: "r1" }, "r2")).toBe(true);
    expect(stagingIsSweepable({ baseRevision: "r1" }, null)).toBe(true);
    expect(stagingIsSweepable({ baseRevision: null }, "r1")).toBe(true);
  });

  test("staging still opened against the committed base is left alone", () => {
    expect(stagingIsSweepable({ baseRevision: "r1" }, "r1")).toBe(false);

    expect(stagingIsSweepable({ baseRevision: null }, null)).toBe(false);
  });

  test("a partition with no staging has nothing to sweep", () => {
    expect(stagingIsSweepable(undefined, "r1")).toBe(false);
  });
});

describe("quota classification", () => {
  test("the specified name is a quota exhaustion", () => {
    expect(classifyReplicaStorageFailure(new DOMException("full", "QuotaExceededError")))
      .toBe("quota");
  });

  test("the historical browser spellings are quota exhaustions", () => {
    for (const name of ["NS_ERROR_DOM_QUOTA_REACHED", "QUOTA_EXCEEDED_ERR"]) {
      expect(classifyReplicaStorageFailure(new DOMException("full", name))).toBe("quota");
    }

    expect(classifyReplicaStorageFailure({ name: "Error", code: 22 })).toBe("quota");
    expect(classifyReplicaStorageFailure({ name: "Error", code: 1014 })).toBe("quota");
  });

  test("every other failure is unrelated and must propagate", () => {
    expect(classifyReplicaStorageFailure(new DOMException("gone", "AbortError")))
      .toBe("unrelated");
    expect(classifyReplicaStorageFailure(new DOMException("nope", "ConstraintError")))
      .toBe("unrelated");
    expect(classifyReplicaStorageFailure(new Error("quota exceeded"))).toBe("unrelated");
    expect(classifyReplicaStorageFailure({ name: "Error", code: 23 })).toBe("unrelated");
    expect(classifyReplicaStorageFailure(undefined)).toBe("unrelated");
    expect(classifyReplicaStorageFailure(null)).toBe("unrelated");
    expect(classifyReplicaStorageFailure("QuotaExceededError")).toBe("unrelated");
  });

  test("message text alone never makes a failure recoverable", () => {
    const misleading = new Error("QuotaExceededError: NS_ERROR_DOM_QUOTA_REACHED");
    expect(classifyReplicaStorageFailure(misleading)).toBe("unrelated");
  });
});

describe("bounded recovery", () => {
  test("the first exhaustion reclaims and retries", () => {
    expect(replicaQuotaRecovery(1, "quota")).toBe("reclaim");
  });

  test("the second exhaustion gives up rather than sweeping again", () => {
    expect(replicaQuotaRecovery(2, "quota")).toBe("exhausted");
    expect(replicaQuotaRecovery(3, "quota")).toBe("exhausted");
  });

  test("an unrelated failure never reclaims, at any attempt", () => {
    expect(replicaQuotaRecovery(1, "unrelated")).toBe("propagate");
    expect(replicaQuotaRecovery(2, "unrelated")).toBe("propagate");
  });

  test("exhaustion is a typed outcome carrying what the one pass reclaimed", () => {
    const error = new ReplicaQuotaExhaustedError({ partition: "p", reclaimedNodes: 7 });
    expect(error._tag).toBe("ReplicaQuotaExhaustedError");
    expect(error.reclaimedNodes).toBe(7);
  });
});

describe("keys", () => {
  test("the sweep generation is keyed by partition and storage version", () => {
    expect(replicaSweepKey("ramose-replica-v6:s:p:d:v:h"))
      .toBe("ramose-replica-sweep-v6:ramose-replica-v6:s:p:d:v:h");
  });

  test("one prefix covers every sweep record under a partition prefix", () => {
    const prefix = replicaSweepPrefix("ramose-replica-v6:s:p:");
    expect(prefix).toBe("ramose-replica-sweep-v6:ramose-replica-v6:s:p:");

    expect(replicaSweepKey("ramose-replica-v6:s:p:d:v:h").startsWith(prefix)).toBe(true);
    expect(replicaSweepKey("ramose-replica-v6:s:q:d:v:h").startsWith(prefix)).toBe(false);
  });

  test("a partition key names the scope that owns it", () => {
    expect(replicaPartitionScopeKey("ramose-replica-v6:s:p:d:v:h"))
      .toBe("ramose-replica-scope-v2:s:p");
  });

  test("anything that is not a partition key owns no scope", () => {
    expect(replicaPartitionScopeKey("ramose-replica-v6:s:p:d:v")).toBeUndefined();
    expect(replicaPartitionScopeKey("ramose-replica-v6:s:p:d:v:h:extra")).toBeUndefined();
    expect(replicaPartitionScopeKey("ramose-replica-v2:s:p:d:v:h")).toBeUndefined();
    expect(replicaPartitionScopeKey("")).toBeUndefined();
  });
});
