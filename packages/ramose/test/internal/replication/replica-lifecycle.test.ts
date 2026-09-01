import { describe, expect, test } from "bun:test";
import { ReadCompatibilityHash } from "../../../src/internal/authorization/identities.ts";
import type { ReplicationIdentity } from "../../../src/internal/replication/protocol.ts";
import {
  identityInDatabase,
  identityInScope,
  ReplicaFencedError,
  ReplicaLease,
  replicaDatabaseKey,
  replicaDatabasePartitionPrefix,
  replicaDatabaseScopeOf,
  replicaFenceDecision,
  replicaPartitionKey,
  replicaScopeKey,
  replicaScopeOf,
  replicaScopePartitionPrefix,
  withConfirmedScope,
  withoutConfirmedScope,
} from "../../../src/internal/replication/replica-lifecycle.ts";

const opaque = (character: string): string => character.repeat(43);

const identity = (overrides: Partial<ReplicationIdentity> = {}): ReplicationIdentity => ({
  version: 1,
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: ReadCompatibilityHash.make(opaque("k")),
  authenticator: opaque("a"),
  ...overrides,
});

describe("replica lifecycle scope selection", () => {
  test("a scope is named only by the server-minted server and principal", () => {
    const selected = identity();
    expect(replicaScopeOf(selected)).toEqual({
      server: opaque("s"),
      principal: opaque("p"),
    });
    expect(replicaDatabaseScopeOf(selected)).toEqual({
      server: opaque("s"),
      principal: opaque("p"),
      database: opaque("d"),
    });

    for (
      const rotated of [
        identity({ catalog: opaque("C") }),
        identity({ readView: opaque("V") }),
        identity({ readCompatibilityHash: ReadCompatibilityHash.make(opaque("K")) }),
        identity({ authenticator: opaque("A") }),
      ]
    ) {
      expect(replicaScopeKey(replicaScopeOf(rotated)))
        .toBe(replicaScopeKey(replicaScopeOf(selected)));
      expect(replicaDatabaseKey(replicaDatabaseScopeOf(rotated)))
        .toBe(replicaDatabaseKey(replicaDatabaseScopeOf(selected)));
    }
  });

  test("scope and database keys separate principals, servers, and databases", () => {
    const base = replicaScopeKey(replicaScopeOf(identity()));
    expect(base).not.toBe(replicaScopeKey(replicaScopeOf(identity({ principal: opaque("P") }))));
    expect(base).not.toBe(replicaScopeKey(replicaScopeOf(identity({ server: opaque("S") }))));

    expect(base).not.toBe(replicaDatabaseKey(replicaDatabaseScopeOf(identity())));
    expect(replicaDatabaseKey(replicaDatabaseScopeOf(identity())))
      .not.toBe(replicaDatabaseKey(replicaDatabaseScopeOf(identity({ database: opaque("D") }))));
  });

  test("partition prefixes select exactly one scope or one database", () => {
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const scopePrefix = replicaScopePartitionPrefix(replicaScopeOf(selected));
    const databasePrefix = replicaDatabasePartitionPrefix(replicaDatabaseScopeOf(selected));
    expect(partition.startsWith(scopePrefix)).toBe(true);
    expect(partition.startsWith(databasePrefix)).toBe(true);
    expect(databasePrefix.startsWith(scopePrefix)).toBe(true);

    const sibling = replicaPartitionKey(identity({ readView: opaque("V") }));
    expect(sibling).not.toBe(partition);
    expect(sibling.startsWith(databasePrefix)).toBe(true);

    expect(replicaPartitionKey(identity({ database: opaque("D") })).startsWith(databasePrefix))
      .toBe(false);
    expect(replicaPartitionKey(identity({ principal: opaque("P") })).startsWith(scopePrefix))
      .toBe(false);
    expect(replicaPartitionKey(identity({ server: opaque("S") })).startsWith(scopePrefix))
      .toBe(false);

    expect(scopePrefix.endsWith(":")).toBe(true);
    expect(databasePrefix.endsWith(":")).toBe(true);
  });

  test("identity membership follows the same scope and database boundaries", () => {
    const scope = replicaScopeOf(identity());
    const database = replicaDatabaseScopeOf(identity());
    expect(identityInScope(identity({ database: opaque("D") }), scope)).toBe(true);
    expect(identityInDatabase(identity({ database: opaque("D") }), database)).toBe(false);
    expect(identityInDatabase(identity({ readView: opaque("V") }), database)).toBe(true);
    expect(identityInScope(identity({ principal: opaque("P") }), scope)).toBe(false);
    expect(identityInScope(identity({ server: opaque("S") }), scope)).toBe(false);
  });
});

