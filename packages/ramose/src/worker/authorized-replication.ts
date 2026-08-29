/**
 * Public database-replication stream over the real authorization and Replica
 * topology. This is deliberately separate from the raw testing-only session
 * wire: only complete authorized logical values enter these frames.
 */

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { RamoseEnv } from "../RamoseEnv.ts";
import {
  MAX_READ_LEASE_MS,
  constructAuthorizedResolvedRequestContext,
  executeAuthorizedGraphPathTarget,
  graphPathLeaseIdentity,
  sameGraphPathLeaseIdentity,
  type AuthenticatedCaller,
  type AuthorizedGraphPathTarget,
  type DatabaseCatalogBindings,
  type GraphPathLeaseIdentity,
  type ResolvedDatabaseRoute,
} from "../internal/authorization/index.ts";
import type { Db } from "../internal/core/db.ts";
import type { RuntimeBoundaries } from "../internal/runtime-boundaries.ts";
import {
  chunkStillAuthorized,
  digestLogicalDb,
  diffLogicalDbs,
  encodeReplicationFrame,
  makeLogicalIdentityEncoder,
  makeReplicationIdentity,
  makeRevision,
  makeSnapshotIdentity,
  replicationFrameFitsBound,
  sameReplicationIdentity,
  snapshotEntryChunks,
  REPLICATION_PROTOCOL_VERSION,
  type ActivationRequest,
  type LogicalIdentityEncoder,
  type OpaqueReplicationId,
  type ReplicationFrame,
  type ReplicationIdentity,
} from "../internal/replication/index.ts";
import { callerFromVerified } from "../internal/authorization/request.ts";
import { authenticateRequest } from "./admit.ts";
import { acquireCurrentDb } from "./authorized-read.ts";
import { JwtVerifier } from "./jwt.ts";
import {
  rememberReplicationRevision,
  resolveReplicationRevision,
  watchBasisChanges,
} from "./peer.ts";

const encoder = new TextEncoder();
const ABORTED = Symbol("ramose/replication/aborted");
const WATCH_FAILED = Symbol("ramose/replication/watch-failed");
const REPLICATION_CYCLE_INTERVAL_MS = MAX_READ_LEASE_MS;

class ReplicationRuntimeError extends Data.TaggedError(
  "ReplicationRuntimeError",
)<{ readonly reason: string; readonly cause?: unknown }> {}

class ResumeBasisUnavailable extends Data.TaggedError(
  "ResumeBasisUnavailable",
)<{ readonly cause: unknown }> {}

const runtimeError = (reason: string, cause?: unknown): ReplicationRuntimeError =>
  cause === undefined
    ? new ReplicationRuntimeError({ reason })
    : new ReplicationRuntimeError({ reason, cause });

// The response stream, rather than the Effect fiber, owns this controller.
const makeStreamAbortController = (): AbortController => new AbortController();

type AuthorizedVersion = {
  readonly caller: AuthenticatedCaller;
  readonly target: AuthorizedGraphPathTarget;
  readonly pathIdentity: GraphPathLeaseIdentity;
  readonly identity: ReplicationIdentity;
  readonly leaseExpiresAt: number;
};

type ServerReplicaState = {
  readonly version: AuthorizedVersion;
  readonly basisT: number;
  readonly revision: OpaqueReplicationId;
};

export type AuthorizedReplicationInput = {
  readonly activation: ActivationRequest;
  readonly env: RamoseEnv;
  readonly request: Request;
  readonly bindings: DatabaseCatalogBindings;
  readonly root: ResolvedDatabaseRoute;
  readonly initialCaller: AuthenticatedCaller;
  readonly initialTarget: AuthorizedGraphPathTarget;
  readonly headers: Record<string, string>;
  readonly boundaries?: RuntimeBoundaries;
};

const frame = <A extends ReplicationFrame>(value: A): A => value;

const abortable = async <A>(
  promise: Promise<A>,
  signal: AbortSignal,
): Promise<A> => {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("replication aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
};

const atBoundary = async (
  boundaries: RuntimeBoundaries | undefined,
  name: string,
  signal: AbortSignal,
): Promise<void> => {
  signal.throwIfAborted();
  if (boundaries === undefined) return;
  try {
    await abortable(boundaries.checkpoint(name), signal);
  } catch (cause) {
    // If the effective watch signal wins the race, dispose the source-only
    // parked waiter in its creating request context before failing closed.
    boundaries.checkpointCancel?.(name);
    throw cause;
  }
  signal.throwIfAborted();
};

const abortPromise = (signal: AbortSignal): Promise<typeof ABORTED> =>
  signal.aborted
    ? Promise.resolve(ABORTED)
    : new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
      });

