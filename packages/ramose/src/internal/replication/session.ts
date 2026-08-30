/** Framework-neutral coordinator for one activated database replication stream. */

import type { Db } from "../core/db.ts";
import type { AttributeSpec } from "../core/schema.ts";
import type { ReadCompatibilityHash } from "../authorization/identities.ts";
import {
  IndexedDbReplicaStorage,
  type BoundRestoredReplica,
  type ReplicaCacheCandidate,
  type ReplicaCacheCandidateKey,
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
  replicaDatabaseKey,
  replicaDatabaseScopeOf,
  replicaScopeOf,
  type ReplicaLease,
} from "./replica-lifecycle.ts";
import type { ReplicationFrame, ReplicationIdentity } from "./protocol.ts";
import {
  openReplicationResponse,
  readReplicationFrames,
  replicationActivationAddress,
  replicationCacheSelector,
  replicationCredentialFingerprint,
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
  readonly stale: boolean;
};

export type ReplicationSessionSnapshot = {
  readonly status: "connecting" | "open" | "terminal" | "failed" | "closed";
  readonly value?: ReplicationSessionValue;
  /** Present for a protocol terminal; absent for clean unexpected EOF. */
  readonly terminalCode?: "closed" | "incompatible-version" | "update-required";
};

export type ReplicationSessionObserver = (snapshot: ReplicationSessionSnapshot) => void;

export type ReplicationSessionOptions = {
  readonly activation: ReplicationActivationInput;
  readonly credential: string;
  /** Internal foundation for #477's refreshable auth provider; never authority. */
  readonly cacheKey?: string;
  /**
   * Optional pre-flight stable Graph lineage for this path, as already
   * confirmed by the parent replica. #477 supplies it from an interned graph
   * handle; without it the client falls back to the durable observation table
   * and then to a provisional path-derived slot. Never authority either way.
   */
  readonly graphLineage?: readonly string[];
  readonly attributes: readonly AttributeSpec[];
  readonly readCompatibilityHash: ReadCompatibilityHash;
  readonly storage: IndexedDbReplicaStorage;
};

type ChangeFrame = Extract<ReplicationFrame, { readonly type: "Change" }>;
type TerminalFrame = Extract<ReplicationFrame, { readonly type: "TerminalError" }>;

export type ReplicationCandidateFrameAction =
  | "resume"
  | "change"
  | "duplicate"
  | "reset"
  | "snapshot"
  | "keep-alive"
  | "terminal"
  | "invalid";

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

/**
 * Decide whether the first authenticated frame can safely confirm a
 * metadata-only candidate. Snapshot fragments and revision gaps never do.
 */
