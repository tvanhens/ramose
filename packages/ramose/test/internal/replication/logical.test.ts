import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import { ValueTag, type Datom } from "../../../src/internal/core/datom.ts";
import { bytesToBase64 } from "../../../src/internal/core/log.ts";
import { ReadCompatibilityHash } from "../../../src/internal/authorization/identities.ts";
import {
  MAX_REPLICATION_FRAME_BYTES,
  MAX_REPLICATION_STRING_BYTES,
  applyReplicationFrame,
  decodeReplicationFrame,
  emptyClientReplicationState,
  encodeReplicationFrame,
  entryHandles,
  makeLogicalIdentityEncoder,
  openEntityId,
  projectLogicalValueParts,
  type ClientReplicationState,
  type ServerSealingKey,
  type ReplicationFrame,
  type ReplicationIdentity,
  type SnapshotLogicalValue,
} from "../../../src/internal/replication/index.ts";
import { isEntityId } from "../../../src/db/refs.ts";
import { snapshotChunk } from "../../replication-fixtures.ts";

const sealing: ServerSealingKey = {
  keyId: "bbbbbbbbbbbbbbbbbbbbbb",
  material: "s".repeat(43),
};

const opaque = (character: string): string => character.repeat(43);

const scope = {
  server: opaque("A"),
  principal: opaque("B"),
  database: opaque("C"),
};
const identity: ReplicationIdentity = {
  version: 1,
  server: opaque("A"),
  principal: opaque("B"),
  database: opaque("C"),
  catalog: opaque("D"),
  readView: opaque("E"),
  readCompatibilityHash: ReadCompatibilityHash.make(opaque("K")),
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
    const logical = makeLogicalIdentityEncoder(sealing, opaque("Z"), scope);
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
      protocol: 4,
      identity,
      snapshot,
      revision,
    });
    for (let index = 0; index < values.length; index++) {
      const frame: ReplicationFrame = snapshotChunk({
        type: "SnapshotChunk",
        protocol: 4,
        identity,
        snapshot,
        index,
        datoms: [{
          entity: opaque("I"),
          field: ":asset/body",
          value: values[index]!,
          op: "add",
        }],
      });
      const wire = encodeReplicationFrame(frame);
      expect(new TextEncoder().encode(wire).byteLength)
        .toBeLessThanOrEqual(MAX_REPLICATION_FRAME_BYTES);
      const decoded = decodeReplicationFrame(wire);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (Result.isSuccess(decoded)) state = apply(state, decoded.success);
    }
    state = apply(state, {
      type: "SnapshotCommit",
      protocol: 4,
      identity,
      snapshot,
      revision,
      ordinal: 1,
      settled: 0,
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
    const logical = makeLogicalIdentityEncoder(sealing, opaque("Z"), scope);
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
      protocol: 4,
      identity,
      snapshot,
      revision,
    });
    const chunk: ReplicationFrame = snapshotChunk({
      type: "SnapshotChunk",
      protocol: 4,
      identity,
      snapshot,
      index: 0,
      datoms: projected.map((value, index) => ({
        entity: opaque(index === 0 ? "L" : "M"),
        field: ":metric/value",
        value,
        op: "add" as const,
      })),
    });
    const decoded = decodeReplicationFrame(encodeReplicationFrame(chunk));
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) state = apply(state, decoded.success);
    state = apply(state, {
      type: "SnapshotCommit",
      protocol: 4,
      identity,
      snapshot,
      revision,
      ordinal: 1,
      settled: 0,
      chunks: 1,
    });
    expect(state.committed?.datoms.map((datom) => datom.value)).toEqual([
      { type: "double", value: "positive-infinity" },
      { type: "double", value: "negative-infinity" },
    ]);
  });
});

describe("the sealed EntityId logical replication carries", () => {
  test("is the real seal of the private eid, opened by the real resolver", async () => {
    const encoder = makeLogicalIdentityEncoder(sealing, opaque("Z"), scope);
    const minted = await encoder.entity(1_042);

    expect(minted.identity).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isEntityId(minted.handle)).toBe(true);
    expect(minted.handle).not.toBe(minted.identity);

    expect(await openEntityId(sealing, scope, minted.handle))
      .toEqual({ type: "resolved", eid: 1_042, scope });

    const second = makeLogicalIdentityEncoder(sealing, opaque("Y"), scope);
    const again = await second.entity(1_042);
    expect(again.handle).toBe(minted.handle);

    expect(again.identity).not.toBe(minted.identity);
  });

  test("is bound to the scope, so another principal cannot open it", async () => {
    const mine = makeLogicalIdentityEncoder(sealing, opaque("Z"), scope);
    const theirs = makeLogicalIdentityEncoder(sealing, opaque("Z"), {
      ...scope,
      principal: opaque("X"),
    });
    const minted = await mine.entity(1_042);

    expect((await theirs.entity(1_042)).handle).not.toBe(minted.handle);

    expect(await openEntityId(sealing, { ...scope, principal: opaque("X") }, minted.handle))
      .toEqual({ type: "denied" });
  });

  test("reaches a frame once per entity a datom names, subject and reference alike", async () => {
    const encoder = makeLogicalIdentityEncoder(sealing, opaque("Z"), scope);
    const subject = await encoder.entity(1_000);
    const referenced = await encoder.entity(1_001);
    const entry = {
      raw: { e: 1_000, a: 20, vt: ValueTag.Ref, v: 1_001, t: 1, op: true } as Datom,
      datom: {
        entity: subject.identity,
        field: ":item/friend",
        value: { type: "ref" as const, value: referenced.identity },
        op: "add" as const,
      },
      handles: [
        { entity: subject.identity, handle: subject.handle },
        { entity: referenced.identity, handle: referenced.handle },
      ],
    };

    expect(entryHandles([entry, entry])).toEqual([
      { entity: subject.identity, handle: subject.handle },
      { entity: referenced.identity, handle: referenced.handle },
    ]);
  });
});