const scheduledCycle = (milliseconds: number): {
  readonly promise: Promise<"cycle">;
  readonly cancel: () => void;
} => {
  const controller = new AbortController();
  const promise = scheduler.wait(milliseconds, { signal: controller.signal })
    .then(() => "cycle" as const)
    .catch((cause): Promise<never> =>
      controller.signal.aborted
        ? new Promise<never>(() => undefined)
        : Promise.reject(cause)
    );
  return {
    promise,
    cancel: () => controller.abort(),
  };
};

const rawDatabase = (version: AuthorizedVersion): string =>
  version.target.route.database;

const leaseAlive = (version: AuthorizedVersion): boolean =>
  Date.now() < version.leaseExpiresAt;

const identityEncoder = (
  input: AuthorizedReplicationInput,
  version: AuthorizedVersion,
): LogicalIdentityEncoder =>
  makeLogicalIdentityEncoder(
    input.env.RAMOSE_INTERNAL_SECRET,
    version.identity.authenticator,
  );

const currentState = async (
  input: AuthorizedReplicationInput,
  version: AuthorizedVersion,
  logical: LogicalIdentityEncoder,
  signal: AbortSignal,
): Promise<ServerReplicaState> => {
  const stateDigest = await digestLogicalDb(
    version.target.context.filteredDb,
    logical,
    signal,
  );
  return Object.freeze({
    version,
    basisT: version.target.context.currentDb.basisT,
    revision: await makeRevision(
      input.env.RAMOSE_INTERNAL_SECRET,
      version.identity,
      stateDigest,
    ),
  });
};

const remember = (
  input: AuthorizedReplicationInput,
  state: ServerReplicaState,
): Promise<void> =>
  rememberReplicationRevision(
    input.env,
    rawDatabase(state.version),
    {
      revision: state.revision,
      binding: state.version.identity.authenticator,
      basisT: state.basisT,
    },
  );

const sameVersion = (
  expectedPath: GraphPathLeaseIdentity,
  expectedIdentity: ReplicationIdentity,
  version: AuthorizedVersion,
): boolean =>
  sameGraphPathLeaseIdentity(expectedPath, version.pathIdentity) &&
  sameReplicationIdentity(expectedIdentity, version.identity);

