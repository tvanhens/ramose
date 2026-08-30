import { describe, expect, test } from "bun:test";
import type { ProjectionChangeset } from "../../../src/db/Projection.ts";
import { invocationId, type InvocationId } from "../../../src/db/refs.ts";
import {
  applyOverlayEvent,
  emptyOverlayLayers,
  type OverlayEvent,
  type OverlayLayers,
} from "../../../src/internal/replication/overlay-layers.ts";

const empty: ProjectionChangeset = Object.freeze([]);

const ids = {
  a: invocationId(),
  b: invocationId(),
  c: invocationId(),
  d: invocationId(),
};

const drive = (
  events: readonly OverlayEvent[],
  from: OverlayLayers = emptyOverlayLayers,
): OverlayLayers => {
  let layers = from;
  for (const event of events) {
    const result = applyOverlayEvent(layers, event);
    if (result.type !== "applied") {
      throw new Error(`refused ${event.type}: ${result.reason}`);
    }
    layers = result.layers;
  }
  return layers;
};

const enqueue = (
  invocation: InvocationId,
  sequence: number,
): OverlayEvent => ({
  type: "enqueue",
  invocation,
  sequence,
  declared: [],
  changeset: empty,
});

const three = (): OverlayLayers =>
  drive([enqueue(ids.a, 1), enqueue(ids.b, 2), enqueue(ids.c, 3)]);

const names = (layers: OverlayLayers): readonly InvocationId[] =>
  layers.map((layer) => layer.invocation);

describe("enqueue", () => {
  test("appends in FIFO order and nothing below it replays", () => {
    const result = applyOverlayEvent(drive([enqueue(ids.a, 1)]), enqueue(ids.b, 2));
    expect(result.type).toBe("applied");
    expect(result.type === "applied" && result.replayFrom).toBe(1);
    expect(result.type === "applied" && result.removed).toEqual([]);
    expect(names(result.layers)).toEqual([ids.a, ids.b]);
    expect(result.layers[1]).toEqual({
      invocation: ids.b,
      sequence: 2,
      state: "queued",
      activation: null,
      declared: [],
      changeset: empty,
    });
  });

  test("refuses a duplicate invocation", () => {
    const result = applyOverlayEvent(three(), enqueue(ids.b, 9));
    expect(result).toMatchObject({ type: "refused", reason: "duplicate-invocation" });
    expect(names(result.layers)).toEqual([ids.a, ids.b, ids.c]);
  });

  test("refuses a sequence at or behind the tail, and a non-sequence", () => {
    for (const sequence of [3, 2, 0, -1, 1.5, Number.NaN]) {
      expect(applyOverlayEvent(three(), enqueue(ids.d, sequence))).toMatchObject({
        type: "refused",
        reason: "out-of-order",
      });
    }
  });
});

describe("commit", () => {
  test("retains the layer in place and changes no datom", () => {
    const layers = three();
    const result = applyOverlayEvent(layers, {
      type: "commit",
      invocation: ids.a,
      activation: 4,
    });
    expect(result.type === "applied" && result.replayFrom).toBe(3);
    expect(result.type === "applied" && result.removed).toEqual([]);
    expect(names(result.layers)).toEqual([ids.a, ids.b, ids.c]);
    expect(result.layers[0]).toMatchObject({
      state: "committed-unobserved",
      activation: 4,
    });
    expect(result.layers[0]?.changeset).toBe(layers[0]!.changeset);
  });

  test("refuses an unknown invocation, a second commit, and a bad counter", () => {
    const layers = three();
    expect(
      applyOverlayEvent(layers, { type: "commit", invocation: ids.d, activation: 1 }),
    ).toMatchObject({ reason: "unknown-invocation" });
    for (const activation of [0, -1, 1.5]) {
      expect(
        applyOverlayEvent(layers, { type: "commit", invocation: ids.a, activation }),
      ).toMatchObject({ reason: "invalid-activation" });
    }
    const committed = drive([{ type: "commit", invocation: ids.a, activation: 2 }], layers);
    expect(
      applyOverlayEvent(committed, { type: "commit", invocation: ids.a, activation: 3 }),
    ).toMatchObject({ reason: "terminal" });
  });
});

