/**
 * Immutable per-invocation speculative layers (#476 slice 1).
 *
 * One layer per invocation, in FIFO invocation order. The committed replica is
 * never touched; the local view is the committed value plus these layers, in
 * this order. This module is the pure state machine over the list — slice 2
 * gives it a durable store and drives it from #475's acknowledgement and
 * activation-fence transitions.
 *
 * There is deliberately no dependency graph. Removing a layer removes exactly
 * one, and every later layer is replayed at its new position; {@link
 * OverlayLayersApplied.replayFrom} is the index from which that has to happen.
 */

import type { ProjectionChangeset } from "../../db/Projection.ts";
import type { InvocationId } from "../../db/refs.ts";

/**
 * `committed-unobserved` is the whole reason a commit is not a removal: the
 * authoritative receipt, output, and mappings are durably known, but the
 * independent replication stream has not necessarily incorporated the commit.
 * The layer stays visible so the UI cannot roll back while the authoritative
 * change catches up.
 */
export type OverlayLayerState = "queued" | "committed-unobserved";

export type OverlayLayer = {
  readonly invocation: InvocationId;
  /** The invocation's durable FIFO position in its receiver database. */
  readonly sequence: number;
  readonly state: OverlayLayerState;
  /**
   * The activation counter in force when the receipt became durable, or `null`
   * while queued. A fence at `n` removes this layer when it is strictly below.
   */
  readonly activation: number | null;
  readonly changeset: ProjectionChangeset;
};

export type OverlayLayers = readonly OverlayLayer[];

export const emptyOverlayLayers: OverlayLayers = Object.freeze([]);

export type OverlayEvent =
  | {
    readonly type: "enqueue";
    readonly invocation: InvocationId;
    readonly sequence: number;
    readonly changeset: ProjectionChangeset;
  }
  | {
    readonly type: "commit";
    readonly invocation: InvocationId;
    readonly activation: number;
  }
  | { readonly type: "reject"; readonly invocation: InvocationId }
  | { readonly type: "fence"; readonly activation: number };

export type OverlayRefusalReason =
  | "duplicate-invocation"
  | "out-of-order"
  | "unknown-invocation"
  /** The layer is already `committed-unobserved`; only a fence removes it. */
  | "terminal"
  | "invalid-activation";

export type OverlayLayersApplied = {
  readonly type: "applied";
  readonly layers: OverlayLayers;
  readonly removed: readonly InvocationId[];
  /**
   * The lowest index whose applied position changed, so the caller knows how
   * much of the overlay must be rebuilt. `layers.length` means nothing moved.
   */
  readonly replayFrom: number;
};

export type OverlayLayersResult =
  | OverlayLayersApplied
  | {
    readonly type: "refused";
    readonly reason: OverlayRefusalReason;
    readonly layers: OverlayLayers;
  };

const applied = (
  layers: OverlayLayers,
  removed: readonly InvocationId[],
  replayFrom: number,
): OverlayLayersResult =>
  Object.freeze({
    type: "applied" as const,
    layers: Object.freeze(layers),
    removed: Object.freeze(removed),
    replayFrom,
  });

const refused = (
  reason: OverlayRefusalReason,
  layers: OverlayLayers,
): OverlayLayersResult =>
  Object.freeze({ type: "refused" as const, reason, layers });

const isCounter = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

const indexOf = (layers: OverlayLayers, invocation: InvocationId): number =>
  layers.findIndex((layer) => layer.invocation === invocation);

const enqueue = (
  layers: OverlayLayers,
  event: Extract<OverlayEvent, { readonly type: "enqueue" }>,
): OverlayLayersResult => {
  if (indexOf(layers, event.invocation) >= 0) {
    return refused("duplicate-invocation", layers);
  }
  const last = layers[layers.length - 1];
  // FIFO is the durable sequence, never arrival order: a layer that claims a
  // position at or behind the tail would make the view depend on which pass
  // happened to run first.
  if (
    !isCounter(event.sequence) ||
    (last !== undefined && event.sequence <= last.sequence)
  ) {
    return refused("out-of-order", layers);
  }
  return applied(
    [...layers, Object.freeze({
      invocation: event.invocation,
      sequence: event.sequence,
      state: "queued" as const,
      activation: null,
      changeset: event.changeset,
    })],
    [],
    layers.length,
  );
};

const commit = (
  layers: OverlayLayers,
  event: Extract<OverlayEvent, { readonly type: "commit" }>,
): OverlayLayersResult => {
  if (!isCounter(event.activation)) return refused("invalid-activation", layers);
  const index = indexOf(layers, event.invocation);
  if (index < 0) return refused("unknown-invocation", layers);
  const layer = layers[index]!;
  if (layer.state !== "queued") return refused("terminal", layers);
  const next = [...layers];
  next[index] = Object.freeze({
    ...layer,
    state: "committed-unobserved" as const,
    activation: event.activation,
  });
  // No datom changes, so nothing replays and nothing can flash: the layer is
  // retained under a new name until a causally fresh activation fences it.
  return applied(next, [], layers.length);
};

const reject = (
  layers: OverlayLayers,
  event: Extract<OverlayEvent, { readonly type: "reject" }>,
): OverlayLayersResult => {
  const index = indexOf(layers, event.invocation);
  if (index < 0) return refused("unknown-invocation", layers);
  // Removing a committed layer would roll the view back under an authoritative
  // commit. Only the observation fence may remove one.
  if (layers[index]!.state !== "queued") return refused("terminal", layers);
  return applied(
    layers.filter((_, at) => at !== index),
    [layers[index]!.invocation],
    index,
  );
};

const fence = (
  layers: OverlayLayers,
  event: Extract<OverlayEvent, { readonly type: "fence" }>,
): OverlayLayersResult => {
  if (!isCounter(event.activation)) return refused("invalid-activation", layers);
  const removed: InvocationId[] = [];
  let replayFrom = layers.length;
  const kept: OverlayLayer[] = [];
  for (let index = 0; index < layers.length; index++) {
    const layer = layers[index]!;
    if (
      layer.state === "committed-unobserved" && layer.activation !== null &&
      layer.activation < event.activation
    ) {
      removed.push(layer.invocation);
      if (index < replayFrom) replayFrom = index;
      continue;
    }
    kept.push(layer);
  }
  return applied(kept, removed, removed.length === 0 ? layers.length : replayFrom);
};

/**
 * The whole transition table, as one total function of the ordered layers and
 * one event. Every refusal leaves the list exactly as it was.
 */
export const applyOverlayEvent = (
  layers: OverlayLayers,
  event: OverlayEvent,
): OverlayLayersResult => {
  switch (event.type) {
    case "enqueue":
      return enqueue(layers, event);
    case "commit":
      return commit(layers, event);
    case "reject":
      return reject(layers, event);
    case "fence":
      return fence(layers, event);
  }
};