const snapshotFrames = async function* (
  input: AuthorizedReplicationInput,
  authorize: () => Promise<AuthorizedVersion>,
  expectedPath: GraphPathLeaseIdentity,
  expectedIdentity: ReplicationIdentity,
  signal: AbortSignal,
): AsyncGenerator<ReplicationFrame, ServerReplicaState, undefined> {
  for (;;) {
    let version = await authorize();
    if (!sameVersion(expectedPath, expectedIdentity, version)) {
      throw new Error("replication authorization partition changed");
    }
    const logical = identityEncoder(input, version);
    const candidate = await currentState(input, version, logical, signal);
    // Projection and hashing are bounded in memory, not necessarily in wall
    // time. If they consumed this authorization lease, discard the work
    // before any state-dependent frame crosses the boundary.
    if (!leaseAlive(version)) continue;
    const snapshot = await makeSnapshotIdentity(
      input.env.RAMOSE_INTERNAL_SECRET,
      version.identity,
      candidate.revision,
    );
    signal.throwIfAborted();
    yield frame({
      type: "SnapshotStart",
      protocol: REPLICATION_PROTOCOL_VERSION,
      identity: version.identity,
      snapshot,
      revision: candidate.revision,
    });

    let index = 0;
    let restart = false;
    let renewedSnapshot: Db | undefined;
    const authorizeChunk = async (
      entries: Parameters<typeof chunkStillAuthorized>[1],
    ): Promise<boolean> => {
      for (;;) {
        if (!leaseAlive(version)) {
          const renewed = await authorize();
          if (!sameVersion(expectedPath, expectedIdentity, renewed)) {
            throw new Error("replication authorization partition changed");
          }
          version = renewed;
          renewedSnapshot = renewed.target.context.filteredDb;
        }
        if (
          renewedSnapshot !== undefined &&
          !await chunkStillAuthorized(renewedSnapshot, entries, signal)
        ) return false;
        // Authorization may expire while a delayed chunk is checked. Repeat
        // under a fresh complete-path lease rather than emitting on the edge.
        if (leaseAlive(version)) {
          signal.throwIfAborted();
          return true;
        }
      }
    };
    for await (const entries of snapshotEntryChunks(
      version.target.context.filteredDb,
      logical,
      (datoms, chunkIndex) => replicationFrameFitsBound({
        type: "SnapshotChunk",
        protocol: REPLICATION_PROTOCOL_VERSION,
        identity: expectedIdentity,
        snapshot,
        index: chunkIndex,
        datoms,
      }),
      signal,
    )) {
      // After the first bounded renewal, every remaining chunk still comes
      // from the original immutable snapshot and must exist in the newest
      // complete authorized value before it can cross the public boundary.
      if (!await authorizeChunk(entries)) {
        restart = true;
        break;
      }
      await atBoundary(input.boundaries, "replication.snapshot.chunk", signal);
      if (!await authorizeChunk(entries)) {
        restart = true;
        break;
      }
      signal.throwIfAborted();
      yield frame({
        type: "SnapshotChunk",
        protocol: REPLICATION_PROTOCOL_VERSION,
        identity: expectedIdentity,
        snapshot,
        index,
        datoms: entries.map((entry) => entry.datom),
      });
      index++;
    }
    if (restart) continue;

    const finalVersion = await authorize();
    if (!sameVersion(expectedPath, expectedIdentity, finalVersion)) {
      throw new Error("replication authorization partition changed");
    }
    const finalState = await currentState(input, finalVersion, logical, signal);
    if (!leaseAlive(finalVersion) || finalState.revision !== candidate.revision) {
      continue;
    }
    await remember(input, finalState);
    if (!leaseAlive(finalVersion)) continue;
    await atBoundary(input.boundaries, "replication.snapshot.commit", signal);
    if (!leaseAlive(finalVersion)) continue;
    signal.throwIfAborted();
    yield frame({
      type: "SnapshotCommit",
      protocol: REPLICATION_PROTOCOL_VERSION,
      identity: expectedIdentity,
      snapshot,
      revision: candidate.revision,
      chunks: index,
    });
    return finalState;
  }
};

/** Every reset is preceded by a fresh complete-path authorization fence. */
const resetFrames = async function* (
  input: AuthorizedReplicationInput,
  authorize: () => Promise<AuthorizedVersion>,
  expectedPath: GraphPathLeaseIdentity,
  expectedIdentity: ReplicationIdentity,
  signal: AbortSignal,
): AsyncGenerator<ReplicationFrame, ServerReplicaState, undefined> {
  const version = await authorize();
  if (!sameVersion(expectedPath, expectedIdentity, version)) {
    throw new Error("replication authorization partition changed");
  }
  signal.throwIfAborted();
  yield frame({
    type: "Reset",
    protocol: REPLICATION_PROTOCOL_VERSION,
    identity: expectedIdentity,
  });
  return yield* snapshotFrames(
    input,
    authorize,
    expectedPath,
    expectedIdentity,
    signal,
  );
};

