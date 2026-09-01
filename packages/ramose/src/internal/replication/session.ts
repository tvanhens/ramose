import type { Db } from "../core/db.ts";
import type { AttributeSpec } from "../core/schema.ts";
import type { ReadCompatibilityHash } from "../authorization/identities.ts";
import {
  IndexedDbReplicaStorage,
  type BoundRestoredReplica,
  type ReplicaCacheCandidate,
  type ReplicaCacheCandidateKey,
  type ReplicaOrdinalAcknowledgement,
  type RestoredReplica,
} from "./indexeddb.ts";
import {
  ReplicaCorruptError,
  replicaRefused,
  restoredReplica,
  type ReplicaRestoreOutcome,
} from "./replica-integrity.ts";
import { sameReplicationIdentity } from "./state.ts";
import {
  identityInDatabase,
  isReplicaFenceError,
  replicaDatabaseKey,
  replicaDatabaseScopeOf,
  replicaPartitionKey,
  ReplicaLease,
  replicaScopeOf,
} from "./replica-lifecycle.ts";
import type { ReplicationFrame, ReplicationIdentity } from "./protocol.ts";
import { satisfiesActivationFence } from "./activation-fence.ts";
import {
  openReplicationResponse,
  readReplicationFrames,
  replicationActivationAddress,
  replicationCacheSelector,
  replicationCredentialFingerprint,
  ReplicationUnauthorizedError,
  type ReplicationActivationInput,
} from "./transport.ts";
import {
  replicaRoutePathKey,
  replicaRouteScope,
  replicaRouteSlotFor,
  stableReplicaRouteSlot,
  type ReplicaRouteSlot,
} from "./route-slot.ts";

export type ReplicationSessionValue = {
  readonly db: Db;
  readonly identity: ReplicationIdentity;
  readonly revision: string;
  readonly ordinal: number;
  readonly settled: number;
  readonly handles: ReadonlyMap<string, number>;
  readonly stale: boolean;
};

export type ReplicationSessionSnapshot = {
  readonly status: "connecting" | "open" | "terminal" | "failed" | "closed";
  readonly value?: ReplicationSessionValue;
  readonly terminalCode?: "closed" | "incompatible-version" | "update-required";
  readonly failure?: "unauthorized" | "transport" | "fenced";
};

export type ReplicationSessionObserver = (snapshot: ReplicationSessionSnapshot) => void;

export type ReplicationSessionOptions = {
  readonly activation: ReplicationActivationInput;
  readonly credential: string;
  readonly cacheKey?: string;
  readonly graphLineage?: readonly string[];
  readonly attributes: readonly AttributeSpec[];
  readonly readCompatibilityHash: ReadCompatibilityHash;
  readonly storage: IndexedDbReplicaStorage;
  readonly onActivationOutcome?: (() => void | Promise<void>) | undefined;
};

type ChangeFrame = Extract<ReplicationFrame, { readonly type: "Change" }>;
type TerminalFrame = Extract<ReplicationFrame, { readonly type: "TerminalError" }>;

export type ReplicationCandidateFrameAction =
  | "resume"
  | "change"
  | "acknowledge"
  | "duplicate"
  | "reset"
  | "snapshot"
  | "keep-alive"
  | "terminal"
  | "invalid";

export const classifyReplicationChange = (
  prior:
    | Pick<ReplicationSessionValue, "identity" | "revision" | "ordinal">
    | undefined,
  frame: ChangeFrame,
): "apply" | "acknowledge" | "duplicate" | "gap" => {
  if (prior === undefined || !sameReplicationIdentity(prior.identity, frame.identity)) {
    return "gap";
  }
  if (prior.revision === frame.revision) {
    return frame.ordinal > prior.ordinal ? "acknowledge" : "duplicate";
  }
  return prior.revision === frame.from ? "apply" : "gap";
};

export type ReplicationPublication = Pick<
  ReplicationSessionValue,
  "identity" | "ordinal"
>;

export const classifyReplicationAdoption = (
  published: ReplicationPublication | undefined,
  candidate: ReplicationPublication,
): "adopt" | "refuse" =>
  published !== undefined &&
    replicaPartitionKey(published.identity) ===
      replicaPartitionKey(candidate.identity) &&
    candidate.ordinal < published.ordinal
    ? "refuse"
    : "adopt";