export const classifyReplicationCandidateFrame = (
  prior: Pick<ReplicaCacheCandidate, "identity" | "revision"> | undefined,
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
      return disposition === "gap"
        ? "invalid"
        : disposition === "apply"
          ? "change"
          : "duplicate";
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

type SessionRegistration = {
  readonly database: string;
  readonly releases: readonly (() => void)[];
};

/**
 * Pin one database and enroll one participant in a single synchronous step, so
 * no await can separate reading a replica from becoming visible to a clear or
 * an eviction.
 */
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
  /**
   * The lifecycle lease this session writes under. A scoped clear or a
   * database eviction bumps the durable generation it holds, so every later
   * install of this session is refused rather than interleaved.
   */
  private readonly lease: ReplicaLease;
  private tracking: readonly (() => void)[] = [];
  private trackedDatabase: string | undefined;
  /**
   * The roots of the value this session currently publishes, kept alive against
   * reachability GC. A published `Db` reads its nodes directly and no longer
   * depends on the manifest, so a sweep that reclaimed superseded roots would
   * otherwise turn it into a value that throws mid-query.
   */
  private releaseRetention: (() => void) | undefined;
  private retainedDb: Db | undefined;

  private constructor(
    private readonly storage: IndexedDbReplicaStorage,
    private readonly attributes: readonly AttributeSpec[],
    private readonly readCompatibilityHash: ReadCompatibilityHash,
    initial: BoundRestoredReplica | undefined,
    lease: ReplicaLease,
    registration: SessionRegistration | undefined,
    retention: (() => void) | undefined,
    run: (session: ReplicationSession, generation: number) => Promise<void>,
  ) {
    this.lease = lease;
    // Adopt the retention `open` took in the same synchronous block as the pin,
    // rather than taking a second one over the same roots.
    this.releaseRetention = retention;
    this.retainedDb = initial?.db;
    this.state = Object.freeze({
      status: "connecting",
      ...(initial === undefined
        ? {}
        : { value: valueFrom(initial.identity, initial, true) }),
    });
    // Adopt the registration `open` already took, rather than taking a second.
    if (registration !== undefined) {
      this.trackedDatabase = registration.database;
      this.tracking = registration.releases;
    }
    this.loop = run(this, this.generation);
  }

  /**
   * Pin the database this session reads and enroll the session so destructive
   * maintenance closes it deterministically before deleting anything. A
   * response that selects a different database than the restored one retargets
   * both registrations, so the abandoned database is not left pinned and the
   * newly authenticated one is the realm a clear or eviction acts on.
   */
  private track(identity: ReplicationIdentity): void {
    const database = replicaDatabaseScopeOf(identity);
    const key = replicaDatabaseKey(database);
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
    const activation = replicationActivationAddress(options.activation);
    const observation = {
      scope: await replicaRouteScope(activation),
      pathKey: await replicaRoutePathKey(activation.graphPath),
    };
    // Prefer a caller-resolved lineage, then a durable observation of this path
    // text, and only then the provisional path slot. The root is always fixed.
    const observedSlot = options.graphLineage !== undefined
      ? undefined
      : await options.storage.observedRouteSlot(observation);
    const routeSlot: ReplicaRouteSlot = observedSlot ?? await replicaRouteSlotFor({
      graphPath: activation.graphPath,
      lineage: options.graphLineage,
    });
    // A provisional slot must be re-keyed onto the stable slot the current
    // response confirms, so it can never stand in as a confirmed binding.
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
    // A corrupt or incompatible partition has already been quarantined by the
    // time this returns, and it publishes nothing. The session then simply
    // opens with no resume revision, so the server replaces the whole replica
    // with a fresh snapshot into the very same scope.
    const restored = restoredReplica(
      await options.storage.restoreBoundOutcome(
        fingerprint,
        options.attributes,
        options.readCompatibilityHash,
      ),
    );
    // Register before the next await. Destructive maintenance that begins in
    // the gap between reading this replica and constructing its session must
    // already see the pin and the enrolment, or it would delete the nodes this
    // value depends on and return without having closed anything.
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
    // The storage already retained this value's roots — synchronously, before
    // the transaction that cleared it to be handed back — so the session adopts
    // that retention rather than taking a second one. Taking its own here would
    // be strictly too late: a sweep that planned while nothing was retained can
    // create its transaction after the publish fence's and still delete these
    // nodes, and only a retention that exists before that fence closes it.
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
      // A restored session skips `bindAuthenticated`, so it must take its
      // lease over the current generations before it can write anything; an
      // empty lease would otherwise adopt a generation a concurrent clear had
      // already bumped and repopulate the scope that clear just emptied.
      lease = restored === undefined
        ? options.storage.lease()
        : await options.storage.leaseFor(restored.identity);
    } catch (error) {
      for (const release of registration?.releases ?? []) release();
      retention?.();
      throw error;
    }
    const session = new ReplicationSession(
      options.storage,
      options.attributes,
      options.readCompatibilityHash,
      restored,
      lease,
      registration,
      retention,
      async (session, generation) => {
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
                // Re-key every local slot onto the lineage this response
                // authenticated. Path text never survives as a lookup key.
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
                  route: { ...observation, slot: confirmedSlot },
                }, { signal: session.controller.signal, lease: session.lease });
                if (!session.current(generation)) return;
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
          if (session.controller.signal.aborted || !session.current(generation)) return;
          session.publish({
            status: "failed",
            ...(session.state.value === undefined ? {} : { value: session.state.value }),
          });
          session.controller.abort(error);
        }
      },
    );
    live = session;
    // Maintenance closed this session while it was still being built, so it
    // must never be handed back live over data that no longer exists.
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
      // Close owns cancellation; non-cancellation failures were already observed.
    }
    // A closed session is no longer a live holder, so its last value stops
    // retaining nodes. The snapshot keeps carrying it for observers that are
    // mid-render; nothing rebuilds a query from it.
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
    // A snapshot carrying no value drops whatever this session was holding; one
    // carrying the same `Db` (a stale flag flipping, a terminal keeping its
    // last value) keeps the retention it already adopted. A snapshot carrying a
    // *different* `Db` only ever arrives through `adopt` below, which has
    // already moved the retention across.
    if (snapshot.value === undefined) this.release();
    this.state = Object.freeze(snapshot);
    for (const observer of this.observers) this.notify(observer);
  }

  /**
   * Take over the retention the storage handed out with a value.
   *
   * Every value the storage returns arrives already retained — taken
   * synchronously, before the transaction that cleared it to be handed back —
   * so the session never takes its own and never has to be fast enough. It
   * owns exactly one release per value: adopting a new one releases the value
   * it replaces, which is correct, because superseded roots are precisely what
   * a sweep exists to reclaim. Adopting the same `Db` twice releases the
   * duplicate rather than leaking it.
   */
  private adopt(replica: RestoredReplica): void {
    if (replica.db === this.retainedDb) {
      replica.release();
      return;
    }
    this.releaseRetention?.();
    this.releaseRetention = replica.release;
    this.retainedDb = replica.db;
  }

  /** Drop this session's retention, if it still holds one. */
  private release(): void {
    this.releaseRetention?.();
    this.releaseRetention = undefined;
    this.retainedDb = undefined;
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
    if (!this.current(generation)) {
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
    if (!this.current(generation)) {
      replica.release();
      return;
    }
    this.adopt(replica);
    this.publish({
      status: "connecting",
      value: valueFrom(identity, replica, true),
    });
  }

  /**
   * A candidate the current response already confirmed, or a typed failure.
   *
   * There is no in-band recovery here: the server has acknowledged a revision
   * this client can no longer produce, and the partition that held it has just
   * been quarantined. Failing the session with the classification is what lets
   * a reconnect start with no resume revision and take a fresh snapshot,
   * instead of publishing a value assembled from storage that was refused.
   */
  /**
   * The one entry point through which a metadata-only candidate becomes a
   * validated partition.
   *
   * A candidate is the first time this session touches its partition, and the
   * storage only walks a partition when it is asked to restore one. Every
   * first-authenticated-frame branch therefore goes through here — including
   * the ones that discard the value and continue the partition instead of
   * publishing it, because continuing an unwalked journal is exactly how a
   * drifted one would reach a published `Db`.
   */
  private async confirmedCandidate(
    prior: Pick<ReplicaCacheCandidate, "identity" | "revision">,
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

  /**
   * Consume the first authenticated frame without ever publishing the
   * metadata-only candidate that nominated its resume revision.
   */
  private async acceptConfirmedInitial(
    frame: ReplicationFrame,
    prior: Pick<ReplicaCacheCandidate, "identity" | "revision"> | undefined,
    action: Exclude<ReplicationCandidateFrameAction, "invalid">,
    generation: number,
  ): Promise<boolean> {
    switch (action) {
      case "resume":
      case "duplicate": {
        if (
          prior === undefined ||
          (action === "resume" && frame.type !== "ResumeReady") ||
          (action === "duplicate" && frame.type !== "Change")
        ) {
          throw new Error("authenticated resume has no cached replica candidate");
        }
        const restored = await this.confirmedCandidate(prior);
        this.publishReplica(restored.identity, restored, false, generation);
        return false;
      }
      case "change": {
        if (frame.type !== "Change" || prior === undefined) {
          throw new Error("authenticated candidate action disagrees with its frame");
        }
        // `applyChange` continues the stored partition without re-reading it
        // through the integrity walk, because the steady-state path has always
        // validated at open. This path has not: a metadata-only candidate is
        // the first time this partition is touched, and the change is about to
        // be combined with a journal nothing has checked. Validate it first —
        // the result is discarded, since the change supersedes it, so its
        // retention is released rather than leaked.
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
        // Validate — and if it comes to it, quarantine — the committed value
        // before this frame stages its replacement. Quarantine leaves staging
        // alone, but it does remove the committed manifest, so running it
        // afterwards would move the base revision out from under a staging
        // record already opened against it and that snapshot's commit could
        // never install. Doing it first lets the new staging record observe the
        // absent committed revision as its base instead, so the commit is
        // unconditionally installable.
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
        // A quarantined partition simply publishes nothing here; the snapshot
        // this response is already sending replaces it.
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

  /** Returns true after a terminal frame. */
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
        if (installed.revision === frame.revision) {
          this.publishReplica(frame.identity, installed, false, generation);
        } else {
          // A lost CAS: the value is not the one this frame names, so it is
          // never published and its retention is released rather than leaked.
          installed.release();
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
          lease: this.lease,
        });
        if (installed === undefined) return false;
        if (installed.revision === frame.revision) {
          this.publishReplica(frame.identity, installed, false, generation);
        } else {
          // A lost CAS: the value is not the one this frame names, so it is
          // never published and its retention is released rather than leaked.
          installed.release();
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