const advanceFrames = async function* (
  input: AuthorizedReplicationInput,
  authorize: () => Promise<AuthorizedVersion>,
  authorizeAt: (version: AuthorizedVersion, basisT: number) => Promise<Db>,
  expectedPath: GraphPathLeaseIdentity,
  expectedIdentity: ReplicationIdentity,
  previous: { readonly basisT: number; readonly revision: OpaqueReplicationId },
  signal: AbortSignal,
  initialVersion?: AuthorizedVersion,
): AsyncGenerator<ReplicationFrame, ServerReplicaState, undefined> {
  let firstVersion = initialVersion;
  for (;;) {
    const version = firstVersion ?? await authorize();
    firstVersion = undefined;
    if (!sameVersion(expectedPath, expectedIdentity, version)) {
      throw new Error("replication authorization partition changed");
    }
    if (previous.basisT > version.target.context.currentDb.basisT) {
      return yield* resetFrames(
        input,
        authorize,
        expectedPath,
        expectedIdentity,
        signal,
      );
    }
    const logical = identityEncoder(input, version);
    const reconstruct = async <A>(work: () => Promise<A>): Promise<A> => {
      try {
        return await work();
      } catch (cause) {
        signal.throwIfAborted();
        throw new ResumeBasisUnavailable({ cause });
      }
    };
    let before: Db;
    try {
      before = await reconstruct(async () => {
        await atBoundary(
          input.boundaries,
          "replication.resume.reconstruct",
          signal,
        );
        return authorizeAt(version, previous.basisT);
      });
    } catch (cause) {
      if (!(cause instanceof ResumeBasisUnavailable)) throw cause;
      return yield* resetFrames(
        input,
        authorize,
        expectedPath,
        expectedIdentity,
        signal,
      );
    }
    let delta: Awaited<ReturnType<typeof diffLogicalDbs>>;
    try {
      delta = await reconstruct(() => diffLogicalDbs(
        before,
        version.target.context.filteredDb,
        logical,
        signal,
      ));
    } catch (cause) {
      if (!(cause instanceof ResumeBasisUnavailable)) throw cause;
      return yield* resetFrames(
        input,
        authorize,
        expectedPath,
        expectedIdentity,
        signal,
      );
    }
    const beforeRevision = await makeRevision(
      input.env.RAMOSE_INTERNAL_SECRET,
      expectedIdentity,
      delta.previousStateDigest,
    );
    if (beforeRevision !== previous.revision) {
      return yield* resetFrames(
        input,
        authorize,
        expectedPath,
        expectedIdentity,
        signal,
      );
    }
    const revision = await makeRevision(
      input.env.RAMOSE_INTERNAL_SECRET,
      expectedIdentity,
      delta.stateDigest,
    );
    if (delta.overflow) {
      return yield* resetFrames(
        input,
        authorize,
        expectedPath,
        expectedIdentity,
        signal,
      );
    }

    const finalVersion = await authorize();
    if (!sameVersion(expectedPath, expectedIdentity, finalVersion)) {
      throw new Error("replication authorization partition changed");
    }
    const finalBasisT = finalVersion.target.context.currentDb.basisT;
    if (
      !leaseAlive(finalVersion) ||
      finalBasisT !== version.target.context.currentDb.basisT
    ) continue;
    const finalState = Object.freeze({
      version: finalVersion,
      basisT: finalBasisT,
      revision,
    });
    await remember(input, finalState);
    if (revision === previous.revision) {
      await atBoundary(input.boundaries, "replication.silent", signal);
      return finalState;
    }
    await atBoundary(input.boundaries, "replication.change", signal);
    if (!leaseAlive(finalVersion)) continue;
    signal.throwIfAborted();
    yield frame({
      type: "Change",
      protocol: REPLICATION_PROTOCOL_VERSION,
      identity: expectedIdentity,
      from: previous.revision,
      revision,
      datoms: delta.datoms,
    });
    return finalState;
  }
};

