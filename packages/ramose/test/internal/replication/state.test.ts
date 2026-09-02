import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import { ReadCompatibilityHash } from "../../../src/internal/authorization/identities.ts";
import {
  applyReplicationFrame,
  emptyClientReplicationState,
  type ClientReplicationState,
  type LogicalDatom,
  type ReplicationFrame,
  type ReplicationIdentity,
  type SnapshotDatom,
} from "../../../src/internal/replication/index.ts";
import {
  changeFrame,
  sealedHandle,
  snapshotChunk,
} from "../../replication-fixtures.ts";

const opaque = (character: string): string => character.repeat(43);
const identity = (principal = "B"): ReplicationIdentity => ({
  version: 1,
  server: opaque("A"),
  principal: opaque(principal),
  database: opaque("C"),
  catalog: opaque("D"),
  readView: opaque("E"),
  readCompatibilityHash: ReadCompatibilityHash.make(opaque("K")),
  authenticator: opaque(principal === "B" ? "F" : "G"),
});
const active = identity();
const first: LogicalDatom = {
  entity: opaque("H"),
  field: ":issue/title",
  value: { type: "string", value: "First" },
  op: "add",
};
const second: LogicalDatom = {
  entity: opaque("I"),
  field: ":issue/title",
  value: { type: "string", value: "Second" },
  op: "add",
};

const bindings = (...entities: readonly string[]): ReadonlyMap<string, string> =>
  new Map(entities.map((entity) => [entity, sealedHandle(entity)]));

