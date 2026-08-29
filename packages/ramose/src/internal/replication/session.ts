/** Framework-neutral coordinator for one activated database replication stream. */

import type { Db } from "../core/db.ts";
import type { AttributeSpec } from "../core/schema.ts";
import {
  IndexedDbReplicaStorage,
  type BoundRestoredReplica,
  type RestoredReplica,
} from "./indexeddb.ts";
import { sameReplicationIdentity } from "./state.ts";
import type { ReplicationFrame, ReplicationIdentity } from "./protocol.ts";
import {
  openReplicationResponse,
  readReplicationFrames,
  replicationActivationAddress,
  replicationCredentialFingerprint,
  type ReplicationActivationInput,
} from "./transport.ts";

export type ReplicationSessionValue = {
  readonly db: Db;
  readonly identity: ReplicationIdentity;
  readonly revision: string;
  readonly stale: boolean;
};

export type ReplicationSessionSnapshot = {
  readonly status: "connecting" | "open" | "terminal" | "failed" | "closed";
  readonly value?: ReplicationSessionValue;
  /** Present for a protocol terminal; absent for clean unexpected EOF. */
  readonly terminalCode?: "closed" | "incompatible-version";
};

export type ReplicationSessionObserver = (snapshot: ReplicationSessionSnapshot) => void;

export type ReplicationSessionOptions = {
  readonly activation: ReplicationActivationInput;
  readonly credential: string;
  readonly attributes: readonly AttributeSpec[];
  readonly storage: IndexedDbReplicaStorage;
};

type ChangeFrame = Extract<ReplicationFrame, { readonly type: "Change" }>;
type TerminalFrame = Extract<ReplicationFrame, { readonly type: "TerminalError" }>;

/** Pure sequencing decision shared with ordinary-frame regression tests. */
export const classifyReplicationChange = (
  prior: Pick<ReplicationSessionValue, "identity" | "revision"> | undefined,
  frame: ChangeFrame,
): "apply" | "duplicate" | "gap" => {
  if (prior === undefined || !sameReplicationIdentity(prior.identity, frame.identity)) {
    return "gap";
  }
  if (prior.revision === frame.revision) return "duplicate";
  return prior.revision === frame.from ? "apply" : "gap";
};

/** Preserve the protocol terminal reason for a later reconnect policy. */
export const replicationTerminalSnapshot = (
  frame: TerminalFrame,
  value?: ReplicationSessionValue,
): ReplicationSessionSnapshot => Object.freeze({
  status: "terminal",
  terminalCode: frame.code,
  ...(value === undefined ? {} : { value }),
});

const identityOf = (frame: ReplicationFrame): ReplicationIdentity | undefined =>
  "identity" in frame ? frame.identity : undefined;

const valueFrom = (
  identity: ReplicationIdentity,
  replica: RestoredReplica,
  stale: boolean,
): ReplicationSessionValue => Object.freeze({
  db: replica.db,
  identity,
  revision: replica.revision,
  stale,
});

export class ReplicationSession {
  private readonly controller = new AbortController();
  private readonly observers = new Set<ReplicationSessionObserver>();
  private generation = 1;
  private loop: Promise<void>;
  private state: ReplicationSessionSnapshot;

  private constructor(
    private readonly storage: IndexedDbReplicaStorage,
    private readonly attributes: readonly AttributeSpec[],
    initial: BoundRestoredReplica | undefined,
    run: (session: ReplicationSession, generation: number) => Promise<void>,
  ) {
    this.state = Object.freeze({
      status: "connecting",
      ...(initial === undefined
        ? {}
        : { value: valueFrom(initial.identity, initial, true) }),
    });
    this.loop = run(this, this.generation);
  }

  static async open(options: ReplicationSessionOptions): Promise<ReplicationSession> {
    const activation = replicationActivationAddress(options.activation);
    const fingerprint = await replicationCredentialFingerprint(options.credential, activation);
    const restored = await options.storage.restoreBound(fingerprint, options.attributes);
    return new ReplicationSession(
      options.storage,
      options.attributes,
      restored,
      async (session, generation) => {
        let activeIdentity = restored?.identity;
        let responseIdentity: ReplicationIdentity | undefined;
        let bindingConfirmed = restored !== undefined;
        try {
          const response = await openReplicationResponse({
            activation,
            credential: options.credential,
            ...(restored === undefined ? {} : { resumeRevision: restored.revision }),
            signal: session.controller.signal,
          });
          for await (const frame of readReplicationFrames(response, session.controller.signal)) {
            if (!session.current(generation)) return;
            const frameIdentity = identityOf(frame);
            if (frameIdentity !== undefined) {
              if (responseIdentity === undefined) {
                responseIdentity = frameIdentity;
                if (
                  activeIdentity !== undefined &&
                  !sameReplicationIdentity(activeIdentity, frameIdentity)
                ) {
                  session.quarantine(generation);
                  bindingConfirmed = false;
                }
                activeIdentity = frameIdentity;
              } else if (!sameReplicationIdentity(responseIdentity, frameIdentity)) {
                session.quarantine(generation);
                throw new Error("replication frame identity changed within one response");
              }
              if (!bindingConfirmed) {
                await options.storage.bindCredential(
                  fingerprint,
                  frameIdentity,
                  { signal: session.controller.signal },
                );
                if (!session.current(generation)) return;
                bindingConfirmed = true;
              }
            }
            const terminal = await session.accept(frame, generation);
            if (terminal) return;
          }
          if (session.current(generation)) session.publish({
            status: "terminal",
            ...(session.state.value === undefined ? {} : { value: session.state.value }),
          });
        } catch (error) {
          if (session.controller.signal.aborted || !session.current(generation)) return;
          session.publish({
            status: "failed",
            ...(session.state.value === undefined ? {} : { value: session.state.value }),
          });
          session.controller.abort(error);
        }
      },
    );
  }

