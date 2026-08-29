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
  replicationActivationAddress,
  replicationCredentialFingerprint,
} from "../../../src/internal/replication/transport.ts";

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
  protocol: 1,
  identity,
  revision: opaque("r"),
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

test("canonical activation rejects configured non-origin URL components", () => {
  expect(() => replicationActivationAddress({
    server: "https://data.example/base",
    root: "root",
    graphPath: [],
  })).toThrow(/must be an origin/);
  expect(() => replicationActivationAddress({
    server: "https://data.example/?tenant=one",
    root: "root",
    graphPath: [],
  })).toThrow(/must be an origin/);
  expect(() => replicationActivationAddress({
    server: "https://data.example/#fragment",
    root: "root",
    graphPath: [],
  })).toThrow(/must be an origin/);
});

test("credential fingerprints are full, exact, and activation-bound", async () => {
  const activation = replicationActivationAddress({
    server: "https://data.example/",
    root: "root",
    graphPath: ["org", "board"],
  });
  const first = await replicationCredentialFingerprint("exact-token", activation);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await replicationCredentialFingerprint("exact-token", activation)).toBe(first);
  expect(await replicationCredentialFingerprint("other-token", activation)).not.toBe(first);
  expect(await replicationCredentialFingerprint("exact-token", replicationActivationAddress({
    server: "https://data.example",
    root: "root",
    graphPath: ["org", "other"],
  }))).not.toBe(first);
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
