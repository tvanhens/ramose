import { describe, expect, test } from "bun:test";
import { ReadCompatibilityHash } from "../../../src/internal/authorization/identities.ts";
import type { ReplicationIdentity } from "../../../src/internal/replication/protocol.ts";
import {
  classifyReplicationAdoption,
  classifyReplicationCandidateFrame,
  classifyReplicationChange,
  REPLICATION_SUPERSEDED_MEMORY,
  replicationPublicationAfter,
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
  protocol: 1 as const,
  identity,
  from,
  revision,
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
  const numbered = (index: number): string => String(index).padStart(43, "0");
  const rotated: ReplicationIdentity = { ...identity, readView: opaque("w") };
  const advanced = replicationPublicationAfter(
    replicationPublicationAfter(undefined, { identity, revision: opaque("1") }),
    { identity, revision: opaque("2") },
  );

  test("refuses only a revision this partition already left behind", () => {
    expect(classifyReplicationAdoption(undefined, { identity, revision: opaque("1") }))
      .toBe("adopt");
    expect(classifyReplicationAdoption(advanced, { identity, revision: opaque("1") }))
      .toBe("refuse");
    expect(classifyReplicationAdoption(advanced, { identity, revision: opaque("2") }))
      .toBe("adopt");
    expect(classifyReplicationAdoption(advanced, { identity, revision: opaque("3") }))
      .toBe("adopt");
    expect(classifyReplicationAdoption(advanced, {
      identity: rotated,
      revision: opaque("1"),
    })).toBe("adopt");
  });

  test("a rotated read view starts a new lineage and remembered revisions stay bounded", () => {
    const rotation = replicationPublicationAfter(advanced, {
      identity: rotated,
      revision: opaque("1"),
    });
    expect(rotation.superseded.size).toBe(0);
    expect(classifyReplicationAdoption(rotation, { identity, revision: opaque("1") }))
      .toBe("adopt");

    let publication = replicationPublicationAfter(undefined, {
      identity,
      revision: numbered(0),
    });
    for (let index = 1; index <= REPLICATION_SUPERSEDED_MEMORY + 4; index++) {
      publication = replicationPublicationAfter(publication, {
        identity,
        revision: numbered(index),
      });
    }
    expect(publication.superseded.size).toBe(REPLICATION_SUPERSEDED_MEMORY);
    expect(classifyReplicationAdoption(publication, { identity, revision: numbered(0) }))
      .toBe("adopt");
    expect(classifyReplicationAdoption(publication, {
      identity,
      revision: numbered(REPLICATION_SUPERSEDED_MEMORY),
    })).toBe("refuse");
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

describe("metadata-only cache candidate confirmation", () => {
  const revision = opaque("1");
  const candidate = { identity, revision };

  test("accepts only frames that establish a valid initial transition", () => {
    expect(classifyReplicationCandidateFrame(candidate, {
      type: "ResumeReady", protocol: 1, identity, revision,
    })).toBe("resume");
    expect(classifyReplicationCandidateFrame(candidate, change(revision, opaque("2"))))
      .toBe("change");
    expect(classifyReplicationCandidateFrame(candidate, change(opaque("0"), revision)))
      .toBe("duplicate");
    expect(classifyReplicationCandidateFrame(candidate, change(opaque("0"), opaque("2"))))
      .toBe("invalid");
    expect(classifyReplicationCandidateFrame(undefined, {
      type: "Reset", protocol: 1, identity,
    })).toBe("reset");
    expect(classifyReplicationCandidateFrame(undefined, {
      type: "SnapshotStart", protocol: 1, identity,
      snapshot: opaque("s"), revision,
    })).toBe("snapshot");
  });

  test("snapshot fragments, mismatched resumes, and unseeded liveness fail closed", () => {
    const other = { ...identity, principal: opaque("o") };
    expect(classifyReplicationCandidateFrame(candidate, snapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity,
      snapshot: opaque("s"), index: 0, datoms: [],
    }))).toBe("invalid");
    expect(classifyReplicationCandidateFrame(candidate, {
      type: "SnapshotCommit", protocol: 1, identity,
      snapshot: opaque("s"), revision, chunks: 0,
    })).toBe("invalid");
    expect(classifyReplicationCandidateFrame(candidate, {
      type: "ResumeReady", protocol: 1, identity: other, revision,
    })).toBe("invalid");
    expect(classifyReplicationCandidateFrame(undefined, {
      type: "KeepAlive", protocol: 1, identity,
    })).toBe("invalid");
    expect(classifyReplicationCandidateFrame(candidate, {
      type: "TerminalError", protocol: 1, code: "closed",
    })).toBe("invalid");
  });
});