describe("reject", () => {
  test("removes exactly one layer and replays from its position", () => {
    const result = applyOverlayEvent(three(), { type: "reject", invocation: ids.b });
    expect(result.type === "applied" && result.removed).toEqual([ids.b]);
    expect(result.type === "applied" && result.replayFrom).toBe(1);
    expect(names(result.layers)).toEqual([ids.a, ids.c]);
  });

  test("leaves unrelated later layers exactly as they were", () => {
    const layers = three();
    const result = applyOverlayEvent(layers, { type: "reject", invocation: ids.a });
    expect(result.layers[0]).toBe(layers[1]!);
    expect(result.layers[1]).toBe(layers[2]!);
  });

  test("refuses to roll a committed layer back", () => {
    const committed = drive(
      [{ type: "commit", invocation: ids.b, activation: 2 }],
      three(),
    );
    expect(
      applyOverlayEvent(committed, { type: "reject", invocation: ids.b }),
    ).toMatchObject({ type: "refused", reason: "terminal" });
  });

  test("refuses an unknown invocation", () => {
    expect(
      applyOverlayEvent(three(), { type: "reject", invocation: ids.d }),
    ).toMatchObject({ reason: "unknown-invocation" });
  });
});

describe("fence", () => {
  const stamped = (): OverlayLayers =>
    drive([
      { type: "commit", invocation: ids.a, activation: 2 },
      { type: "commit", invocation: ids.c, activation: 5 },
    ], three());

  test("removes every committed layer stamped strictly below the activation", () => {
    const result = applyOverlayEvent(stamped(), { type: "fence", activation: 5 });
    expect(result.type === "applied" && result.removed).toEqual([ids.a]);
    expect(result.type === "applied" && result.replayFrom).toBe(0);
    expect(names(result.layers)).toEqual([ids.b, ids.c]);
  });

  test("a later activation coalesces every earlier stamp in one pass", () => {
    const result = applyOverlayEvent(stamped(), { type: "fence", activation: 6 });
    expect(result.type === "applied" && result.removed).toEqual([ids.a, ids.c]);
    expect(names(result.layers)).toEqual([ids.b]);
  });

  test("a queued layer is never fenced, whatever the activation", () => {
    const result = applyOverlayEvent(stamped(), { type: "fence", activation: 99 });
    expect(names(result.layers)).toEqual([ids.b]);
  });

  test("re-fencing selects nothing and moves nothing", () => {
    const once = drive([{ type: "fence", activation: 6 }], stamped());
    const twice = applyOverlayEvent(once, { type: "fence", activation: 6 });
    expect(twice.type === "applied" && twice.removed).toEqual([]);
    expect(twice.type === "applied" && twice.replayFrom).toBe(once.length);
    expect(names(twice.layers)).toEqual(names(once));
  });

  test("a fence at or below the layer's own stamp proves nothing", () => {
    const result = applyOverlayEvent(stamped(), { type: "fence", activation: 2 });
    expect(result.type === "applied" && result.removed).toEqual([]);
    expect(names(result.layers)).toEqual([ids.a, ids.b, ids.c]);
  });

  test("refuses a counter that is not a positive integer", () => {
    for (const activation of [0, -1, 2.5]) {
      expect(
        applyOverlayEvent(stamped(), { type: "fence", activation }),
      ).toMatchObject({ reason: "invalid-activation" });
    }
  });
});

describe("replay ordering", () => {
  test("replayFrom is the lowest position that moved", () => {
    const layers = drive([
      enqueue(ids.a, 1),
      enqueue(ids.b, 2),
      enqueue(ids.c, 3),
      enqueue(ids.d, 4),
      { type: "commit", invocation: ids.b, activation: 3 },
      { type: "commit", invocation: ids.d, activation: 3 },
    ]);
    const result = applyOverlayEvent(layers, { type: "fence", activation: 4 });
    expect(result.type === "applied" && result.removed).toEqual([ids.b, ids.d]);
    expect(result.type === "applied" && result.replayFrom).toBe(1);
    expect(names(result.layers)).toEqual([ids.a, ids.c]);
  });

  test("removal is not an inverse: the survivors keep their relative order", () => {
    const built = drive([
      { type: "reject", invocation: ids.b },
    ], three());
    const fresh = drive([enqueue(ids.a, 1), enqueue(ids.c, 3)]);
    expect(names(built)).toEqual(names(fresh));
    expect(built.map((layer) => layer.sequence)).toEqual([1, 3]);
  });
});
