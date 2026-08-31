import { describe, expect, test } from "bun:test";
import { ReadCompatibilityHash } from "../../../src/internal/authorization/identities.ts";
import type { ReplicationIdentity } from "../../../src/internal/replication/protocol.ts";
import {
  classifyReplicationAdoption,
  classifyReplicationCandidateFrame,
  classifyReplicationChange,
  replicationTerminalSnapshot,
} from "../../../src/internal/replication/session.ts";
import { snapshotChunk, changeFrame } from "../../replication-fixtures.ts";

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
const change = (from: string, revision: string) => (changeFrame({
  type: "Change" as const,
  protocol: 2 as const,
  identity,
  from,
  revision,
  ordinal: 2,
  datoms: [],
}));

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

describe("committed publication monotonicity", () => {
  const rotated: ReplicationIdentity = { ...identity, readView: opaque("w") };
  const published = { identity, ordinal: 4 };

  test("refuses only an ordinal this partition has already advanced past", () => {
    expect(classifyReplicationAdoption(undefined, { identity, ordinal: 1 }))
      .toBe("adopt");
    expect(classifyReplicationAdoption(published, { identity, ordinal: 3 }))
      .toBe("refuse");
    expect(classifyReplicationAdoption(published, { identity, ordinal: 4 }))
      .toBe("adopt");
    expect(classifyReplicationAdoption(published, { identity, ordinal: 5 }))
      .toBe("adopt");
  });

  test("a rotated read view starts a new lineage the published ordinal cannot refuse", () => {
    expect(classifyReplicationAdoption(published, { identity: rotated, ordinal: 1 }))
      .toBe("adopt");
    expect(classifyReplicationAdoption({ identity: rotated, ordinal: 9 }, {
      identity,
      ordinal: 1,
    })).toBe("adopt");
  });
});

test("protocol terminal reasons remain observable to later reconnect policy", () => {
  expect(replicationTerminalSnapshot({
    type: "TerminalError", protocol: 2, identity, code: "closed",
  })).toEqual({ status: "terminal", terminalCode: "closed" });
  expect(replicationTerminalSnapshot({
    type: "TerminalError", protocol: 2, code: "incompatible-version",
  })).toEqual({ status: "terminal", terminalCode: "incompatible-version" });
  expect(replicationTerminalSnapshot({
    type: "TerminalError", protocol: 2, code: "update-required",
  })).toEqual({ status: "terminal", terminalCode: "update-required" });
});

describe("metadata-only cache candidate confirmation", () => {
  const revision = opaque("1");
  const candidate = { identity, revision };

  test("accepts only frames that establish a valid initial transition", () => {
    expect(classifyReplicationCandidateFrame(candidate, {
      type: "ResumeReady", protocol: 2, identity, revision,
    })).toBe("resume");
    expect(classifyReplicationCandidateFrame(candidate, change(revision, opaque("2"))))
      .toBe("change");
    expect(classifyReplicationCandidateFrame(candidate, change(opaque("0"), revision)))
      .toBe("duplicate");
    expect(classifyReplicationCandidateFrame(candidate, change(opaque("0"), opaque("2"))))
      .toBe("invalid");
    expect(classifyReplicationCandidateFrame(undefined, {
      type: "Reset", protocol: 2, identity,
    })).toBe("reset");
    expect(classifyReplicationCandidateFrame(undefined, {
      type: "SnapshotStart", protocol: 2, identity,
      snapshot: opaque("s"), revision,
    })).toBe("snapshot");
  });

  test("snapshot fragments, mismatched resumes, and unseeded liveness fail closed", () => {
    const other = { ...identity, principal: opaque("o") };
    expect(classifyReplicationCandidateFrame(candidate, snapshotChunk({
      type: "SnapshotChunk", protocol: 2, identity,
      snapshot: opaque("s"), index: 0, datoms: [],
    }))).toBe("invalid");
    expect(classifyReplicationCandidateFrame(candidate, {
      type: "SnapshotCommit", protocol: 2, identity,
      snapshot: opaque("s"), revision, ordinal: 1, chunks: 0,
    })).toBe("invalid");
    expect(classifyReplicationCandidateFrame(candidate, {
      type: "ResumeReady", protocol: 2, identity: other, revision,
    })).toBe("invalid");
    expect(classifyReplicationCandidateFrame(undefined, {
      type: "KeepAlive", protocol: 2, identity,
    })).toBe("invalid");
    expect(classifyReplicationCandidateFrame(candidate, {
      type: "TerminalError", protocol: 2, code: "closed",
    })).toBe("invalid");
  });
});