const apply = (
  state: ClientReplicationState,
  frame: ReplicationFrame,
): ClientReplicationState => {
  const result = applyReplicationFrame(state, frame);
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const start = (snapshot: string, revision: string): ReplicationFrame => ({
  type: "SnapshotStart",
  protocol: 4,
  identity: active,
  snapshot,
  revision,
});
const chunk = (
  snapshot: string,
  index: number,
  datoms: readonly (LogicalDatom | SnapshotDatom)[],
): ReplicationFrame => (snapshotChunk({
  type: "SnapshotChunk",
  protocol: 4,
  identity: active,
  snapshot,
  index,
  datoms: datoms.map((datom) => ({
    ...datom,
    op: "add" as const,
  }) as SnapshotDatom),
}));
const commit = (
  snapshot: string,
  revision: string,
  chunks: number,
  ordinal = 1,
  settled = 0,
): ReplicationFrame => ({
  type: "SnapshotCommit",
  protocol: 4,
  identity: active,
  snapshot,
  revision,
  ordinal,
  settled,
  chunks,
});

const committed = (): ClientReplicationState => {
  let state = emptyClientReplicationState();
  state = apply(state, start(opaque("J"), opaque("K")));
  state = apply(state, chunk(opaque("J"), 0, [first]));
  return apply(state, commit(opaque("J"), opaque("K"), 1));
};

describe("client replication transition machine", () => {
  test("installs a snapshot only after every chunk commits atomically", () => {
    let state = emptyClientReplicationState();
    state = apply(state, start(opaque("J"), opaque("K")));
    state = apply(state, chunk(opaque("J"), 1, [second]));
    state = apply(state, commit(opaque("J"), opaque("K"), 2));
    expect(state.committed).toBeUndefined();
    state = apply(state, chunk(opaque("J"), 0, [first]));
    expect(state.committed).toBeUndefined();
    state = apply(state, commit(opaque("J"), opaque("K"), 2));
    expect(state.committed).toEqual({
      revision: opaque("K"),
      ordinal: 1,
      settled: 0,
      datoms: [first, second],
      handles: bindings(opaque("H"), opaque("I")),
    });
  });

  test("interruption and a reordered incomplete commit retain the prior complete value", () => {
    const prior = committed();
    let staging = apply(prior, start(opaque("L"), opaque("M")));
    staging = apply(staging, chunk(opaque("L"), 1, [second]));
    const reordered = apply(staging, commit(opaque("L"), opaque("M"), 2));
    expect(reordered.committed).toBe(prior.committed);
    expect(staging.committed).toBe(prior.committed);
  });

  test("fragmented values become queryable only after every value part and snapshot chunk commits", () => {
    const snapshot = opaque("L");
    const revision = opaque("M");
    const valueIdentity = opaque("N");
    const part = (index: number, value: string): SnapshotDatom => ({
      entity: opaque("H"),
      field: ":issue/body",
      value: {
        type: "string-part",
        identity: valueIdentity,
        index,
        chunks: 2,
        value,
      },
      op: "add",
    });
    let state = apply(emptyClientReplicationState(), start(snapshot, revision));
    state = apply(state, chunk(snapshot, 1, [part(1, "world")]));
    state = apply(state, commit(snapshot, revision, 2));
    expect(state.committed).toBeUndefined();
    state = apply(state, chunk(snapshot, 0, [part(0, "hello ")]));
    state = apply(state, commit(snapshot, revision, 2));
    expect(state.committed).toEqual({
      revision,
      ordinal: 1,
      settled: 0,
      datoms: [{
        entity: opaque("H"),
        field: ":issue/body",
        value: { type: "string", value: "hello world" },
        op: "add",
      }],
      handles: bindings(opaque("H")),
    });
  });

  test("identical duplicate frames are idempotent and conflicting duplicates fail closed", () => {
    let state = apply(emptyClientReplicationState(), start(opaque("J"), opaque("K")));
    const once = apply(state, chunk(opaque("J"), 0, [first]));
    expect(apply(once, chunk(opaque("J"), 0, [first]))).toBe(once);
    const conflicting = applyReplicationFrame(
      once,
      chunk(opaque("J"), 0, [second]),
    );
    expect(Result.isFailure(conflicting)).toBe(true);
    expect(state.committed).toBeUndefined();

    const complete = committed();
    expect(apply(complete, commit(opaque("J"), opaque("K"), 1)).committed)
      .toBe(complete.committed);
  });

  test("one complete change is atomic; duplicate and stale revisions are ignored", () => {
    const prior = committed();
    const change: ReplicationFrame = changeFrame({
      type: "Change",
      protocol: 4,
      identity: active,
      from: opaque("K"),
      revision: opaque("L"),
      ordinal: 2,
      settled: 0,
      datoms: [
        { ...first, op: "retract" },
        second,
      ],
    });
    const next = apply(prior, change);
    expect(next.committed).toEqual({
      revision: opaque("L"),
      ordinal: 2,
      settled: 0,
      datoms: [second],

      handles: bindings(opaque("I")),
    });
    expect(prior.committed).toEqual({
      revision: opaque("K"),
      ordinal: 1,
      settled: 0,
      datoms: [{ ...first, op: "add" as const }],
      handles: bindings(opaque("H")),
    });
    expect(apply(next, change)).toBe(next);
    expect(apply(next, { ...change, from: opaque("M"), revision: opaque("N") }))
      .toBe(next);
  });

  test("a committed value carries its issued ordinal and ignores one that regresses", () => {
    let state = apply(emptyClientReplicationState(), start(opaque("J"), opaque("K")));
    state = apply(state, chunk(opaque("J"), 0, [first]));
    state = apply(state, commit(opaque("J"), opaque("K"), 1, 7));
    expect(state.committed?.ordinal).toBe(7);

    const advanced = apply(state, changeFrame({
      type: "Change",
      protocol: 4,
      identity: active,
      from: opaque("K"),
      revision: opaque("L"),
      ordinal: 8,
      settled: 0,
      datoms: [second],
    }));
    expect(advanced.committed?.revision).toBe(opaque("L"));
    expect(advanced.committed?.ordinal).toBe(8);

    expect(apply(advanced, changeFrame({
      type: "Change",
      protocol: 4,
      identity: active,
      from: opaque("L"),
      revision: opaque("M"),
      ordinal: 7,
      settled: 0,
      datoms: [{ ...second, op: "retract" }],
    }))).toBe(advanced);
  });

  test("an acknowledged resume carries the ordinal the identity has since reached", () => {
    const prior = committed();
    const acknowledged = apply(prior, {
      type: "ResumeReady",
      protocol: 4,
      identity: active,
      revision: opaque("K"),
      ordinal: 3,
      settled: 0,
    });
    expect(acknowledged.committed).toEqual({
      revision: opaque("K"),
      ordinal: 3,
      settled: 0,
      datoms: [{ ...first, op: "add" as const }],
      handles: bindings(opaque("H")),
    });

    for (const ordinal of [1, 3]) {
      expect(apply(acknowledged, {
        type: "ResumeReady",
        protocol: 4,
        identity: active,
        revision: opaque("K"),
        ordinal,
        settled: 0,
      })).toBe(acknowledged);
    }

    expect(apply(acknowledged, changeFrame({
      type: "Change",
      protocol: 4,
      identity: active,
      from: opaque("K"),
      revision: opaque("L"),
      ordinal: 2,
      settled: 0,
      datoms: [second],
    }))).toBe(acknowledged);
  });

  test("resume-ready accepts only the matching committed partition and revision", () => {
    const prior = committed();
    const ready: ReplicationFrame = {
      type: "ResumeReady",
      protocol: 4,
      identity: active,
      revision: opaque("K"),
      ordinal: 1,
      settled: 0,
    };
    expect(apply(prior, ready)).toBe(prior);
    expect(apply(prior, ready)).toBe(prior);

    const wrongRevision = applyReplicationFrame(prior, {
      ...ready,
      revision: opaque("L"),
    });
    expect(Result.isFailure(wrongRevision)).toBe(true);
    const wrongIdentity = applyReplicationFrame(prior, {
      ...ready,
      identity: identity("Z"),
    });
    expect(Result.isFailure(wrongIdentity)).toBe(true);
    expect(prior.committed).toEqual({
      revision: opaque("K"),
      ordinal: 1,
      settled: 0,
      datoms: [{ ...first, op: "add" as const }],
      handles: bindings(opaque("H")),
    });
  });

  test("a partition reset clears retained data before staging the new identity", () => {
    const prior = committed();
    const replacement = identity("Z");
    const reset = apply(prior, {
      type: "Reset",
      protocol: 4,
      identity: replacement,
    });
    expect(reset.identity).toEqual(replacement);
    expect(reset.committed).toBeUndefined();

    const sameReset = apply(prior, {
      type: "Reset",
      protocol: 4,
      identity: active,
    });
    expect(sameReset.committed).toBe(prior.committed);
  });

  test("mismatched frames fail without mutating state and terminal close is opaque", () => {
    const prior = committed();
    const mismatch = applyReplicationFrame(prior, {
      type: "KeepAlive",
      protocol: 4,
      identity: identity("Z"),
    });
    expect(Result.isFailure(mismatch)).toBe(true);
    expect(prior.closed).toBe(false);
    const closed = apply(prior, {
      type: "TerminalError",
      protocol: 4,
      code: "closed",
      identity: active,
    });
    expect(closed.closed).toBe(true);
    expect(closed.committed).toBe(prior.committed);
    expect(apply(closed, start(opaque("L"), opaque("M")))).toBe(closed);
    expect(apply(closed, changeFrame({
      type: "Change",
      protocol: 4,
      identity: active,
      from: opaque("K"),
      revision: opaque("N"),
      ordinal: 2,
      settled: 0,
      datoms: [second],
    }))).toBe(closed);
    expect(apply(closed, {
      type: "ResumeReady",
      protocol: 4,
      identity: active,
      revision: opaque("K"),
      ordinal: 1,
      settled: 0,
    })).toBe(closed);
  });
});

describe("the committed settlement watermark", () => {
  test("a snapshot installs the settlement its commit covers", () => {
    let state = apply(emptyClientReplicationState(), start(opaque("J"), opaque("K")));
    state = apply(state, chunk(opaque("J"), 0, [first]));
    state = apply(state, commit(opaque("J"), opaque("K"), 1, 1, 4));
    expect(state.committed?.settled).toBe(4);
  });

  test("a change raises the watermark and never lowers it", () => {
    const prior = apply(
      apply(
        apply(emptyClientReplicationState(), start(opaque("J"), opaque("K"))),
        chunk(opaque("J"), 0, [first]),
      ),
      commit(opaque("J"), opaque("K"), 1, 1, 2),
    );
    const advanced = apply(prior, changeFrame({
      type: "Change",
      protocol: 4,
      identity: active,
      from: opaque("K"),
      revision: opaque("L"),
      ordinal: 2,
      settled: 5,
      datoms: [second],
    }));
    expect(advanced.committed?.settled).toBe(5);

    const regressed = apply(advanced, changeFrame({
      type: "Change",
      protocol: 4,
      identity: active,
      from: opaque("L"),
      revision: opaque("M"),
      ordinal: 3,
      settled: 1,
      datoms: [{ ...second, op: "retract" }],
    }));
    expect(regressed.committed?.settled).toBe(5);
    expect(regressed.committed?.revision).toBe(opaque("M"));
  });

  test("a resume advances the watermark even when the ordinal stands still", () => {
    const prior = committed();
    expect(prior.committed?.settled).toBe(0);
    const acknowledged = apply(prior, {
      type: "ResumeReady",
      protocol: 4,
      identity: active,
      revision: opaque("K"),
      ordinal: 1,
      settled: 3,
    });
    expect(acknowledged.committed?.ordinal).toBe(1);
    expect(acknowledged.committed?.settled).toBe(3);

    expect(apply(acknowledged, {
      type: "ResumeReady",
      protocol: 4,
      identity: active,
      revision: opaque("K"),
      ordinal: 1,
      settled: 2,
    })).toBe(acknowledged);
  });

  test("a resume that lags the ordinal keeps the ordinal it already reached", () => {
    const prior = apply(committed(), {
      type: "ResumeReady",
      protocol: 4,
      identity: active,
      revision: opaque("K"),
      ordinal: 9,
      settled: 1,
    });
    const lagging = apply(prior, {
      type: "ResumeReady",
      protocol: 4,
      identity: active,
      revision: opaque("K"),
      ordinal: 4,
      settled: 6,
    });
    expect(lagging.committed?.ordinal).toBe(9);
    expect(lagging.committed?.settled).toBe(6);
  });

  test("a change re-delivering the committed revision still raises the watermark", () => {
    const prior = committed();
    expect(prior.committed?.settled).toBe(0);
    const duplicate = changeFrame({
      type: "Change",
      protocol: 4,
      identity: active,
      from: opaque("J"),
      revision: opaque("K"),
      ordinal: 1,
      settled: 4,
      datoms: [second],
    });
    const advanced = apply(prior, duplicate);
    expect(advanced.committed?.revision).toBe(opaque("K"));
    expect(advanced.committed?.ordinal).toBe(1);
    expect(advanced.committed?.settled).toBe(4);
    expect(advanced.committed?.datoms).toEqual(prior.committed!.datoms);
    expect(advanced.committed?.handles).toEqual(prior.committed!.handles);

    expect(apply(advanced, { ...duplicate, settled: 2 })).toBe(advanced);
  });

  test("a snapshot re-committing the committed revision still raises the watermark", () => {
    const prior = committed();
    const advanced = apply(prior, commit(opaque("J"), opaque("K"), 1, 1, 7));
    expect(advanced.committed?.revision).toBe(opaque("K"));
    expect(advanced.committed?.settled).toBe(7);
    expect(advanced.committed?.datoms).toEqual(prior.committed!.datoms);
    expect(advanced.staging).toBeUndefined();

    const lagging = apply(advanced, commit(opaque("J"), opaque("K"), 1, 1, 3));
    expect(lagging.committed).toBe(advanced.committed);
  });
});

describe("the committed sealed-handle binding", () => {
  test("accumulates across chunks and is complete before a snapshot installs", () => {
    let state = apply(emptyClientReplicationState(), start(opaque("J"), opaque("K")));
    state = apply(state, chunk(opaque("J"), 0, [first]));
    state = apply(state, chunk(opaque("J"), 1, [second]));
    state = apply(state, commit(opaque("J"), opaque("K"), 2));
    expect(state.committed?.handles).toEqual(bindings(opaque("H"), opaque("I")));
  });

  test("refuses a snapshot that names an entity it cannot address", () => {
    let state = apply(emptyClientReplicationState(), start(opaque("J"), opaque("K")));

    state = apply(state, {
      type: "SnapshotChunk",
      protocol: 4,
      identity: active,
      snapshot: opaque("J"),
      index: 0,
      datoms: [{ ...first, op: "add" as const }],
      handles: [],
    });
    const commitResult = applyReplicationFrame(
      state,
      commit(opaque("J"), opaque("K"), 1),
    );
    expect(Result.isFailure(commitResult)).toBe(true);
    if (Result.isFailure(commitResult)) {
      expect(commitResult.failure.reason)
        .toBe("snapshot names an entity with no sealed handle");
    }
  });

  test("refuses a chunk or a change that rebinds one entity", () => {
    const started = apply(emptyClientReplicationState(), start(opaque("J"), opaque("K")));
    const staged = apply(started, chunk(opaque("J"), 0, [first]));
    const rebinding = applyReplicationFrame(staged, {
      type: "SnapshotChunk",
      protocol: 4,
      identity: active,
      snapshot: opaque("J"),
      index: 1,
      datoms: [{ ...second, op: "add" as const }],
      handles: [{ entity: opaque("H"), handle: sealedHandle(opaque("Z")) }],
    });
    expect(Result.isFailure(rebinding)).toBe(true);

    const prior = committed();
    const changed = applyReplicationFrame(prior, {
      type: "Change",
      protocol: 4,
      identity: active,
      from: opaque("K"),
      revision: opaque("L"),
      ordinal: 2,
      settled: 0,
      datoms: [second],
      handles: [
        { entity: opaque("I"), handle: sealedHandle(opaque("I")) },
        { entity: opaque("H"), handle: sealedHandle(opaque("Z")) },
      ],
    });
    expect(Result.isFailure(changed)).toBe(true);
    if (Result.isFailure(changed)) {
      expect(changed.failure.reason).toBe("change rebinds an entity's sealed handle");
    }
  });

  test("refuses a change that adds an entity it was given no handle for", () => {
    const prior = committed();
    const changed = applyReplicationFrame(prior, {
      type: "Change",
      protocol: 4,
      identity: active,
      from: opaque("K"),
      revision: opaque("L"),
      ordinal: 2,
      settled: 0,
      datoms: [second],
      handles: [],
    });
    expect(Result.isFailure(changed)).toBe(true);
    if (Result.isFailure(changed)) {
      expect(changed.failure.reason).toBe("change leaves an entity with no sealed handle");
    }
  });
});
