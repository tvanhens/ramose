import { expect, test } from "bun:test";
import { ReadCompatibilityHash } from "../../../src/internal/authorization/identities.ts";
import {
  MAX_REPLICATION_FRAME_BYTES,
  encodeReplicationFrame,
  type ReplicationFrame,
  type ReplicationIdentity,
} from "../../../src/internal/replication/protocol.ts";
import {
  decodeReplicationNdjson,
  readReplicationFrames,
  replicationActivationAddress,
  replicationCacheSelector,
  replicationCredentialFingerprint,
  ReplicationTransportError,
  ReplicationUnauthorizedError,
} from "../../../src/internal/replication/transport.ts";
import { rootReplicaRouteSlot } from "../../../src/internal/replication/route-slot.ts";

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
const ready: ReplicationFrame = {
  type: "ResumeReady",
  protocol: 3,
  identity,
  revision: opaque("r"),
  ordinal: 1,
};

const chunks = (...values: Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const value of values) yield value;
  },
});

const collect = async (values: AsyncIterable<ReplicationFrame>): Promise<ReplicationFrame[]> => {
  const frames: ReplicationFrame[] = [];
  for await (const frame of values) frames.push(frame);
  return frames;
};

const conflict = (body: string): Response => new Response(body, {
  status: 409,
  headers: {
    "cache-control": "no-store",
    "content-type": "application/x-ndjson",
  },
});

test("canonical activation rejects configured non-origin URL components", () => {
  expect(() => replicationActivationAddress({
    server: "https://data.example/base",
    root: "root",
  })).toThrow(/must be an origin/);
  expect(() => replicationActivationAddress({
    server: "https://data.example/?tenant=one",
    root: "root",
  })).toThrow(/must be an origin/);
  expect(() => replicationActivationAddress({
    server: "https://data.example/#fragment",
    root: "root",
  })).toThrow(/must be an origin/);
});

test("credential fingerprints are full, exact, and database-bound", async () => {
  const activation = replicationActivationAddress({
    server: "https://data.example/",
    root: "root",
  });
  const slot = await rootReplicaRouteSlot();
  const first = await replicationCredentialFingerprint("exact-token", activation, slot);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await replicationCredentialFingerprint("exact-token", activation, slot)).toBe(first);
  expect(await replicationCredentialFingerprint("other-token", activation, slot))
    .not.toBe(first);
  expect(await replicationCredentialFingerprint("exact-token", activation, "different-slot"))
    .not.toBe(first);
  expect(await replicationCredentialFingerprint("exact-token", replicationActivationAddress({
    server: "https://data.example",
    root: "other-root",
  }), slot)).not.toBe(first);
});

test("cache selectors are opaque database-scoped values", async () => {
  const key = "user:raw-cache-key";
  const first = replicationActivationAddress({
    server: "https://data.example:443/",
    root: "root",
  });
  const selector = await replicationCacheSelector(key, first);
  expect(selector).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(selector).not.toContain(key);
  expect(await replicationCacheSelector("another-user", first)).not.toBe(selector);
  expect(await replicationCacheSelector(key, replicationActivationAddress({
    server: "https://data.example",
    root: "other-root",
  }))).not.toBe(selector);
  expect(await replicationCacheSelector(key, replicationActivationAddress({
    server: "https://other.example",
    root: "root",
  }))).not.toBe(selector);
  expect(await replicationCredentialFingerprint(key, first, await rootReplicaRouteSlot()))
    .not.toBe(selector);
});

test("bounded decoder preserves back-to-back frames across arbitrary chunks", async () => {
  const wire = new TextEncoder().encode(
    `${encodeReplicationFrame(ready)}\n${encodeReplicationFrame(ready)}\n`,
  );
  const decoded = await collect(decodeReplicationNdjson(chunks(
    wire.subarray(0, 7),
    wire.subarray(7, wire.length - 3),
    wire.subarray(wire.length - 3),
  )));
  expect(decoded).toEqual([ready, ready]);
});

test("bounded decoder rejects invalid UTF-8, unterminated, and oversized frames", async () => {
  await expect(collect(decodeReplicationNdjson(chunks(
    new Uint8Array([0xff, 0x0a]),
  )))).rejects.toThrow(/UTF-8/);
  await expect(collect(decodeReplicationNdjson(chunks(
    new TextEncoder().encode(encodeReplicationFrame(ready)),
  )))).rejects.toThrow(/without a newline/);
  await expect(collect(decodeReplicationNdjson(chunks(
    new Uint8Array(MAX_REPLICATION_FRAME_BYTES + 1).fill(0x20),
  )))).rejects.toThrow(/oversized/);
});

test("HTTP 409 yields only one identity-free agreement or version terminal", async () => {
  const updateRequired: ReplicationFrame = {
    type: "TerminalError",
    protocol: 3,
    code: "update-required",
  };
  expect(await collect(readReplicationFrames(conflict(
    `${encodeReplicationFrame(updateRequired)}\n`,
  )))).toEqual([updateRequired]);

  await expect(collect(readReplicationFrames(conflict(""))))
    .rejects.toThrow(/exactly one allowed terminal/);
  await expect(collect(readReplicationFrames(conflict(
    `${encodeReplicationFrame(updateRequired)}\n${encodeReplicationFrame(ready)}\n`,
  )))).rejects.toThrow(/exactly one allowed terminal/);
  await expect(collect(readReplicationFrames(conflict(
    `${encodeReplicationFrame(ready)}\n`,
  )))).rejects.toThrow(/exactly one allowed terminal/);
  await expect(collect(readReplicationFrames(conflict(
    `${encodeReplicationFrame({ ...updateRequired, identity })}\n`,
  )))).rejects.toThrow(/exactly one allowed terminal/);
  await expect(collect(readReplicationFrames(conflict(
    `${encodeReplicationFrame({ ...updateRequired, code: "closed" })}\n`,
  )))).rejects.toThrow(/exactly one allowed terminal/);
});

test("a refused credential is distinguishable from an unreachable server", async () => {

  for (const status of [401, 403]) {
    await expect(collect(readReplicationFrames(
      new Response(null, {
        status,
        headers: { "cache-control": "no-store", "content-type": "application/x-ndjson" },
      }),
    ))).rejects.toBeInstanceOf(ReplicationUnauthorizedError);
  }

  const other = collect(readReplicationFrames(
    new Response(null, {
      status: 503,
      headers: { "cache-control": "no-store", "content-type": "application/x-ndjson" },
    }),
  ));
  await expect(other).rejects.toBeInstanceOf(ReplicationTransportError);
  await expect(other).rejects.not.toBeInstanceOf(ReplicationUnauthorizedError);
});
