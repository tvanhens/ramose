/**
 * How a client reads one replication session snapshot (#477 slice 1).
 *
 * Every branch here decides what an application is allowed to read, and two of
 * them are the difference between a revoked principal seeing nothing and seeing
 * its cached rows indefinitely. That is a pure transition over ordinary input
 * values, so it is stated here rather than only where a network can be
 * persuaded to produce it.
 */

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

/** A value is only ever forwarded or dropped here, never read. */
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
    // A transport failure and a stream that simply ended are not authorization
    // answers, so whatever was confirmed stays readable.
    expect(read({ status: "failed", failure: "transport", value: value(false) }))
      .toEqual({ status: "offline", publishes: true });
    expect(read({ status: "terminal", value: value(false) }))
      .toEqual({ status: "offline", publishes: true });
    expect(read({ status: "terminal", terminalCode: "closed", value: value(false) }))
      .toEqual({ status: "offline", publishes: true });
  });

  test("fences the value when the server itself refuses it", () => {
    // A refused credential is the server's own answer: a revoked or expired
    // principal must not keep reading the partition that credential opened.
    expect(read({ status: "failed", failure: "unauthorized", value: value(false) }))
      .toEqual({ status: "authentication-required", publishes: false });
    // A rotated authorized view or protocol is the same kind of answer: this
    // build cannot read what the server serves, so it publishes nothing.
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
