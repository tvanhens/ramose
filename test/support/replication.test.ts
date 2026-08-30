import { expect, test } from "bun:test";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import {
  MAX_REPLICATION_FRAME_BYTES,
  encodeReplicationFrame,
  type ReplicationFrame,
  type ReplicationIdentity,
} from "../../packages/ramose/src/internal/replication/index.ts";
import { decodeReplicationNdjson } from "./replication.ts";

const opaque = (character: string): string => character.repeat(43);
const identity: ReplicationIdentity = {
  version: 1,
  server: opaque("A"),
  principal: opaque("B"),
  database: opaque("C"),
  catalog: opaque("D"),
  readView: opaque("E"),
  readCompatibilityHash: ReadCompatibilityHash.make(opaque("K")),
  graphLineage: [],
  authenticator: opaque("F"),
};

test("replication NDJSON decoder bounds coalesced transport data per frame", async () => {
  const frame: ReplicationFrame = {
    type: "SnapshotChunk",
    protocol: 1,
    identity,
    snapshot: opaque("G"),
    index: 0,
    datoms: [{
      entity: opaque("H"),
      field: ":item/value",
      value: { type: "string", value: "x".repeat(120_000) },
      op: "add",
    }],
  };
  const wire = encodeReplicationFrame(frame);
  const frameCount = 10;
  const coalesced = new TextEncoder().encode(
    Array.from({ length: frameCount }, () => wire).join("\n") + "\n",
  );
  expect(new TextEncoder().encode(wire).byteLength)
    .toBeLessThan(MAX_REPLICATION_FRAME_BYTES);
  expect(coalesced.byteLength).toBeGreaterThan(MAX_REPLICATION_FRAME_BYTES);

  const chunks = (async function* () {
    yield coalesced;
  })();
  const decoded = [];
  for await (const observed of decodeReplicationNdjson(chunks)) {
    decoded.push(observed.frame);
  }
  expect(decoded).toEqual(Array.from({ length: frameCount }, () => frame));
});

test("a stream cut mid-frame is a truncation, not a malformed frame", async () => {
  const wire = encodeReplicationFrame({
    type: "KeepAlive",
    protocol: 1,
    identity,
  });
  const bytes = new TextEncoder().encode(`${wire}\n${wire.slice(0, 20)}`);
  const chunks = (async function* () {
    yield bytes;
  })();

  const decoded: ReplicationFrame[] = [];
  const consume = async () => {
    for await (const observed of decodeReplicationNdjson(chunks)) {
      decoded.push(observed.frame);
    }
  };

  // The Worker writes every frame newline-terminated, so an unterminated tail
  // can only be a dropped connection. Reporting it as the product's own
  // `malformed` protocol error would blame a real transport failure on the
  // frame codec.
  await expect(consume()).rejects.toThrow(
    "replication stream ended without a newline",
  );
  expect(decoded).toHaveLength(1);
});
