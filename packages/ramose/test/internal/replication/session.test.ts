import { describe, expect, test } from "bun:test";
import { ReadCompatibilityHash } from "../../../src/internal/authorization/identities.ts";
import type { ReplicationIdentity } from "../../../src/internal/replication/protocol.ts";
import {
  classifyCandidateFrame,
  classifyReplicationChange,
  replicationTerminalSnapshot,
} from "../../../src/internal/replication/session.ts";

const opaque = (character: string): string => character.repeat(43);
const identity: ReplicationIdentity = {
  version: 1,
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: ReadCompatibilityHash.make(opaque("k")),
  authenticator: opaque("a"),
};
const change = (from: string, revision: string) => ({
  type: "Change" as const,
  protocol: 1 as const,
  identity,
  from,
  revision,
  datoms: [],
});

describe("changed-bearer candidate fence", () => {
  const candidate = { identity, revision: opaque("1") };
  test("requires exact identity and revision continuity", () => {
    expect(classifyCandidateFrame(candidate, {
      type: "ResumeReady", protocol: 1, identity, revision: opaque("1"),
    })).toBe("current");
    expect(classifyCandidateFrame(candidate, change(opaque("1"), opaque("2"))))
      .toBe("apply-change");
    expect(classifyCandidateFrame(candidate, change(opaque("0"), opaque("1"))))
      .toBe("current");
    expect(classifyCandidateFrame(candidate, change(opaque("0"), opaque("2"))))
      .toBe("mismatch");
    expect(classifyCandidateFrame(candidate, {
      type: "ResumeReady", protocol: 1,
      identity: { ...identity, principal: opaque("x") }, revision: opaque("1"),
    })).toBe("mismatch");
  });

  test("reset and snapshot confirmation are stale; terminals disclose nothing", () => {
    expect(classifyCandidateFrame(candidate, {
      type: "Reset", protocol: 1, identity,
    })).toBe("publish-stale");
    expect(classifyCandidateFrame(candidate, {
      type: "SnapshotStart", protocol: 1, identity,
      snapshot: opaque("s"), revision: opaque("2"),
    })).toBe("publish-stale");
    expect(classifyCandidateFrame(candidate, {
      type: "TerminalError", protocol: 1, code: "update-required",
    })).toBe("wait");
  });
});

describe("replication change sequencing", () => {
  test("distinguishes an exact duplicate from a gap", () => {
    const prior = { identity, revision: opaque("1") };
    expect(classifyReplicationChange(prior, change(opaque("0"), opaque("1"))))
      .toBe("duplicate");
    expect(classifyReplicationChange(prior, change(opaque("0"), opaque("2"))))
      .toBe("gap");
    expect(classifyReplicationChange(prior, change(opaque("1"), opaque("2"))))
      .toBe("apply");
  });
});

test("protocol terminal reasons remain observable to later reconnect policy", () => {
  expect(replicationTerminalSnapshot({
    type: "TerminalError", protocol: 1, identity, code: "closed",
  })).toEqual({ status: "terminal", terminalCode: "closed" });
  expect(replicationTerminalSnapshot({
    type: "TerminalError", protocol: 1, code: "incompatible-version",
  })).toEqual({ status: "terminal", terminalCode: "incompatible-version" });
  expect(replicationTerminalSnapshot({
    type: "TerminalError", protocol: 1, code: "update-required",
  })).toEqual({ status: "terminal", terminalCode: "update-required" });
});
