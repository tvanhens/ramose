import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import { ReadCompatibilityHash } from "../../../src/internal/authorization/identities.ts";
import {
  MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK,
  MAX_REPLICATION_FRAME_BYTES,
  MAX_REPLICATION_REQUEST_BYTES,
  MAX_REPLICATION_STRING_BYTES,
  REPLICATION_PROTOCOL_VERSION,
  decodeActivationRequest,
  decodeReplicationFrame,
  decideReplicaCompatibility,
  encodeActivationRequest,
  encodeReplicationFrame,
  type ActivationRequest,
  type LogicalDatom,
  type ReplicationFrame,
  type ReplicationIdentity,
} from "../../../src/internal/replication/index.ts";

const opaque = (character: string): string => character.repeat(43);
const compatible = ReadCompatibilityHash.make(opaque("K"));

const identity: ReplicationIdentity = {
  version: 1,
  server: opaque("A"),
  principal: opaque("B"),
  database: opaque("C"),
  catalog: opaque("D"),
  readView: opaque("E"),
  readCompatibilityHash: compatible,
  graphLineage: [],
  authenticator: opaque("F"),
};

const request: ActivationRequest = {
  type: "Activate",
  protocol: REPLICATION_PROTOCOL_VERSION,
  graphPath: ["organizations", "acme"],
  scope: { type: "database" },
  readCompatibilityHash: compatible,
  resumeRevision: opaque("G"),
};

const values: readonly LogicalDatom[] = [
  { entity: opaque("H"), field: ":issue/count", value: { type: "long", value: 3 }, op: "add" },
  { entity: opaque("H"), field: ":issue/score", value: { type: "double", value: 3.5 }, op: "add" },
  { entity: opaque("H"), field: ":issue/high", value: { type: "double", value: "positive-infinity" }, op: "add" },
  { entity: opaque("H"), field: ":issue/low", value: { type: "double", value: "negative-infinity" }, op: "add" },
  { entity: opaque("H"), field: ":issue/title", value: { type: "string", value: "Visible" }, op: "add" },
  { entity: opaque("H"), field: ":issue/open", value: { type: "boolean", value: true }, op: "add" },
  { entity: opaque("H"), field: ":issue/owner", value: { type: "ref", value: opaque("I") }, op: "add" },
  { entity: opaque("H"), field: ":issue/id", value: { type: "uuid", value: "550e8400-e29b-41d4-a716-446655440000" }, op: "add" },
  { entity: opaque("H"), field: ":issue/at", value: { type: "instant", value: 1_700_000_000_000 }, op: "add" },
  { entity: opaque("H"), field: ":issue/blob", value: { type: "bytes", value: "AQID" }, op: "add" },
];

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const failureReason = (text: string): string => {
  const decoded = decodeActivationRequest(text);
  if (Result.isSuccess(decoded)) throw new Error("expected activation failure");
  return decoded.failure.reason;
};

describe("replication activation codec", () => {
  test("round-trips the versioned path, scope, and opaque resume only", () => {
    expect(success(decodeActivationRequest(encodeActivationRequest(request))))
      .toEqual(request);
    expect(success(decodeActivationRequest(JSON.stringify({
      ...request,
      resumeRevision: undefined,
    })))).toEqual({
      type: "Activate",
      protocol: 1,
      graphPath: ["organizations", "acme"],
      scope: { type: "database" },
      readCompatibilityHash: compatible,
    });
  });

  test("separates incompatible versions from malformed and oversized input", () => {
    expect(failureReason(JSON.stringify({ ...request, protocol: 2 })))
      .toBe("incompatible-version");
    expect(failureReason("{not-json")).toBe("malformed");
    expect(failureReason(" ".repeat(MAX_REPLICATION_REQUEST_BYTES + 1)))
      .toBe("oversized");
    expect(() => encodeActivationRequest({
      ...request,
      graphPath: Array.from({ length: 17 }, () => "a".repeat(4_096)),
    })).toThrow();
  });

  test("rejects client-selected identity, catalog proof, unknown scope, and bad bounds", () => {
    for (const invalid of [
      { ...request, identity },
      { ...request, catalog: "app", unitHash: "a".repeat(64) },
      { ...request, scope: { type: "query", range: [] } },
      { ...request, resumeRevision: "raw-t:42" },
      { ...request, graphPath: [""] },
      { ...request, graphPath: ["😀".repeat(1_025)] },
    ]) {
      expect(failureReason(JSON.stringify(invalid))).toBe("malformed");
    }
  });
});

