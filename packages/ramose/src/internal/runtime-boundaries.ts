/**
 * Optional runtime boundaries used by the explicit non-production assembly.
 *
 * The production Worker and Durable Object entry points always use this
 * inert value.  The implementation that can arm, release, or inspect a
 * boundary lives in `internal/test-hooks.ts`, which is reachable only from
 * the repository's explicit source-only testing assembly.
 */

export interface RuntimeBoundaries {
  readonly checkpoint: (name: string) => Promise<void>;
  readonly checkpointSync: (name: string) => void;
  readonly checkpointReached?: (name: string) => void;
  readonly checkpointCancel?: (name: string) => void;
}

export const inertRuntimeBoundaries: RuntimeBoundaries = Object.freeze({
  checkpoint: async () => {},
  checkpointSync: () => {},
  checkpointReached: () => {},
  checkpointCancel: () => {},
});
