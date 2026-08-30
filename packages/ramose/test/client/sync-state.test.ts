import { describe, expect, test } from "bun:test";
import { ReadCompatibilityHash } from "../../src/internal/authorization/identities.ts";
import type { Db } from "../../src/internal/core/db.ts";
import type { ReplicationIdentity } from "../../src/internal/replication/protocol.ts";
import type { ReplicationSessionSnapshot } from "../../src/internal/replication/session.ts";
import { readSessionSnapshot } from "../../src/client/database.ts";

const opaque = (character: string): string => character.repeat(43);

const identity: ReplicationIdentity = {
  version: 1,
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: ReadCompatibilityHash.make(opaque("k")),
  graphLineage: [],
  authenticator: opaque("a"),
};

const value = (stale: boolean) => ({
  db: {} as Db,
  identity,
  revision: opaque("r"),
  handles: new Map<string, number>(),
  stale,
});

const read = (snapshot: ReplicationSessionSnapshot) => readSessionSnapshot(snapshot);

describe("readSessionSnapshot", () => {
  test("reports what the application can do with the value in hand", () => {
    expect(read({ status: "connecting" }))
      .toEqual({ status: "connecting", publishes: true });
    expect(read({ status: "connecting", value: value(true) }))
      .toEqual({ status: "stale", publishes: true });
    expect(read({ status: "open", value: value(false) }))
      .toEqual({ status: "live", publishes: true });
    expect(read({ status: "open", value: value(true) }))
      .toEqual({ status: "stale", publishes: true });
  });

  test("keeps a confirmed value readable when the server is merely unreachable", () => {

    expect(read({ status: "failed", failure: "transport", value: value(false) }))
      .toEqual({ status: "offline", publishes: true });
    expect(read({ status: "terminal", value: value(false) }))
      .toEqual({ status: "offline", publishes: true });
    expect(read({ status: "terminal", terminalCode: "closed", value: value(false) }))
      .toEqual({ status: "offline", publishes: true });
  });

  test("fences the value when the server itself refuses it", () => {

    expect(read({ status: "failed", failure: "unauthorized", value: value(false) }))
      .toEqual({ status: "authentication-required", publishes: false });

    expect(read({
      status: "terminal",
      terminalCode: "update-required",
      value: value(false),
    })).toEqual({ status: "update-required", publishes: false });
    expect(read({
      status: "terminal",
      terminalCode: "incompatible-version",
      value: value(false),
    })).toEqual({ status: "update-required", publishes: false });
  });

  test("a closed session publishes nothing", () => {
    expect(read({ status: "closed", value: value(false) }))
      .toEqual({ status: "closed", publishes: false });
  });
});
