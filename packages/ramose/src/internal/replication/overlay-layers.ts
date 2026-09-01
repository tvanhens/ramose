import type { ProjectionChangeset } from "../../db/Projection.ts";
import type { InvocationId, MutationRef } from "../../db/refs.ts";

export type OverlayLayerState = "queued" | "committed-unobserved" | "retired";

export type OverlayLayer = {
  readonly invocation: InvocationId;
  readonly sequence: number;
  readonly state: OverlayLayerState;
  readonly settled: number | undefined;
  readonly activation: number | null;
  readonly declared: readonly MutationRef[];
  readonly changeset: ProjectionChangeset;
};

export type OverlayLayers = readonly OverlayLayer[];

export const emptyOverlayLayers: OverlayLayers = Object.freeze([]);
