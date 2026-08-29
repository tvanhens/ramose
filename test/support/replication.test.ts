import { expect, test } from "bun:test";
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
