/**
 * The post-commit activation fence (#475 slice 3).
 *
 * A committed receipt becomes `observed` only when the authoritative
 * replication stream has, on an activation that began *after* that receipt was
 * already durable, delivered a matching outcome carrying the current committed
 * state. Output from a generation that was already open when the
 * acknowledgement landed proves nothing about whether the server's stream has
 * caught up to the commit, so it may not clear the marker.
 *
 * The client half is three steps, in this order and no other:
 *
 *   1. the acknowledgement transaction persists the receipt and its
 *      `unobserved` marker, stamped with the activation counter in force then;
 *   2. the prior replication generation is invalidated and closed, and the
 *      counter is incremented durably — that increment *is* the fresh
 *      activation's identity;
 *   3. the fresh activation's first matching outcome fences, in one client
 *      transaction, every receipt stamped strictly below the new counter.
 *
 * Because the counter is claimed before the activation opens, a crash cut can
 * only ever leave the client fencing with a *larger* number than it needed,
 * never a smaller one. That is what makes every cut converge.
 *
 * Nothing here is public: no transaction position, no observation token, and no
 * server-visible acknowledgement. #475 persists and exposes the transition;
 * #476 consumes it to remove or replay optimistic layers.
 */

import type { InvocationId } from "../../db/refs.ts";
import type { ReplicationFrame } from "./protocol.ts";
import type {
  ActivationFenceOutcome,
  ActivationObservationState,
} from "./outbox-storage.ts";
import type { UnobservedReceipt } from "./outbox.ts";
import type { ReplicaDatabaseScope } from "./replica-lifecycle.ts";
import type { QueueProgress } from "./submission.ts";

/**
 * Whether one *settled* frame satisfies the post-commit activation fence.
 *
 * The caller establishes settledness — that this frame carried the current
 * committed state — before asking, because the frame type alone cannot: a
 * `Change` whose local install lost its CAS installed nothing, and an
 * incomplete snapshot staging never commits. Slice 3 carried that fact as a
 * `settled` parameter every call site passed `true` for; now that the
 * production driver's call sites exist and all sit inside the session's own
 * settled path, the constant is gone and the precondition is stated here.
 *
 * `Change`, `ResumeReady`, and `SnapshotCommit` are the only three frames that
 * can satisfy the fence. Keepalive is liveness rather than state; a terminal
 * ends the activation without an outcome; a `Reset`, `SnapshotStart`, or
 * `SnapshotChunk` is staging, and incomplete staging is never an outcome.
 *
 * The frozen contract names the reset case as "`SnapshotCommit` following a
 * matching `Reset`". A fresh activation that supplies no resume revision — its
 * local replica was quarantined between the acknowledgement and the reconnect —
 * receives `SnapshotStart` with no preceding `Reset`, because there was no
 * revision to reset *from*, and its commit fences on the same terms. Reading it
 * any other way would leave such an activation permanently unable to fence, and
 * it cannot fence early: the snapshot is taken after this activation's own
 * authoritative basis fence.
 */
export const satisfiesActivationFence = (
  frame: ReplicationFrame["type"],
): boolean => {
  switch (frame) {
    case "Change":
    case "ResumeReady":
    case "SnapshotCommit":
      return true;
    case "Reset":
    case "SnapshotStart":
    case "SnapshotChunk":
    case "KeepAlive":
    case "TerminalError":
      return false;
  }
};

/** Whether one pass's outcome for a database requires a fresh activation. */
export const requiresActivationFence = (progress: QueueProgress): boolean =>
  progress.state._tag === "Committed";

/**
 * The durable fence transition, as #476 consumes it.
 *
 * `unobserved` is reconstructed from durable rows, never from memory, so it is
 * identical before and after a restart.
 */
export type ActivationFenceSnapshot = {
  readonly receiver: ReplicaDatabaseScope;
  /** The activation currently in force; `0` before the first fresh one. */
  readonly activation: number;
  readonly unobserved: readonly UnobservedReceipt[];
  /** Exactly what the most recent fence transaction marked observed. */
  readonly fenced: readonly InvocationId[];
};

export type ActivationFenceObserver = (
  snapshot: ActivationFenceSnapshot,
) => void;

/**
 * Exactly the surface of the durable queue this fence uses.
 *
 * Structural rather than nominal only to keep the dependency pointing one way,
 * as {@link QueueProgress}'s own store surface is. It is not a seam for a
 * substitute store: the durable behavior is proven against real IndexedDB and
 * nothing here is meaningful without it.
 */