const replicationFrames = async function* (
  input: AuthorizedReplicationInput,
  initialIdentity: ReplicationIdentity,
  context: Context.Context<JwtVerifier>,
  signal: AbortSignal,
): AsyncGenerator<ReplicationFrame, void, undefined> {
  const expectedPath = graphPathLeaseIdentity(
    input.initialTarget,
    input.activation.graphPath,
  );
  let effectiveSignal = signal;
  const run = <A>(effect: Effect.Effect<A, unknown, JwtVerifier>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(context)), {
      signal: effectiveSignal,
    });
  const deployment = input.env.CF_VERSION_METADATA!.id;
  const origin = new URL(input.request.url).origin;
  const authorize = async (): Promise<AuthorizedVersion> => {
    effectiveSignal.throwIfAborted();
    const version = await run(Effect.gen(function* () {
      const verified = yield* authenticateRequest(input.request);
      const caller = callerFromVerified(verified);
      // Match the established live-query lease: authorization work consumes
      // the lease instead of receiving a fresh five seconds after it finishes.
      const leaseStartedAt = Date.now();
      const leaseExpiresAt = Math.min(
        caller.exp * 1_000,
        leaseStartedAt + MAX_READ_LEASE_MS,
      );
      const target = yield* executeAuthorizedGraphPathTarget({
        authenticate: Effect.succeed(caller),
        bindings: input.bindings,
        root: input.root,
        path: input.activation.graphPath,
        currentDb: acquireCurrentDb(input.env, input.request, {
          bypassBasisCache: true,
          authoritativeBasisFence: true,
        }),
        // Initial admission already provisioned every authorized child.
        provision: () => Effect.void,
      }, (authorized) => Effect.succeed(authorized));
      const pathIdentity = graphPathLeaseIdentity(
        target,
        input.activation.graphPath,
      );
      const identity = yield* Effect.tryPromise({
        try: () => makeReplicationIdentity({
          secret: input.env.RAMOSE_INTERNAL_SECRET,
          origin,
          deployment,
          caller,
          path: pathIdentity,
        }),
        catch: (cause) => runtimeError("replication identity derivation failed", cause),
      });
      if (Date.now() >= leaseExpiresAt) {
        return yield* runtimeError("replication authorization lease exhausted");
      }
      return Object.freeze({
        caller,
        target,
        pathIdentity,
        identity,
        leaseExpiresAt,
      });
    }));
    effectiveSignal.throwIfAborted();
    return version;
  };
  const authorizeAt = (
    version: AuthorizedVersion,
    basisT: number,
  ): Promise<Db> => {
    effectiveSignal.throwIfAborted();
    return run(constructAuthorizedResolvedRequestContext({
      authenticate: Effect.succeed(version.caller),
      bindings: input.bindings,
      route: version.target.route,
      currentDb: () => Effect.succeed(
        version.target.context.currentDb.asOf(basisT),
      ),
    }, version.caller).pipe(Effect.map((authorized) => authorized.filteredDb)))
      .then((db) => {
        effectiveSignal.throwIfAborted();
        return db;
      });
  };

  const watch = watchBasisChanges(
    input.env,
    input.initialTarget.route.database,
    input.request,
  );
  const effectiveController = new AbortController();
  const cancelEffective = () => effectiveController.abort(signal.reason);
  if (signal.aborted) cancelEffective();
  else signal.addEventListener("abort", cancelEffective, { once: true });
  effectiveSignal = effectiveController.signal;
  const watchFailed: Promise<typeof WATCH_FAILED> = watch.failed.then(
    (): typeof WATCH_FAILED => {
      // This source-only marker records the actual watch-close callback
      // without parking a Promise in a separate request context.
      input.boundaries?.checkpointReached?.("replication.watch.failed");
      effectiveController.abort(new Error("replication basis watch closed"));
      return WATCH_FAILED;
    },
  );
  const events = Stream.toAsyncIterable(watch.changes)[Symbol.asyncIterator]();
  const aborted = abortPromise(signal);
  try {
    const ready = await Promise.race([events.next(), aborted, watchFailed]);
    if (ready === ABORTED) return;
    if (ready === WATCH_FAILED) {
      throw new Error("replication basis watch closed");
    }
    if (ready.done || (ready.value !== "ready" && ready.value !== "change")) {
      throw new Error("replication basis watch did not become ready");
    }

    const opening = await authorize();
    if (!sameVersion(expectedPath, initialIdentity, opening)) {
      throw new Error("replication authorization partition changed");
    }

    let committed: ServerReplicaState;
    const resume = input.activation.resumeRevision;
    if (resume === undefined) {
      committed = yield* snapshotFrames(
        input,
        authorize,
        expectedPath,
        initialIdentity,
        effectiveSignal,
      );
    } else {
      let basisT: number | undefined;
      try {
        basisT = await abortable(
          resolveReplicationRevision(
            input.env,
            input.initialTarget.route.database,
            resume,
            initialIdentity.authenticator,
          ),
          effectiveSignal,
        );
      } catch {
        effectiveSignal.throwIfAborted();
        basisT = undefined;
      }
      if (basisT === undefined) {
        committed = yield* resetFrames(
          input,
          authorize,
          expectedPath,
          initialIdentity,
          effectiveSignal,
        );
      } else {
        committed = yield* advanceFrames(
          input,
          authorize,
          authorizeAt,
          expectedPath,
          initialIdentity,
          { basisT, revision: resume },
          effectiveSignal,
        );
      }
    }

    effectiveSignal.throwIfAborted();
    // The phase is fixed from the last admitted lease, never from a basis
    // notification or the amount of hidden work in a completed cycle.
    let nextCycleAt = committed.version.leaseExpiresAt;
    let cycle = scheduledCycle(Math.max(0, nextCycleAt - Date.now()));
    try {
      while (!signal.aborted) {
        effectiveSignal.throwIfAborted();
        let next: "cycle" | typeof WATCH_FAILED | typeof ABORTED;
        if (Date.now() >= nextCycleAt) next = "cycle";
        else next = await Promise.race([cycle.promise, watchFailed, aborted]);
        if (next === ABORTED) return;
        effectiveSignal.throwIfAborted();
        if (next === WATCH_FAILED) {
          throw new Error("replication basis watch closed");
        }

        cycle.cancel();
        do nextCycleAt += REPLICATION_CYCLE_INTERVAL_MS;
        while (nextCycleAt <= Date.now());
        await atBoundary(
          input.boundaries,
          "replication.cycle",
          effectiveSignal,
        );
        const renewed = await authorize();
        if (!sameVersion(expectedPath, initialIdentity, renewed)) {
          throw new Error("replication authorization partition changed");
        }
        if (renewed.target.context.currentDb.basisT === committed.basisT) {
          // An idle fence must still reauthorize every ancestor, but an
          // unchanged target basis needs no logical database scan.
          committed = Object.freeze({ ...committed, version: renewed });
          await atBoundary(
            input.boundaries,
            "replication.silent",
            effectiveSignal,
          );
        } else {
          committed = yield* advanceFrames(
            input,
            authorize,
            authorizeAt,
            expectedPath,
            initialIdentity,
            { basisT: committed.basisT, revision: committed.revision },
            effectiveSignal,
            renewed,
          );
        }
        while (nextCycleAt <= Date.now()) {
          nextCycleAt += REPLICATION_CYCLE_INTERVAL_MS;
        }
        nextCycleAt = Math.min(nextCycleAt, committed.version.leaseExpiresAt);
        cycle = scheduledCycle(Math.max(0, nextCycleAt - Date.now()));
      }
    } finally {
      cycle.cancel();
    }
  } finally {
    signal.removeEventListener("abort", cancelEffective);
    await events.return?.();
  }
};