export const classifyReplicationCandidateFrame = (
  prior:
    | Pick<ReplicaCacheCandidate, "identity" | "revision" | "ordinal">
    | undefined,
  frame: ReplicationFrame,
): ReplicationCandidateFrameAction => {
  switch (frame.type) {
    case "Reset":
      return "reset";
    case "SnapshotStart":
      return "snapshot";
    case "SnapshotChunk":
    case "SnapshotCommit":
      return "invalid";
    case "Change": {
      const disposition = classifyReplicationChange(prior, frame);
      return disposition === "gap" ? "invalid" : disposition === "apply"
        ? "change"
        : disposition;
    }
    case "ResumeReady":
      return prior !== undefined && prior.revision === frame.revision &&
          sameReplicationIdentity(prior.identity, frame.identity)
        ? "resume"
        : "invalid";
    case "KeepAlive":
      return prior !== undefined &&
          sameReplicationIdentity(prior.identity, frame.identity)
        ? "keep-alive"
        : "invalid";
    case "TerminalError":
      return frame.identity === undefined ? "invalid" : "terminal";
  }
};

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
  ordinal: replica.ordinal,
  settled: replica.settled,
  handles: replica.handles,
  stale,
});

type SessionRegistration = {
  readonly database: string;
  readonly releases: readonly (() => void)[];
};

const sessionRegistration = (
  storage: IndexedDbReplicaStorage,
  identity: ReplicationIdentity,
  close: () => Promise<void>,
): SessionRegistration => {
  const database = replicaDatabaseScopeOf(identity);
  return {
    database: replicaDatabaseKey(database),
    releases: [
      storage.pinDatabase(database),
      storage.enroll({ scope: replicaScopeOf(identity), database, close }),
    ],
  };
};

export class ReplicationSession {
  private readonly controller = new AbortController();
  private readonly observers = new Set<ReplicationSessionObserver>();
  private generation = 1;
  private loop: Promise<void>;
  private state: ReplicationSessionSnapshot;
  private readonly lease: ReplicaLease;
  private tracking: readonly (() => void)[] = [];
  private trackedDatabase: string | undefined;
  private releaseRetention: (() => void) | undefined;
  private retainedDb: Db | undefined;
  private publication: ReplicationPublication | undefined;
  private confirmedIdentity: ReplicationIdentity | undefined;
  private bound: string | undefined;
  private refreshing: Promise<void> = Promise.resolve();
  private fenced = false;

  private constructor(
    private readonly storage: IndexedDbReplicaStorage,
    private readonly attributes: readonly AttributeSpec[],
    private readonly readCompatibilityHash: ReadCompatibilityHash,
    private readonly onActivationOutcome:
      | (() => void | Promise<void>)
      | undefined,
    initial: BoundRestoredReplica | undefined,
    lease: ReplicaLease,
    registration: SessionRegistration | undefined,
    retention: (() => void) | undefined,
    run: (session: ReplicationSession, generation: number) => Promise<void>,
  ) {
    this.lease = lease;
    this.releaseRetention = retention;
    this.retainedDb = initial?.db;
    this.confirmedIdentity = initial?.identity;
    this.state = Object.freeze({
      status: "connecting",
      ...(initial === undefined
        ? {}
        : { value: valueFrom(initial.identity, initial, true) }),
    });
    this.publication = this.state.value;
    if (registration !== undefined) {
      this.trackedDatabase = registration.database;
      this.tracking = registration.releases;
    }
    this.loop = run(this, this.generation);
  }