describe("route observation confirmations", () => {
  test("confirmations accumulate, deduplicate, and withdraw one scope at a time", () => {
    const left = replicaScopeKey(replicaScopeOf(identity()));
    const right = replicaScopeKey(replicaScopeOf(identity({ principal: opaque("P") })));
    expect(withConfirmedScope(undefined, left)).toEqual([left]);
    const both = withConfirmedScope(withConfirmedScope(undefined, right), left);
    expect(both).toEqual([left, right].sort());
    expect(withConfirmedScope(both, left)).toBe(both);
    expect(withoutConfirmedScope(both, left)).toEqual([right]);
    expect(withoutConfirmedScope(withoutConfirmedScope(both, left), right)).toEqual([]);
    expect(withoutConfirmedScope(undefined, left)).toEqual([]);
  });
});

describe("generation fences", () => {
  test("trust on first use, then only the adopted generation writes", () => {
    expect(replicaFenceDecision(undefined, 0)).toBe("adopt");
    expect(replicaFenceDecision(undefined, 7)).toBe("adopt");
    expect(replicaFenceDecision(3, 3)).toBe("match");
    expect(replicaFenceDecision(3, 4)).toBe("fenced");

    expect(replicaFenceDecision(4, 3)).toBe("fenced");
  });

  test("a lease adopts each key once and refuses a bumped generation", () => {
    const lease = new ReplicaLease();
    const scope = replicaScopeKey(replicaScopeOf(identity()));
    const database = replicaDatabaseKey(replicaDatabaseScopeOf(identity()));
    expect(lease.generationOf(scope)).toBeUndefined();
    lease.observe(scope, 1);
    lease.observe(database, 1);
    expect(lease.generationOf(scope)).toBe(1);
    lease.observe(scope, 1);
    expect(() => lease.observe(scope, 2)).toThrow(ReplicaFencedError);

    expect(() => lease.observe(database, 2)).toThrow(ReplicaFencedError);
    lease.observe(database, 1);

    lease.adopt(database, 2);
    lease.observe(database, 2);
    expect(lease.generationOf(database)).toBe(2);
  });

  test("a holder admitted before a clear cannot write into the cleared scope", () => {
    const scope = replicaScopeKey(replicaScopeOf(identity()));
    const admitted = new ReplicaLease(4);

    admitted.admit(scope, 0);
    admitted.admit(scope, 4);
    expect(() => admitted.admit(scope, 5)).toThrow(ReplicaFencedError);

    const readmitted = new ReplicaLease(5);
    readmitted.admit(scope, 5);
    expect(readmitted.admittedAt()).toBe(5);
  });

  test("a holder that never read the barrier is refused by the first clear", () => {
    const scope = replicaScopeKey(replicaScopeOf(identity()));
    const lease = new ReplicaLease();
    expect(lease.admittedAt()).toBe(0);
    lease.admit(scope, 0);
    try {
      lease.admit(scope, 1);
      throw new Error("expected the barrier to refuse the holder");
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "ReplicaFencedError",
        key: scope,
        expected: 0,
        observed: 1,
      });
    }
  });

  test("a fence failure names the key and both generations", () => {
    const lease = new ReplicaLease();
    lease.observe("scope-key", 4);
    try {
      lease.observe("scope-key", 5);
      throw new Error("expected the lease to be fenced");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplicaFencedError);
      expect(error).toMatchObject({
        _tag: "ReplicaFencedError",
        key: "scope-key",
        expected: 4,
        observed: 5,
      });
    }
  });
});