  snapshot(): ReplicationSessionSnapshot {
    return this.state;
  }

  observe(observer: ReplicationSessionObserver): () => void {
    if (this.state.status === "closed") return () => undefined;
    this.observers.add(observer);
    this.notify(observer);
    return () => this.observers.delete(observer);
  }

  async close(): Promise<void> {
    if (this.state.status === "closed") return;
    this.generation++;
    this.controller.abort(new DOMException("replication session closed", "AbortError"));
    try {
      await this.loop;
    } catch {
      // Close owns cancellation; non-cancellation failures were already observed.
    }
    const closed = Object.freeze({
      status: "closed" as const,
      ...(this.state.value === undefined ? {} : { value: this.state.value }),
    });
    this.state = closed;
    for (const observer of this.observers) this.notify(observer);
    this.observers.clear();
  }

  private current(generation: number): boolean {
    return generation === this.generation && this.state.status !== "closed";
  }

  private publish(snapshot: ReplicationSessionSnapshot): void {
    this.state = Object.freeze(snapshot);
    for (const observer of this.observers) this.notify(observer);
  }

  private notify(observer: ReplicationSessionObserver): void {
    try {
      observer(this.state);
    } catch {
      // Observation is downstream of persistence and cannot stop replication.
    }
  }

  private quarantine(generation: number): void {
    if (!this.current(generation) || this.state.value === undefined) return;
    this.publish({ status: "connecting" });
  }

  private publishReplica(
    identity: ReplicationIdentity,
    replica: RestoredReplica,
    stale: boolean,
    generation: number,
  ): void {
    if (!this.current(generation)) return;
    this.publish({ status: "open", value: valueFrom(identity, replica, stale) });
  }

  /** Returns true after a terminal frame. */
  private async accept(frame: ReplicationFrame, generation: number): Promise<boolean> {
    if (!this.current(generation)) return true;
    switch (frame.type) {
      case "Reset":
        await this.storage.resetStaging(frame.identity);
        if (!this.current(generation)) return true;
        if (
          this.state.value !== undefined &&
          sameReplicationIdentity(this.state.value.identity, frame.identity)
        ) {
          this.publish({
            status: "connecting",
            value: Object.freeze({ ...this.state.value, stale: true }),
          });
        }
        return false;
      case "SnapshotStart":
        await this.storage.startSnapshot(frame);
        if (
          this.current(generation) && this.state.value !== undefined &&
          sameReplicationIdentity(this.state.value.identity, frame.identity)
        ) {
          this.publish({
            status: "connecting",
            value: Object.freeze({ ...this.state.value, stale: true }),
          });
        }
        return false;
      case "SnapshotChunk":
        await this.storage.stageSnapshotChunk(frame);
        return false;
      case "SnapshotCommit": {
        const installed = await this.storage.commitSnapshot(
          frame,
          this.attributes,
          { signal: this.controller.signal },
        );
        if (installed !== undefined && installed.revision === frame.revision) {
          this.publishReplica(frame.identity, installed, false, generation);
        }
        return false;
      }
      case "Change": {
        const prior = this.state.value;
        const disposition = classifyReplicationChange(prior, frame);
        if (disposition === "duplicate") return false;
        if (disposition === "gap") {
          throw new Error("replication change does not continue the committed revision");
        }
        const installed = await this.storage.applyChange(frame, {
          signal: this.controller.signal,
        });
        if (installed !== undefined && installed.revision === frame.revision) {
          this.publishReplica(frame.identity, installed, false, generation);
        }
        return false;
      }
      case "ResumeReady": {
        const prior = this.state.value;
        if (
          prior === undefined || prior.revision !== frame.revision ||
          !sameReplicationIdentity(prior.identity, frame.identity)
        ) {
          this.quarantine(generation);
          throw new Error("resume acknowledgement does not match the restored replica");
        }
        this.publish({
          status: "open",
          value: Object.freeze({ ...prior, stale: false }),
        });
        return false;
      }
      case "KeepAlive":
        return false;
      case "TerminalError":
        this.publish(replicationTerminalSnapshot(frame, this.state.value));
        return true;
    }
  }
}
