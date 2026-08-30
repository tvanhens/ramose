import { describe, expect, test } from "bun:test";
import {
  identityNotice,
  isReplicaNotice,
  platformBroadcast,
  replicaNotice,
  replicaNoticeChannelName,
  ReplicaNoticeChannel,
  type ReplicaNotice,
} from "../../../src/internal/replication/notices.ts";
import { ReadCompatibilityHash } from "../../../src/internal/authorization/identities.ts";
import type { ReplicationIdentity } from "../../../src/internal/replication/protocol.ts";
import {
  replicaDatabaseKey,
  replicaScopeKey,
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

const identity = (
  overrides: Partial<ReplicationIdentity> = {},
): ReplicationIdentity => ({
  version: 1,
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: ReadCompatibilityHash.make(opaque("k")),
  graphLineage: [],
  authenticator: opaque("a"),
  ...overrides,
});

describe("notice channel naming", () => {
  test("one channel covers one storage namespace", () => {
    const name = replicaNoticeChannelName("ramose-replicas");
    expect(replicaNoticeChannelName("ramose-replicas")).toBe(name);
    expect(replicaNoticeChannelName("other")).not.toBe(name);
  });

  test("a storage name that needs encoding still names one channel", () => {
    expect(replicaNoticeChannelName("a b:c")).toBe(
      replicaNoticeChannelName("a b:c"),
    );
    expect(replicaNoticeChannelName("a:b")).not.toBe(
      replicaNoticeChannelName("a%3Ab"),
    );
  });
});

describe("notices", () => {
  test("a notice carries durable keys and no value", () => {
    const notice = replicaNotice("replica", scope(), scope());
    expect(notice).toEqual({
      kind: "replica",
      scope: replicaScopeKey(scope()),
      database: replicaDatabaseKey(scope()),
    });
    expect(Object.keys(notice).sort()).toEqual(["database", "kind", "scope"]);
  });

  test("a scope notice names no database", () => {
    expect(replicaNotice("reset", scope())).toEqual({
      kind: "reset",
      scope: replicaScopeKey(scope()),
    });
  });

  test("an identity names the scope and database it changed", () => {
    expect(identityNotice("selector", identity())).toEqual(
      replicaNotice("selector", scope(), scope()),
    );
    expect(identityNotice("selector", identity({ database: opaque("e") })))
      .not.toEqual(identityNotice("selector", identity()));
  });

  test("only a well formed notice of a known kind is one", () => {
    expect(isReplicaNotice(replicaNotice("layer", scope(), scope()))).toBe(true);
    for (
      const value of [
        undefined,
        null,
        "layer",
        {},
        { kind: "layer" },
        { kind: "unknown", scope: "s" },
        { kind: "layer", scope: "" },
        { kind: "layer", scope: 1 },
        { kind: "layer", scope: "s", database: 2 },
      ]
    ) {
      expect(isReplicaNotice(value)).toBe(false);
    }
  });
});

describe("a runtime without BroadcastChannel", () => {
  test("posts nothing and delivers nothing", () => {
    const channel = ReplicaNoticeChannel.begin({
      name: replicaNoticeChannelName("ramose-replicas"),
      broadcast: undefined,
    });
    const seen: ReplicaNotice[] = [];
    const release = channel.subscribe((notice) => seen.push(notice));
    expect(channel.announces()).toBe(false);
    channel.post(replicaNotice("replica", scope(), scope()));
    expect(seen).toEqual([]);
    release();
    channel.close();
  });

  test("a closed channel takes no further listener", () => {
    const channel = ReplicaNoticeChannel.begin({
      name: replicaNoticeChannelName("ramose-replicas"),
      broadcast: platformBroadcast(),
    });
    channel.close();
    let delivered = 0;
    channel.subscribe(() => {
      delivered++;
    })();
    channel.post(replicaNotice("replica", scope(), scope()));
    expect(delivered).toBe(0);
    channel.close();
  });
});