describe("replication frame codec", () => {
  const snapshot = opaque("J");
  const revision = opaque("K");
  const nextRevision = opaque("L");
  const frames: readonly ReplicationFrame[] = [
    { type: "SnapshotStart", protocol: 1, identity, snapshot, revision },
    {
      type: "SnapshotChunk",
      protocol: 1,
      identity,
      snapshot,
      index: 0,
      datoms: values.map((datom) => ({ ...datom, op: "add" as const })),
    },
    {
      type: "SnapshotChunk",
      protocol: 1,
      identity,
      snapshot,
      index: 1,
      datoms: [{
        entity: opaque("H"),
        field: ":issue/body",
        value: {
          type: "string-part",
          identity: opaque("M"),
          index: 0,
          chunks: 2,
          value: "bounded part",
        },
        op: "add",
      }],
    },
    { type: "SnapshotCommit", protocol: 1, identity, snapshot, revision, chunks: 1 },
    {
      type: "Change",
      protocol: 1,
      identity,
      from: revision,
      revision: nextRevision,
      datoms: [{ ...values[0]!, op: "retract" }],
    },
    { type: "ResumeReady", protocol: 1, identity, revision },
    { type: "Reset", protocol: 1, identity },
    { type: "KeepAlive", protocol: 1, identity },
    { type: "TerminalError", protocol: 1, code: "closed", identity },
    { type: "TerminalError", protocol: 1, code: "incompatible-version" },
    { type: "TerminalError", protocol: 1, code: "update-required" },
  ];

  test("round-trips every exact envelope and canonical logical value", () => {
    for (const frame of frames) {
      expect(success(decodeReplicationFrame(encodeReplicationFrame(frame))))
        .toEqual(frame);
    }
    const incompatible = decodeReplicationFrame(JSON.stringify({
      ...frames[0],
      protocol: 2,
    }));
    expect(Result.isFailure(incompatible)).toBe(true);
    if (Result.isFailure(incompatible)) {
      expect(incompatible.failure.reason).toBe("incompatible-version");
    }
  });

  test("a maximum codec-legal string or base64 value fits one complete snapshot envelope", () => {
    for (const value of [
      { type: "string" as const, value: "x".repeat(MAX_REPLICATION_STRING_BYTES) },
      { type: "bytes" as const, value: "A".repeat(MAX_REPLICATION_STRING_BYTES) },
    ]) {
      const maximum: ReplicationFrame = {
        type: "SnapshotChunk",
        protocol: 1,
        identity,
        snapshot,
        index: Number.MAX_SAFE_INTEGER,
        datoms: [{
          entity: opaque("H"),
          field: ":v/x",
          value,
          op: "add",
        }],
      };
      const wire = encodeReplicationFrame(maximum);
      expect(new TextEncoder().encode(wire).byteLength)
        .toBeLessThanOrEqual(MAX_REPLICATION_FRAME_BYTES);
      expect(success(decodeReplicationFrame(wire))).toEqual(maximum);
    }
  });

  test("rejects physical metadata, excess fields, malformed values, and bounds", () => {
    const base = frames[1]!;
    const oversizedChunk = {
      ...base,
      datoms: Array.from(
        { length: MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK + 1 },
        () => values[0],
      ),
    };
    const tooManyUtf8Bytes = {
      ...base,
      datoms: [{
        entity: opaque("H"),
        field: ":issue/title",
        value: { type: "string", value: "😀".repeat(
          Math.floor(MAX_REPLICATION_STRING_BYTES / 4) + 1,
        ) },
        op: "add",
      }],
    };
    for (const invalid of [
      { ...base, basisT: 42 },
      { ...base, txEid: 99 },
      { ...base, datoms: [{ ...values[0], attributeEid: 7 }] },
      { ...base, datoms: [{ ...values[0], op: "retract" }] },
      {
        ...base,
        datoms: [{
          entity: opaque("H"),
          field: ":issue/body",
          value: {
            type: "bytes-part",
            identity: opaque("M"),
            index: 0,
            chunks: 0,
            value: "AQID",
          },
          op: "add",
        }],
      },
      {
        type: "Change",
        protocol: 1,
        identity,
        from: opaque("K"),
        revision: opaque("L"),
        datoms: [{
          entity: opaque("H"),
          field: ":issue/body",
          value: {
            type: "string-part",
            identity: opaque("M"),
            index: 0,
            chunks: 1,
            value: "not legal in a delta",
          },
          op: "add",
        }],
      },
      { ...base, datoms: [{ ...values[0], field: "😀".repeat(1_025) }] },
      {
        ...base,
        datoms: [{
          ...values.at(-1)!,
          value: { type: "bytes", value: "AB==" },
        }],
      },
      { ...base, identity: { ...identity, principal: "not-opaque" } },
      { type: "ResumeReady", protocol: 1, identity },
      { type: "ResumeReady", protocol: 1, identity, revision: "raw-t:42" },
      { type: "ResumeReady", protocol: 1, identity, revision, basisT: 42 },
      oversizedChunk,
      tooManyUtf8Bytes,
    ]) {
      expect(Result.isFailure(decodeReplicationFrame(JSON.stringify(invalid))))
        .toBe(true);
    }
  });

  test("the encoded vocabulary has no raw transaction or storage position", () => {
    const wire = frames.map(encodeReplicationFrame).join("\n");
    expect(wire).not.toContain("basisT");
    expect(wire).not.toContain("txEid");
    expect(wire).not.toContain("attributeEid");
    expect(wire).not.toContain("storage");
    expect(wire).not.toContain("/session");
  });
});

describe("replica version ownership", () => {
  const current = {
    protocol: 1,
    build: "client-v2",
    storage: 3,
    readCompatibilityHash: "schema-b",
    readView: "view-b",
  };

  test("chooses one conservative owner in protocol/build/storage/read-view order", () => {
    expect(decideReplicaCompatibility(current, current)).toBe("reuse");
    expect(decideReplicaCompatibility({ ...current, protocol: 0 }, current))
      .toBe("protocol-reset");
    expect(decideReplicaCompatibility({ ...current, build: "client-v1" }, current))
      .toBe("build-reset");
    expect(decideReplicaCompatibility({ ...current, storage: 2 }, current))
      .toBe("storage-migration");
    expect(decideReplicaCompatibility({ ...current, readCompatibilityHash: "schema-a" }, current))
      .toBe("read-compatibility-reset");
    expect(decideReplicaCompatibility({ ...current, readView: "view-a" }, current))
      .toBe("read-view-reset");
  });
});
