import type { ProjectionChangeset } from "../../db/Projection.ts";
import type { InvocationId, MutationRef } from "../../db/refs.ts";

export type OverlayLayerState = "queued" | "committed-unobserved";

export type OverlayLayer = {
  readonly invocation: InvocationId;
  readonly sequence: number;
  readonly state: OverlayLayerState;
  readonly activation: number | null;
  readonly declared: readonly MutationRef[];
  readonly changeset: ProjectionChangeset;
};

export type OverlayLayers = readonly OverlayLayer[];

export const emptyOverlayLayers: OverlayLayers = Object.freeze([]);

export type OverlayEvent =
  | {
    readonly type: "enqueue";
    readonly invocation: InvocationId;
    readonly sequence: number;
    readonly declared: readonly MutationRef[];
    readonly changeset: ProjectionChangeset;
  }
  | {
    readonly type: "commit";
    readonly invocation: InvocationId;
    readonly activation: number;
  }
  | { readonly type: "reject"; readonly invocation: InvocationId }
  | { readonly type: "fence"; readonly activation: number };

export type OverlayEventRefusalReason =
  | "duplicate-invocation"
  | "out-of-order"
  | "unknown-invocation"
  | "terminal"
  | "invalid-activation";

export type OverlayLayersApplied = {
  readonly type: "applied";
  readonly layers: OverlayLayers;
  readonly removed: readonly InvocationId[];
  readonly replayFrom: number;
};

export type OverlayLayersResult =
  | OverlayLayersApplied
  | {
    readonly type: "refused";
    readonly reason: OverlayEventRefusalReason;
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
  reason: OverlayEventRefusalReason,
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
      declared: Object.freeze([...event.declared]),
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
  return applied(next, [], layers.length);
};

const reject = (
  layers: OverlayLayers,
  event: Extract<OverlayEvent, { readonly type: "reject" }>,
): OverlayLayersResult => {
  const index = indexOf(layers, event.invocation);
  if (index < 0) return refused("unknown-invocation", layers);
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
