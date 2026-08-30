import type { InvocationId } from "../../db/refs.ts";
import type { ReplicationFrame } from "./protocol.ts";
import type {
  ActivationFenceOutcome,
  ActivationObservationState,
} from "./outbox-storage.ts";
import type { UnobservedReceipt } from "./outbox.ts";
import type { ReplicaDatabaseScope } from "./replica-lifecycle.ts";
import type { QueueProgress } from "./submission.ts";

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

export const requiresActivationFence = (progress: QueueProgress): boolean =>
  progress.state._tag === "Committed";

export type ActivationFenceSnapshot = {
  readonly receiver: ReplicaDatabaseScope;
  readonly activation: number;
  readonly unobserved: readonly UnobservedReceipt[];
  readonly fenced: readonly InvocationId[];
};

export type ActivationFenceObserver = (
  snapshot: ActivationFenceSnapshot,
) => void;

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

export class ActivationFence {
  private state: ActivationFenceSnapshot;
  private readonly observers = new Set<ActivationFenceObserver>();
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

  async refresh(): Promise<ActivationFenceSnapshot> {
    return this.publish(await this.store.observationState(this.receiver), EMPTY);
  }

  async begin(): Promise<number> {
    const activation = await this.store.beginActivation(this.receiver);
    await this.refresh();
    return activation;
  }

  async restart(
    prior?: { readonly close: () => Promise<void> } | undefined,
  ): Promise<number> {
    await prior?.close();
    return this.begin();
  }

  async settle(
    activation: number,
  ): Promise<ActivationFenceOutcome | undefined> {
    if (activation <= this.settled) return undefined;
    const outcome = await this.store.fenceActivation(this.receiver, activation);
    this.settled = Math.max(this.settled, activation);
    this.publish(await this.store.observationState(this.receiver), outcome.fenced);
    return outcome;
  }

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
    }
  }
}