const readableFrames = (
  frames: AsyncGenerator<ReplicationFrame, void, undefined>,
  controller: AbortController,
  requestSignal: AbortSignal,
): ReadableStream<Uint8Array> => {
  const onAbort = () => {
    controller.abort();
    // A response can be parked at a yielded frame with no further pull. End
    // the generator proactively so request abort still closes the real watch.
    void frames.return?.().catch(() => undefined);
  };
  if (requestSignal.aborted) onAbort();
  else requestSignal.addEventListener("abort", onAbort, { once: true });
  const close = () => requestSignal.removeEventListener("abort", onAbort);
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const next = await frames.next();
        if (next.done) {
          close();
          stream.close();
          return;
        }
        stream.enqueue(encoder.encode(`${encodeReplicationFrame(next.value)}\n`));
      } catch {
        close();
        stream.close();
      }
    },
    async cancel() {
      controller.abort();
      close();
      await frames.return?.();
    },
  }, { highWaterMark: 0 });
};

export const authorizedReplicationResponse = (
  input: AuthorizedReplicationInput,
): Effect.Effect<Response, unknown, JwtVerifier> =>
  Effect.gen(function* () {
    const deployment = input.env.CF_VERSION_METADATA?.id;
    if (
      typeof input.env.RAMOSE_INTERNAL_SECRET !== "string" ||
      input.env.RAMOSE_INTERNAL_SECRET.length < 32 ||
      typeof deployment !== "string" || deployment.length === 0
    ) {
      return yield* new ReplicationRuntimeError({
        reason: "replication identity bindings unavailable",
      });
    }
    const initialPath = graphPathLeaseIdentity(
      input.initialTarget,
      input.activation.graphPath,
    );
    const initialIdentity = yield* Effect.tryPromise({
      try: () => makeReplicationIdentity({
        secret: input.env.RAMOSE_INTERNAL_SECRET,
        origin: new URL(input.request.url).origin,
        deployment,
        caller: input.initialCaller,
        path: initialPath,
      }),
      catch: (cause) => runtimeError("replication identity derivation failed", cause),
    });
    const context = yield* Effect.context<JwtVerifier>();
    const controller = makeStreamAbortController();
    const guarded = async function* (): AsyncGenerator<ReplicationFrame, void, undefined> {
      try {
        yield* replicationFrames(
          input,
          initialIdentity,
          context,
          controller.signal,
        );
      } catch {
        if (!controller.signal.aborted) {
          yield frame({
            type: "TerminalError",
            protocol: REPLICATION_PROTOCOL_VERSION,
            code: "closed",
            identity: initialIdentity,
          });
        }
      }
    };
    return new Response(
      readableFrames(guarded(), controller, input.request.signal),
      {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
          ...input.headers,
        },
      },
    );
  });

export const incompatibleReplicationResponse = (
  headers: Record<string, string>,
): Response => new Response(
  `${encodeReplicationFrame({
    type: "TerminalError",
    protocol: REPLICATION_PROTOCOL_VERSION,
    code: "incompatible-version",
  })}\n`,
  {
    status: 409,
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      ...headers,
    },
  },
);
