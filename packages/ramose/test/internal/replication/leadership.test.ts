import { describe, expect, test } from "bun:test";
import {
  isLeadershipKey,
  replicaLeaderKey,
  SyncLeadership,
} from "../../../src/internal/replication/leadership.ts";
import {
  replicaDatabaseKey,
  type ReplicaDatabaseScope,
} from "../../../src/internal/replication/replica-lifecycle.ts";

const opaque = (character: string): string => character.repeat(43);

const scope = (
  overrides: Partial<ReplicaDatabaseScope> = {},
): ReplicaDatabaseScope => ({
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
  ...overrides,
});

const settled = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

describe("leadership naming", () => {
  test("one name covers one server, root database, and principal", () => {
    const name = replicaLeaderKey(scope(), "ramose-replicas");
    expect(name).toContain(replicaDatabaseKey(scope()));
    expect(replicaLeaderKey(scope(), "ramose-replicas")).toBe(name);
    for (const other of [
      scope({ server: opaque("t") }),
      scope({ principal: opaque("q") }),
      scope({ database: opaque("e") }),
    ]) {
      expect(replicaLeaderKey(other, "ramose-replicas")).not.toBe(name);
    }
  });

  test("clients that do not share a storage namespace do not share a leader", () => {
    expect(replicaLeaderKey(scope(), "ramose-replicas")).not.toBe(
      replicaLeaderKey(scope(), "another-namespace"),
    );
    expect(replicaLeaderKey(scope(), "a:b")).not.toBe(
      replicaLeaderKey(scope(), "a"),
    );
  });

  test("a leadership fence is told apart from every other generation", () => {
    expect(isLeadershipKey(replicaLeaderKey(scope(), "ramose-replicas"))).toBe(true);
    expect(isLeadershipKey(replicaDatabaseKey(scope()))).toBe(false);
  });
});

describe("leadership without web locks", () => {
  test("every tab submits for itself and carries no epoch to depose", async () => {
    let claims = 0;
    let leading = 0;
    const leadership = SyncLeadership.begin({
      name: replicaLeaderKey(scope(), "ramose-replicas"),
      locks: undefined,
      claim: () => {
        claims++;
        return Promise.resolve(1);
      },
      onLeading: () => {
        leading++;
      },
    });
    await settled();

    expect(leadership.status()).toBe("unelected");
    expect(leadership.submits()).toBe(true);
    expect(leadership.fence()).toBeUndefined();
    expect([claims, leading]).toEqual([0, 1]);

    await leadership.release();
    expect(leadership.status()).toBe("released");
    expect(leadership.submits()).toBe(false);
  });

  test("an unelected tab has no epoch to stand down from and keeps submitting", async () => {
    let claims = 0;
    const leadership = SyncLeadership.begin({
      name: replicaLeaderKey(scope(), "ramose-replicas"),
      locks: undefined,
      claim: () => {
        claims++;
        return Promise.resolve(1);
      },
      onLeading: () => undefined,
    });
    await settled();

    await leadership.standDown();
    expect([leadership.status(), leadership.submits(), claims]).toEqual([
      "unelected",
      true,
      0,
    ]);
    await leadership.release();
  });

  test("a tab released before it leads never announces leadership", async () => {
    let leading = 0;
    const leadership = SyncLeadership.begin({
      name: replicaLeaderKey(scope(), "ramose-replicas"),
      locks: undefined,
      claim: () => Promise.resolve(1),
      onLeading: () => {
        leading++;
      },
    });
    await leadership.release();
    await settled();

    expect(leading).toBe(0);
    expect(leadership.submits()).toBe(false);
  });
});
