import { expect, test } from "bun:test";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import {
  MAX_REPLICATION_FRAME_BYTES,
  encodeReplicationFrame,
  type ReplicationFrame,
  type ReplicationIdentity,
} from "../../packages/ramose/src/internal/replication/index.ts";
import {
  collectCommittedSnapshot,
  decodeReplicationNdjson,
  readReplicationNdjson,
} from "./replication.ts";
import { sealedHandle } from "../../packages/ramose/test/replication-fixtures.ts";

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
    protocol: 4,
    identity,
    snapshot: opaque("G"),
    index: 0,
    datoms: [{
      entity: opaque("H"),
      field: ":item/value",
      value: { type: "string", value: "x".repeat(120_000) },
      op: "add",
    }],
    handles: [{ entity: opaque("H"), handle: sealedHandle(opaque("H")) }],
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
    protocol: 4,
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

  await expect(consume()).rejects.toThrow(
    "replication stream ended without a newline",
  );
  expect(decoded).toHaveLength(1);
});

test("a stalled snapshot cancels its reader so cleanup does not queue behind it", async () => {

  const stalled = new ReadableStream<Uint8Array>({ start() {} });
  const stream = readReplicationNdjson(new Response(stalled));

  const started = Date.now();
  await expect(collectCommittedSnapshot(stream, undefined, 100))
    .rejects.toThrow("replication snapshot did not commit within 100ms");

  await expect(
    Promise.race([
      stream.return(undefined).then(() => "closed" as const),
      Bun.sleep(2_000).then(() => "hung" as const),
    ]),
  ).resolves.toBe("closed");
  expect(Date.now() - started).toBeLessThan(2_000);
});