  refreshFromDurable(): Promise<boolean> {
    const next = this.refreshing.then(
      () => this.readDurableHead(),
      () => this.readDurableHead(),
    );
    this.refreshing = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async readDurableHead(): Promise<boolean> {
    const status = this.state.status;
    if (status !== "failed" && status !== "terminal") return false;
    const held = this.state.value?.identity ?? this.confirmedIdentity;
    if (held === undefined) return false;
    const generation = this.generation;
    const identity = await this.currentIdentity(held);
    const restored = restoredReplica(
      await this.storage.restoreOutcome(
        identity,
        this.attributes,
        this.readCompatibilityHash,
      ),
    );
    if (restored === undefined) return false;
    const published = this.state.value;
    if (
      !this.current(generation) ||
      (restored.revision === published?.revision &&
        sameReplicationIdentity(identity, published.identity)) ||
      !this.admits(identity, restored.ordinal)
    ) {
      restored.release();
      return false;
    }
    this.adopt(restored);
    this.confirmedIdentity = identity;
    this.publish(Object.freeze({
      ...this.state,
      value: valueFrom(identity, restored, published?.stale ?? true),
    }));
    return true;
  }

  private async currentIdentity(
    held: ReplicationIdentity,
  ): Promise<ReplicationIdentity> {
    if (this.bound === undefined) return held;
    const bound = await this.storage.boundIdentity(this.bound)
      .catch(() => undefined);
    if (
      bound === undefined ||
      bound.readCompatibilityHash !== this.readCompatibilityHash ||
      !identityInDatabase(bound, replicaDatabaseScopeOf(held))
    ) {
      return held;
    }
    return bound;
  }

  async revalidate(): Promise<boolean> {
    const identity = this.state.value?.identity ?? this.confirmedIdentity;
    const generation = this.generation;
    if (identity === undefined || !this.current(generation)) return false;
    try {
      await this.storage.confirmLease(this.lease, identity);
      return false;
    } catch (error) {
      if (!isReplicaFenceError(error) || !this.current(generation)) return false;
      this.publish({ status: "failed", failure: "fenced" });
      this.controller.abort(error);
      return true;
    }
  }

  private track(identity: ReplicationIdentity): void {
    const database = replicaDatabaseScopeOf(identity);
    const key = replicaDatabaseKey(database);
    this.confirmedIdentity = identity;
    if (this.trackedDatabase === key) return;
    this.untrack();
    const registration = sessionRegistration(this.storage, identity, () => this.close());
    this.trackedDatabase = registration.database;
    this.tracking = registration.releases;
  }

  private untrack(): void {
    for (const release of this.tracking) release();
    this.tracking = [];
    this.trackedDatabase = undefined;
  }

  static async open(options: ReplicationSessionOptions): Promise<ReplicationSession> {
    const admission = await options.storage.admission();
    const activation = replicationActivationAddress(options.activation);
    const observation = {
      scope: await replicaRouteScope(activation),
      pathKey: await replicaRoutePathKey(activation.graphPath),
    };
    const observedSlot = options.graphLineage !== undefined
      ? undefined
      : await options.storage.observedRouteSlot(observation);
    const routeSlot: ReplicaRouteSlot = observedSlot ?? await replicaRouteSlotFor({
      graphPath: activation.graphPath,
      lineage: options.graphLineage,
    });
    const slotConfirmed = activation.graphPath.length === 0 || observedSlot !== undefined;
    const [fingerprint, selector] = await Promise.all([
      replicationCredentialFingerprint(options.credential, activation, routeSlot),
      options.cacheKey === undefined
        ? undefined
        : replicationCacheSelector(options.cacheKey, activation),
    ]);
    const candidateKey: ReplicaCacheCandidateKey | undefined = selector === undefined
      ? undefined
      : { selector, routeSlot };
    const restored = restoredReplica(
      await options.storage.restoreBoundOutcome(
        fingerprint,
        options.attributes,
        options.readCompatibilityHash,
      ),
    );
    let live: ReplicationSession | undefined;
    let closedBeforeStart = false;
    const registration = restored === undefined ? undefined : sessionRegistration(
      options.storage,
      restored.identity,
      async () => {
        closedBeforeStart = true;
        await live?.close();
      },
    );
    const retention = restored?.release;
    let candidate: ReplicaCacheCandidate | undefined;
    let lease: ReplicaLease;
    try {
      candidate = restored === undefined && candidateKey !== undefined
        ? await options.storage.selectCacheCandidate(
          candidateKey,
          options.readCompatibilityHash,
        )
        : undefined;
      lease = new ReplicaLease(admission);
      if (restored !== undefined) {
        await options.storage.confirmLease(lease, restored.identity);
      }
    } catch (error) {
      for (const release of registration?.releases ?? []) release();
      retention?.();
      throw error;
    }
    const session = new ReplicationSession(
      options.storage,
      options.attributes,
      options.readCompatibilityHash,
      options.onActivationOutcome,
      restored,
      lease,
      registration,
      retention,
      async (session, generation) => {
        session.bound = fingerprint;
        let responseIdentity: ReplicationIdentity | undefined;
        let bindingConfirmed = restored !== undefined && candidateKey === undefined &&
          slotConfirmed;
        try {
          const response = await openReplicationResponse({
            activation,
            credential: options.credential,
            ...(restored?.revision === undefined && candidate?.revision === undefined
              ? {}
              : { resumeRevision: restored?.revision ?? candidate!.revision }),
            signal: session.controller.signal,
            readCompatibilityHash: options.readCompatibilityHash,
          });
          for await (const frame of readReplicationFrames(response, session.controller.signal)) {
            if (!session.current(generation)) return;
            const frameIdentity = identityOf(frame);
            if (frameIdentity !== undefined) {
              if (frameIdentity.readCompatibilityHash !== options.readCompatibilityHash) {
                session.quarantine(generation);
                throw new Error("replication identity does not confirm the installed read compatibility");
              }
              if (frameIdentity.graphLineage.length !== activation.graphPath.length) {
                session.quarantine(generation);
                throw new Error("replication identity does not describe every path segment");
              }
              if (responseIdentity === undefined) {
                responseIdentity = frameIdentity;
                session.track(frameIdentity);
                if (
                  session.state.value !== undefined &&
                  !sameReplicationIdentity(session.state.value.identity, frameIdentity)
                ) {
                  session.quarantine(generation);
                  bindingConfirmed = false;
                }
              } else if (!sameReplicationIdentity(responseIdentity, frameIdentity)) {
                session.quarantine(generation);
                throw new Error("replication frame identity changed within one response");
              }
              if (!bindingConfirmed) {
                const prior = session.state.value ?? candidate;
                const action = classifyReplicationCandidateFrame(prior, frame);
                if (action === "invalid") {
                  throw new Error("first authenticated frame cannot confirm a cached replica");
                }
                const confirmedSlot = await stableReplicaRouteSlot(frameIdentity.graphLineage);
                const confirmedFingerprint = confirmedSlot === routeSlot
                  ? fingerprint
                  : await replicationCredentialFingerprint(
                    options.credential,
                    activation,
                    confirmedSlot,
                  );
                await options.storage.bindAuthenticated({
                  fingerprint: confirmedFingerprint,
                  identity: frameIdentity,
                  ...(candidateKey === undefined
                    ? {}
                    : { candidateKey: { selector: candidateKey.selector, routeSlot: confirmedSlot } }),
                  route: {
                    ...observation,
                    slot: confirmedSlot,
                    graphPath: activation.graphPath,
                  },
                }, { signal: session.controller.signal, lease: session.lease });
                if (!session.current(generation)) return;
                session.bound = confirmedFingerprint;
                bindingConfirmed = true;
                if (session.state.value === undefined) {
                  const terminal = await session.acceptConfirmedInitial(
                    frame,
                    prior,
                    action,
                    generation,
                  );
                  if (terminal) return;
                  continue;
                }
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
          if (error instanceof ReplicationUnauthorizedError) {
            await options.storage.unbindCredential(fingerprint)
              .catch(() => undefined);
          }
          if (session.controller.signal.aborted || !session.current(generation)) return;
          if (isReplicaFenceError(error)) {
            session.publish({ status: "failed", failure: "fenced" });
            session.controller.abort(error);
            return;
          }
          session.publish({
            status: "failed",
            failure: error instanceof ReplicationUnauthorizedError
              ? "unauthorized"
              : "transport",
            ...(session.state.value === undefined ? {} : { value: session.state.value }),
          });
          session.controller.abort(error);
        }
      },
    );
    live = session;
    if (closedBeforeStart) await session.close();
    return session;
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
    this.untrack();
    this.generation++;
    this.controller.abort(new DOMException("replication session closed", "AbortError"));
    try {
      await this.loop;
    } catch {
    }
    this.release();
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
    if (snapshot.value === undefined) this.release();
    this.publication = snapshot.value;
    this.state = Object.freeze(snapshot);
    for (const observer of this.observers) this.notify(observer);
  }

  private admits(identity: ReplicationIdentity, ordinal: number): boolean {
    return classifyReplicationAdoption(this.publication, { identity, ordinal }) ===
      "adopt";
  }

  private async acknowledge(
    acknowledgement: ReplicaOrdinalAcknowledgement,
    generation: number,
  ): Promise<number | undefined> {
    const acknowledged = await this.storage.acknowledgeOrdinal(acknowledgement, {
      signal: this.controller.signal,
      lease: this.lease,
    });
    if (!this.current(generation)) return undefined;
    if (acknowledged === undefined) {
      this.quarantine(generation);
      throw new Error("replication acknowledgement does not match the durable revision");
    }
    return acknowledged;
  }

  private adopt(replica: RestoredReplica): void {
    if (replica.db === this.retainedDb) {
      replica.release();
      return;
    }
    this.releaseRetention?.();
    this.releaseRetention = replica.release;
    this.retainedDb = replica.db;
  }

  private release(): void {
    this.releaseRetention?.();
    this.releaseRetention = undefined;
    this.retainedDb = undefined;
  }

  private notify(observer: ReplicationSessionObserver): void {
    try {
      observer(this.state);
    } catch {
    }
  }

  private async settled(
    frame: ReplicationFrame,
    generation: number,
  ): Promise<void> {
    const hook = this.onActivationOutcome;
    if (hook === undefined || this.fenced || !this.current(generation)) return;
    if (!satisfiesActivationFence(frame.type)) return;
    this.fenced = true;
    try {
      await hook();
    } catch {
      this.fenced = false;
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
    if (!this.current(generation) || !this.admits(identity, replica.ordinal)) {
      replica.release();
      return;
    }
    this.adopt(replica);
    this.publish({ status: "open", value: valueFrom(identity, replica, stale) });
  }

  private publishStale(
    identity: ReplicationIdentity,
    replica: RestoredReplica,
    generation: number,
  ): void {
    if (!this.current(generation) || !this.admits(identity, replica.ordinal)) {
      replica.release();
      return;
    }
    this.adopt(replica);
    this.publish({
      status: "connecting",
      value: valueFrom(identity, replica, true),
    });
  }

  private async confirmedCandidate(
    prior: Pick<ReplicaCacheCandidate, "identity" | "revision" | "ordinal">,
  ): Promise<BoundRestoredReplica> {
    return this.confirmed(
      await this.storage.restoreCandidateOutcome(
        prior,
        this.attributes,
        this.readCompatibilityHash,
      ),
    );
  }

  private confirmed<A>(outcome: ReplicaRestoreOutcome<A>): A {
    const replica = restoredReplica(outcome);
    if (replica !== undefined) return replica;
    if (replicaRefused(outcome)) {
      throw new ReplicaCorruptError({
        partition: outcome.partition,
        reason: outcome.reason,
        detail: outcome.detail,
      });
    }
    throw new Error("authenticated cache candidate changed before restore");
  }

  private async acceptConfirmedInitial(
    frame: ReplicationFrame,
    prior:
      | Pick<ReplicaCacheCandidate, "identity" | "revision" | "ordinal">
      | undefined,
    action: Exclude<ReplicationCandidateFrameAction, "invalid">,
    generation: number,
  ): Promise<boolean> {
    switch (action) {
      case "resume":
      case "acknowledge":
      case "duplicate": {
        if (
          prior === undefined ||
          (action === "resume" && frame.type !== "ResumeReady") ||
          (action !== "resume" && frame.type !== "Change")
        ) {
          throw new Error("authenticated resume has no cached replica candidate");
        }
        if (
          action !== "duplicate" &&
          (frame.type === "ResumeReady" || frame.type === "Change")
        ) {
          if (await this.acknowledge(frame, generation) === undefined) return false;
        }
        const restored = await this.confirmedCandidate(prior);
        this.publishReplica(restored.identity, restored, false, generation);
        await this.settled(frame, generation);
        return false;
      }
      case "change": {
        if (frame.type !== "Change" || prior === undefined) {
          throw new Error("authenticated candidate action disagrees with its frame");
        }
        (await this.confirmedCandidate(prior)).release();
        if (!this.current(generation)) return false;
        const installed = await this.storage.applyChange(frame, {
          signal: this.controller.signal,
          lease: this.lease,
        });
        if (installed === undefined || installed.revision !== frame.revision) {
          installed?.release();
          throw new Error("authenticated change did not continue the cache candidate");
        }
        this.publishReplica(frame.identity, installed, false, generation);
        await this.settled(frame, generation);
        return false;
      }
      case "reset":
      case "snapshot": {
        if (
          (frame.type !== "Reset" && frame.type !== "SnapshotStart") ||
          (action === "reset" && frame.type !== "Reset") ||
          (action === "snapshot" && frame.type !== "SnapshotStart")
        ) {
          throw new Error("authenticated candidate action disagrees with its frame");
        }
        const restored = restoredReplica(
          await this.storage.restoreOutcome(
            frame.identity,
            this.attributes,
            this.readCompatibilityHash,
          ),
        );
        if (!this.current(generation)) {
          restored?.release();
          return false;
        }
        const terminal = await this.accept(frame, generation);
        if (terminal || !this.current(generation)) {
          restored?.release();
          return terminal;
        }
        if (restored !== undefined) {
          this.publishStale(frame.identity, restored, generation);
        }
        return false;
      }
      case "keep-alive": {
        if (prior === undefined || frame.type !== "KeepAlive") {
          throw new Error("authenticated candidate action disagrees with its frame");
        }
        const restored = await this.confirmedCandidate(prior);
        this.publishStale(frame.identity, restored, generation);
        return false;
      }
      case "terminal":
        if (frame.type !== "TerminalError" || frame.identity === undefined) {
          throw new Error("authenticated candidate action disagrees with its frame");
        }
        return this.accept(frame, generation);
    }
  }

  private async accept(frame: ReplicationFrame, generation: number): Promise<boolean> {
    if (!this.current(generation)) return true;
    switch (frame.type) {
      case "Reset":
        await this.storage.resetStaging(frame.identity, {
          signal: this.controller.signal,
          lease: this.lease,
        });
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
        await this.storage.startSnapshot(frame, {
          signal: this.controller.signal,
          lease: this.lease,
        });
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
        await this.storage.stageSnapshotChunk(frame, {
          signal: this.controller.signal,
          lease: this.lease,
        });
        return false;
      case "SnapshotCommit": {
        const installed = await this.storage.commitSnapshot(
          frame,
          this.attributes,
          { signal: this.controller.signal, lease: this.lease },
        );
        if (installed === undefined) return false;
        if (installed.revision !== frame.revision) {
          installed.release();
          throw new Error("replication snapshot does not install the committed revision");
        }
        this.publishReplica(frame.identity, installed, false, generation);
        await this.settled(frame, generation);
        return false;
      }
      case "Change": {
        const prior = this.state.value;
        const disposition = classifyReplicationChange(prior, frame);
        if (prior === undefined || disposition === "gap") {
          throw new Error("replication change does not continue the committed revision");
        }
        if (disposition === "duplicate") {
          await this.settled(frame, generation);
          return false;
        }
        if (disposition === "acknowledge") {
          const acknowledged = await this.acknowledge(frame, generation);
          if (acknowledged === undefined) return true;
          this.publish({
            status: "open",
            value: Object.freeze({
              ...prior,
              ordinal: Math.max(prior.ordinal, acknowledged),
              stale: false,
            }),
          });
          await this.settled(frame, generation);
          return false;
        }
        const installed = await this.storage.applyChange(frame, {
          signal: this.controller.signal,
          lease: this.lease,
        });
        if (installed === undefined || installed.revision !== frame.revision) {
          installed?.release();
          throw new Error("replication change does not continue the durable revision");
        }
        this.publishReplica(frame.identity, installed, false, generation);
        await this.settled(frame, generation);
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
        const acknowledged = await this.acknowledge(frame, generation);
        if (acknowledged === undefined) return true;
        this.publish({
          status: "open",
          value: Object.freeze({
            ...prior,
            ordinal: Math.max(prior.ordinal, acknowledged),
            stale: false,
          }),
        });
        await this.settled(frame, generation);
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