export type ActivationFenceStore = {
  readonly observationState: (
    receiver: ReplicaDatabaseScope,
  ) => Promise<ActivationObservationState>;
  readonly beginActivation: (
    receiver: ReplicaDatabaseScope,
  ) => Promise<number>;
  readonly fenceActivation: (
    receiver: ReplicaDatabaseScope,
    activation: number,
  ) => Promise<ActivationFenceOutcome>;
};

const EMPTY: readonly InvocationId[] = Object.freeze([]);

/**
 * One receiver database's post-commit fence.
 *
 * It owns no replication session and opens no connection: the caller closes the
 * prior generation, calls {@link ActivationFence.begin}, opens the fresh
 * activation with {@link ActivationFence.outcome} as its hook, and the hook
 * fences. Keeping the session lifecycle outside means the fence has exactly one
 * job and can be reasoned about — and tested — as durable state.
 */
export class ActivationFence {
  private state: ActivationFenceSnapshot;
  private readonly observers = new Set<ActivationFenceObserver>();
  /**
   * The activations whose fence transaction has already committed. A hook may
   * be invoked again — a second qualifying frame on the same activation, or a
   * retry after a failure — and re-fencing is idempotent, but skipping the
   * transaction entirely keeps a settled activation from touching storage.
   */
  private settled = 0;

  constructor(
    private readonly store: ActivationFenceStore,
    private readonly receiver: ReplicaDatabaseScope,
  ) {
    this.state = Object.freeze({
      receiver,
      activation: 0,
      unobserved: Object.freeze([]),
      fenced: EMPTY,
    });
  }

  snapshot(): ActivationFenceSnapshot {
    return this.state;
  }

  observe(observer: ActivationFenceObserver): () => void {
    this.observers.add(observer);
    this.notify(observer);
    return () => this.observers.delete(observer);
  }

  /**
   * Reconstruct the durable state. This is restart recovery: the unobserved set
   * is exactly the durable rows that say `committed` with the marker still on,
   * so a process that died between the acknowledgement and the fence comes back
   * knowing precisely what still needs one.
   */
  async refresh(): Promise<ActivationFenceSnapshot> {
    return this.publish(await this.store.observationState(this.receiver), EMPTY);
  }

  /**
   * Claim the next activation. Call it after closing the prior generation and
   * before opening the fresh one, so the number is durable before any frame of
   * that activation can arrive.
   */
  async begin(): Promise<number> {
    const activation = await this.store.beginActivation(this.receiver);
    await this.refresh();
    return activation;
  }

  /**
   * Close the prior replication generation and claim the activation that
   * replaces it, in the one order the fence requires.
   *
   * The order is the contract, not a convenience. A generation that is still
   * open when the counter moves can deliver output that was already in flight
   * before the acknowledgement was durable, and that output proves nothing
   * about whether the server's stream reached the commit. Closing first is what
   * makes "the first matching outcome on this activation" a causal statement.
   */
  async restart(
    prior?: { readonly close: () => Promise<void> } | undefined,
  ): Promise<number> {
    await prior?.close();
    return this.begin();
  }

  /**
   * Consume one activation's first matching authoritative outcome.
   *
   * Returns everything the reconciliation transaction did — the invocations it
   * marked observed, the authoritative revision it confirmed, and the resulting
   * durable layer order — or `undefined` when this activation had already
   * fenced and the transaction was therefore not run again.
   */
  async settle(
    activation: number,
  ): Promise<ActivationFenceOutcome | undefined> {
    if (activation <= this.settled) return undefined;
    const outcome = await this.store.fenceActivation(this.receiver, activation);
    this.settled = Math.max(this.settled, activation);
    this.publish(await this.store.observationState(this.receiver), outcome.fenced);
    return outcome;
  }

  /**
   * The replication-session hook for one activation.
   *
   * The session invokes it on the first frame that
   * {@link satisfiesActivationFence} accepts, and re-invokes it on a later one
   * if this throws — observation is downstream of persistence, so a failed
   * fence never fails the session and never loses the marker.
   */
  outcome(activation: number): () => Promise<void> {
    return async () => {
      await this.settle(activation);
    };
  }

  private publish(
    observation: ActivationObservationState,
    fenced: readonly InvocationId[],
  ): ActivationFenceSnapshot {
    this.state = Object.freeze({
      receiver: this.receiver,
      activation: observation.activation,
      unobserved: observation.unobserved,
      fenced,
    });
    for (const observer of this.observers) this.notify(observer);
    return this.state;
  }

  private notify(observer: ActivationFenceObserver): void {
    try {
      observer(this.state);
    } catch {
      // Observation is downstream of persistence and cannot stop the fence.
    }
  }
}
