import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import { ValueTag, type Datom } from "../../../src/internal/core/datom.ts";
import { bytesToBase64 } from "../../../src/internal/core/log.ts";
import {
  MAX_REPLICATION_FRAME_BYTES,
  MAX_REPLICATION_STRING_BYTES,
  applyReplicationFrame,
  decodeReplicationFrame,
  emptyClientReplicationState,
  encodeReplicationFrame,
  makeLogicalIdentityEncoder,
  projectLogicalValueParts,
  type ClientReplicationState,
  type ReplicationFrame,
  type ReplicationIdentity,
  type SnapshotLogicalValue,
} from "../../../src/internal/replication/index.ts";

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

const apply = (
  state: ClientReplicationState,
  frame: ReplicationFrame,
): ClientReplicationState => {
  const result = applyReplicationFrame(state, frame);
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

describe("large logical replication values", () => {
  test("the real encoder fragments and atomically reassembles a valid 800 KiB stored byte value", async () => {
    const bytes = new Uint8Array(800 * 1_024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const raw: Datom = {
      e: 10,
      a: 20,
      vt: ValueTag.Bytes,
      v: bytes,
      t: 1,
      op: true,
    };
    const logical = makeLogicalIdentityEncoder("s".repeat(32), opaque("Z"));
    const values: SnapshotLogicalValue[] = [];
    for await (const value of projectLogicalValueParts(raw, logical)) {
      values.push(value);
    }

    expect(values.length).toBeGreaterThan(1);
    expect(values.every((value) => value.type === "bytes-part")).toBe(true);
    expect(values.every((value) =>
      value.type === "bytes-part" &&
      new TextEncoder().encode(value.value).byteLength <=
        MAX_REPLICATION_STRING_BYTES
    )).toBe(true);

    const snapshot = opaque("G");
    const revision = opaque("H");
    let state = apply(emptyClientReplicationState(), {
      type: "SnapshotStart",
      protocol: 1,
      identity,
      snapshot,
      revision,
    });
    for (let index = 0; index < values.length; index++) {
      const frame: ReplicationFrame = {
        type: "SnapshotChunk",
        protocol: 1,
        identity,
        snapshot,
        index,
        datoms: [{
          entity: opaque("I"),
          field: ":asset/body",
          value: values[index]!,
          op: "add",
        }],
      };
      const wire = encodeReplicationFrame(frame);
      expect(new TextEncoder().encode(wire).byteLength)
        .toBeLessThanOrEqual(MAX_REPLICATION_FRAME_BYTES);
      const decoded = decodeReplicationFrame(wire);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (Result.isSuccess(decoded)) state = apply(state, decoded.success);
    }
    state = apply(state, {
      type: "SnapshotCommit",
      protocol: 1,
      identity,
      snapshot,
      revision,
      chunks: values.length,
    });

    expect(state.committed?.datoms).toEqual([{
      entity: opaque("I"),
      field: ":asset/body",
      value: { type: "bytes", value: bytesToBase64(bytes) },
      op: "add",
    }]);
  });

  test("the real projector round-trips both valid stored double infinities", async () => {
    const logical = makeLogicalIdentityEncoder("s".repeat(32), opaque("Z"));
    const projected: SnapshotLogicalValue[] = [];
    for (const [index, value] of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ].entries()) {
      const raw: Datom = {
        e: 10 + index,
        a: 20,
        vt: ValueTag.Double,
        v: value,
        t: 1,
        op: true,
      };
      for await (const part of projectLogicalValueParts(raw, logical)) {
        projected.push(part);
      }
    }
    expect(projected).toEqual([
      { type: "double", value: "positive-infinity" },
      { type: "double", value: "negative-infinity" },
    ]);

    const snapshot = opaque("J");
    const revision = opaque("K");
    let state = apply(emptyClientReplicationState(), {
      type: "SnapshotStart",
      protocol: 1,
      identity,
      snapshot,
      revision,
    });
    const chunk: ReplicationFrame = {
      type: "SnapshotChunk",
      protocol: 1,
      identity,
      snapshot,
      index: 0,
      datoms: projected.map((value, index) => ({
        entity: opaque(index === 0 ? "L" : "M"),
        field: ":metric/value",
        value,
        op: "add" as const,
      })),
    };
    const decoded = decodeReplicationFrame(encodeReplicationFrame(chunk));
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) state = apply(state, decoded.success);
    state = apply(state, {
      type: "SnapshotCommit",
      protocol: 1,
      identity,
      snapshot,
      revision,
      chunks: 1,
    });
    expect(state.committed?.datoms.map((datom) => datom.value)).toEqual([
      { type: "double", value: "positive-infinity" },
      { type: "double", value: "negative-infinity" },
    ]);
  });
});
