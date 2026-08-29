/** #473 — versioned opaque replication over the real local Ramose stack. */

import { beforeAll, describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import {
  applyReplicationFrame,
  decodeReplicationFrame,
  emptyClientReplicationState,
  readReplicationFrames,
  type ClientReplicationState,
} from "../../packages/ramose/src/internal/replication/index.ts";
import {
  applyObservedFrame,
  collectCommittedSnapshot,
  readReplicationNdjson,
  type ObservedReplicationFrame,
} from "../support/replication.ts";
import {
  CONFORMANCE_DATABASES,
  ConformanceIssue,
  conformanceReadCompatibilityHash,
} from "./conformance-catalog.ts";
import {
  loadConformanceProof,
} from "./conformance-proof.ts";
import {
  create,
  currentBasis,
  invoke,
  originHeaders,
  seedWorld,
  type World,
} from "./conformance.ts";
import { testAdmin, type LocalUrls } from "./fixtures.ts";

const SNAPSHOT_DATABASE = CONFORMANCE_DATABASES[10]!;
const RESUME_DATABASE = CONFORMANCE_DATABASES[11]!;
const INTERRUPT_DATABASE = CONFORMANCE_DATABASES[12]!;
const NONINTERFERENCE_DATABASE = CONFORMANCE_DATABASES[13]!;
const RETENTION_ZERO_DATABASE = CONFORMANCE_DATABASES[14]!;
const RETENTION_PRESSURE_DATABASE = CONFORMANCE_DATABASES[15]!;
const WATCH_FAILURE_DATABASE = CONFORMANCE_DATABASES[16]!;
const RESUME_READY_DATABASE = CONFORMANCE_DATABASES[17]!;
const COMPATIBILITY_DATABASE = CONFORMANCE_DATABASES[18]!;

const withTimeout = async <A>(
  promise: Promise<A>,
  milliseconds: number,
  label: string,
): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const openReplication = (
  base: string,
  database: string,
  token: string,
  resumeRevision?: string,
  protocol = 1,
  signal?: AbortSignal,
  readCompatibilityHash = conformanceReadCompatibilityHash,
): Promise<Response> => fetch(
  `${base.replace(/\/+$/, "")}/db/${encodeURIComponent(database)}/replicate`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...originHeaders,
    },
    body: JSON.stringify({
      type: "Activate",
      protocol,
      graphPath: [],
      scope: { type: "database" },
      readCompatibilityHash,
      ...(resumeRevision === undefined ? {} : { resumeRevision }),
    }),
    ...(signal === undefined ? {} : { signal }),
  },
);

const titlesOf = (state: ClientReplicationState): string[] =>
  (state.committed?.datoms ?? [])
    .filter((datom) =>
      datom.op === "add" &&
      datom.field === ":conformanceIssue/title" &&
      datom.value.type === "string"
    )
    .map((datom) => datom.value.value as string)
    .sort();

const observed = async (
  iterator: AsyncIterator<ObservedReplicationFrame>,
  label: string,
): Promise<ObservedReplicationFrame> => {
  const next = await withTimeout(iterator.next(), 7_000, label);
  if (next.done) throw new Error(`${label} closed before a frame`);
  return next.value;
};

export const closeIterator = async (
  iterator: AsyncIterator<ObservedReplicationFrame>,
): Promise<void> => {
  await iterator.return?.(undefined);
};

const waitForCheckpoint = async (
  base: string,
  database: string,
  name: string,
  scope: "worker" | "replica" | "transactor" = "worker",
): Promise<void> => {
  for (let attempt = 0; attempt < 320; attempt++) {
    const status = await testAdmin(base, database, "/checkpoint", {
      scope,
      action: "status",
    });
    if (status.body.checkpoints?.[name]?.pending === true) return;
    await Bun.sleep(25);
  }
  throw new Error(`replication did not reach ${name}`);
};

const checkpointPending = async (
  base: string,
  database: string,
  name: string,
): Promise<boolean> => {
  const status = await testAdmin(base, database, "/checkpoint", {
    scope: "worker",
    action: "status",
  });
  return status.body.checkpoints?.[name]?.pending === true;
};

const armCheckpoint = async (
  base: string,
  database: string,
  name: string,
  scope: "worker" | "replica" | "transactor" = "worker",
): Promise<void> => {
  const response = await testAdmin(base, database, "/checkpoint", {
    scope,
    action: "arm-wait",
    name,
  });
  expect(response.status).toBe(200);
};

const releaseCheckpoint = async (
  base: string,
  database: string,
  name: string,
  scope: "worker" | "replica" | "transactor" = "worker",
): Promise<void> => {
  const response = await testAdmin(base, database, "/checkpoint", {
    scope,
    action: "release",
    name,
  });
  expect(response.status).toBe(200);
};

const transfer = (
  base: string,
  database: string,
  token: string,
  target: number,
  owner: number,
  org: string,
) => invoke(base, database, token, {
  owner: { kind: "entity", name: ConformanceIssue.ns },
  localName: "transfer",
}, { owner, org }, target);

const rename = (
  base: string,
  database: string,
  token: string,
  target: number,
  title: string,
) => invoke(base, database, token, {
  owner: { kind: "entity", name: ConformanceIssue.ns },
  localName: "rename",
}, { title }, target);

type BurstObservation = {
  readonly checkpoints: readonly string[];
  readonly snapshot: readonly string[];
  readonly visible: string;
};

type RetentionObservation = {
  readonly titles: readonly string[];
  readonly resume: "ready";
};

const observeFirstSeenRetention = async (
  base: string,
  database: string,
  pressure: boolean,
): Promise<RetentionObservation> => {
  const world = await seedWorld(base, database, false);
  if (pressure) {
    // Reproduce the rejected global allocator exactly: 64 authenticated
    // full-view partitions establish one revision each before member A has
    // ever opened replication. No database commit is needed between them.
    for (let index = 0; index < 64; index++) {
      const pressureToken = await signToken(
        world.database,
        "admin",
        `retention-pressure-${index}`,
        { org: `pressure-${index}` },
      );
      const response = await openReplication(
        base,
        world.database,
        pressureToken,
      );
      const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
      try {
        await collectCommittedSnapshot(iterator);
      } finally {
        await closeIterator(iterator);
      }
    }
  }

  // A is genuinely first seen only here, after all B-side pressure.
  const firstResponse = await openReplication(
    base,
    world.database,
    world.member,
  );
  const firstIterator = readReplicationNdjson(firstResponse)[Symbol.asyncIterator]();
  const first = await collectCommittedSnapshot(firstIterator);
  await closeIterator(firstIterator);
  const revision = first.state.committed!.revision;

  await armCheckpoint(base, world.database, "replication.resume.ready");
  const controller = new AbortController();
  const resumedResponse = await openReplication(
    base,
    world.database,
    world.member,
    revision,
    1,
    controller.signal,
  );
  const resumed = readReplicationNdjson(resumedResponse)[Symbol.asyncIterator]();
  const next = resumed.next();
  try {
    await waitForCheckpoint(base, world.database, "replication.resume.ready");
    await releaseCheckpoint(base, world.database, "replication.resume.ready");
    const ready = await withTimeout(next, 7_000, "first-seen resume ready");
    expect(ready.done).toBe(false);
    expect(ready.value?.frame.type).toBe("ResumeReady");
    const following = resumed.next();
    const publicOutcome = await Promise.race([
      following.then(() => "frame" as const),
      Bun.sleep(200).then(() => "pending" as const),
    ]);
    expect(publicOutcome).toBe("pending");
    void following.catch(() => undefined);
    return {
      titles: Object.freeze(titlesOf(first.state)),
      resume: "ready",
    };
  } finally {
    controller.abort();
    await next.catch(() => undefined);
    await releaseCheckpoint(base, world.database, "replication.resume.ready");
    await closeIterator(resumed);
  }
};

type ResumeObservation = {
  readonly checkpoints: readonly string[];
  readonly frames: readonly string[];
};

const observeUnchangedResume = async (
  base: string,
  world: World,
  revision: string,
): Promise<ResumeObservation> => {
  const checkpoints: string[] = [];
  const controller = new AbortController();
  await armCheckpoint(base, world.database, "replication.resume.reconstruct");
  const response = await openReplication(
    base,
    world.database,
    world.member,
    revision,
    1,
    controller.signal,
  );
  const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
  const first = iterator.next();
  try {
    await waitForCheckpoint(
      base,
      world.database,
      "replication.resume.reconstruct",
    );
    checkpoints.push("resume.reconstruct");
    await armCheckpoint(base, world.database, "replication.resume.ready");
    await releaseCheckpoint(
      base,
      world.database,
      "replication.resume.reconstruct",
    );
    await waitForCheckpoint(base, world.database, "replication.resume.ready");
    checkpoints.push("resume.ready");
    await releaseCheckpoint(base, world.database, "replication.resume.ready");

    const ready = await withTimeout(first, 7_000, "unchanged resume ready");
    if (ready.done || ready.value.frame.type !== "ResumeReady") {
      throw new Error(`unchanged resume did not acknowledge: ${JSON.stringify(ready)}`);
    }
    expect(ready.value.frame.revision).toBe(revision);
    const following = iterator.next();
    const afterReady = await Promise.race([
      following.then(() => "frame" as const),
      Bun.sleep(200).then(() => "pending" as const),
    ]);
    expect(afterReady).toBe("pending");
    void following.catch(() => undefined);
    return {
      checkpoints: Object.freeze(checkpoints),
      frames: Object.freeze([ready.value.wire]),
    };
  } finally {
    controller.abort();
    await first.catch(() => undefined);
    for (const name of [
      "replication.resume.reconstruct",
      "replication.resume.ready",
    ]) {
      await testAdmin(base, world.database, "/checkpoint", {
        scope: "worker",
        action: "release",
        name,
      });
    }
    await closeIterator(iterator);
  }
};

const observeBackpressuredBurst = async (
  base: string,
  world: World,
  hiddenCount: number,
): Promise<BurstObservation> => {
  const response = await openReplication(base, world.database, world.member);
  expect(response.status).toBe(200);
  const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
  const checkpoints: string[] = [];
  try {
    const snapshot = await collectCommittedSnapshot(iterator);

    // Every world reaches the same fixed cycle, including the zero-activity
    // world. Park it before the optional hidden burst.
    await armCheckpoint(base, world.database, "replication.cycle");
    const visibleFrame = iterator.next();
    await Bun.sleep(750);
    expect(await checkpointPending(base, world.database, "replication.cycle"))
      .toBe(false);
    await waitForCheckpoint(base, world.database, "replication.cycle");
    checkpoints.push("cycle");

    // The callback queue can retain only the newest notification while the
    // production cycle is parked.
    for (let index = 0; index < hiddenCount; index++) {
      await create(base, world.database, world.admin, ConformanceIssue.ns, {
        key: `parked-hidden-${index}`,
        title: `Parked hidden ${index}`,
        owner: world.ids.bob,
        org: "other",
      });
    }
    if (hiddenCount > 0) await currentBasis(base, world.database);
    await armCheckpoint(base, world.database, "replication.silent");
    await releaseCheckpoint(base, world.database, "replication.cycle");
    await waitForCheckpoint(base, world.database, "replication.silent");
    checkpoints.push("silent");
    await releaseCheckpoint(base, world.database, "replication.silent");

    // Both worlds then wait for exactly the next activity-independent cycle.
    // A hidden wake backlog would create an extra cycle before this point.
    await armCheckpoint(base, world.database, "replication.cycle");
    await waitForCheckpoint(base, world.database, "replication.cycle");
    checkpoints.push("cycle");

    const renamed = await rename(
      base,
      world.database,
      world.member,
      world.ids.parent,
      "Backpressure visible",
    );
    expect(renamed.status).toBe(200);
    await currentBasis(base, world.database);
    await armCheckpoint(base, world.database, "replication.change");
    await releaseCheckpoint(base, world.database, "replication.cycle");
    await waitForCheckpoint(base, world.database, "replication.change");
    checkpoints.push("change");
    await releaseCheckpoint(base, world.database, "replication.change");

    const next = await withTimeout(visibleFrame, 7_000, "visible burst frame");
    if (next.done || next.value.frame.type !== "Change") {
      throw new Error("visible burst did not produce one committed change");
    }
    return {
      checkpoints: Object.freeze(checkpoints),
      snapshot: Object.freeze(snapshot.frames.map((item) => item.wire)),
      visible: next.value.wire,
    };
  } finally {
    for (const name of ["replication.cycle", "replication.silent", "replication.change"]) {
      await testAdmin(base, world.database, "/checkpoint", {
        scope: "worker",
        action: "release",
        name,
      });
    }
    await closeIterator(iterator);
  }
};

export const registerReplication = (ctx: { urls: () => LocalUrls }) => {
  describe("versioned opaque database replication", () => {
    beforeAll(() => loadConformanceProof(ctx.urls().conformanceUrl));

    test("authenticates and resolves the path before fixed schema agreement", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, COMPATIBILITY_DATABASE, false);
      const mismatched = await openReplication(
        base,
        world.database,
        world.member,
        undefined,
        1,
        undefined,
        ReadCompatibilityHash.make("z".repeat(43)),
      );
      expect(mismatched.status).toBe(409);
      expect(await mismatched.text()).toBe(
        `${JSON.stringify({ type: "TerminalError", protocol: 1, code: "update-required" })}\n`,
      );

      const unauthenticated = await openReplication(
        base,
        world.database,
        "not-a-token",
        undefined,
        1,
        undefined,
        ReadCompatibilityHash.make("z".repeat(43)),
      );
      expect(unauthenticated.status).toBe(401);

      const unresolved = await fetch(
        `${base.replace(/\/+$/, "")}/db/${encodeURIComponent(world.database)}/replicate`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${world.member}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "Activate",
            protocol: 1,
            graphPath: ["missing"],
            scope: { type: "database" },
            readCompatibilityHash: "z".repeat(43),
          }),
        },
      );
      expect(unresolved.status).toBe(403);
    });

    test("snapshot bytes are complete, logical, and identical after a hidden-only commit", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, SNAPSHOT_DATABASE, false);
      const response = await openReplication(base, world.database, world.member);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/x-ndjson");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-ramose-basis-t")).toBeNull();
      const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
      const first = await collectCommittedSnapshot(iterator);
      const firstWire = first.frames.map((item) => item.wire);
      try {
        expect(first.frames[0]?.frame.type).toBe("SnapshotStart");
        expect(first.frames.at(-1)?.frame.type).toBe("SnapshotCommit");
        expect(titlesOf(first.state)).toEqual(["Beta", "Gamma", "Omega"]);
        const wire = firstWire.join("\n");
        expect(wire).not.toMatch(
          /Alpha-hidden-secret|audit-secret|basisT|txEid|attributeEid|storage|catalogKey|unitHash/,
        );
        for (const datom of first.state.committed?.datoms ?? []) {
          expect(datom.entity).toMatch(/^[A-Za-z0-9_-]{43}$/);
          expect(datom.field).toMatch(/^:[^/]+\/.+$/);
          if (datom.value.type === "ref") {
            expect(datom.value.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
          }
        }
      } finally {
        await closeIterator(iterator);
      }

      await create(base, world.database, world.admin, ConformanceIssue.ns, {
        key: "snapshot-hidden",
        title: "Alpha-hidden-secret",
        owner: world.ids.bob,
        org: "other",
        audit: "hidden-audit-secret",
      });
      await currentBasis(base, world.database);
      const afterResponse = await openReplication(
        base,
        world.database,
        world.member,
      );
      const afterIterator = readReplicationNdjson(afterResponse)[Symbol.asyncIterator]();
      try {
        const after = await collectCommittedSnapshot(afterIterator);
        expect(after.frames.map((item) => item.wire)).toEqual(firstWire);
      } finally {
        await closeIterator(afterIterator);
      }

      const incompatible = await openReplication(
        base,
        world.database,
        world.member,
        undefined,
        999,
      );
      expect(incompatible.status).toBe(409);
      const terminal = decodeReplicationFrame((await incompatible.text()).trim());
      expect(Result.isSuccess(terminal)).toBe(true);
      if (Result.isSuccess(terminal)) {
        expect(terminal.success).toEqual({
          type: "TerminalError",
          protocol: 1,
          code: "incompatible-version",
        });
      }

      const session = await fetch(
        `${base.replace(/\/+$/, "")}/db/${world.database}/session`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${world.member}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ op: "open", t: 42 }),
        },
      );
      expect(session.status).toBe(401);
      const sessionBody = await session.json() as unknown;
      expect(sessionBody).toEqual({ error: "unauthorized" });
    });

    test("unchanged resume is one-shot and zero/hidden physical worlds are byte/checkpoint-identical", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, RESUME_READY_DATABASE, false);
      const initialResponse = await openReplication(
        base,
        world.database,
        world.member,
      );
      const initialIterator = readReplicationNdjson(
        initialResponse,
      )[Symbol.asyncIterator]();
      const initial = await collectCommittedSnapshot(initialIterator);
      await closeIterator(initialIterator);
      const revision = initial.state.committed!.revision;

      const zero = await observeUnchangedResume(base, world, revision);
      await create(base, world.database, world.admin, ConformanceIssue.ns, {
        key: "resume-ready-hidden",
        title: "Resume ready hidden",
        owner: world.ids.bob,
        org: "other",
      });
      await currentBasis(base, world.database);
      const hidden = await observeUnchangedResume(base, world, revision);

      expect(zero.checkpoints).toEqual(["resume.reconstruct", "resume.ready"]);
      expect(hidden.checkpoints).toEqual(zero.checkpoints);
      expect(hidden.frames).toEqual(zero.frames);
      expect(zero.frames).toHaveLength(1);
      expect(zero.frames[0]).not.toMatch(
        /basisT|txEid|attributeEid|hidden|count|timing|queue/,
      );

      const controller = new AbortController();
      const response = await openReplication(
        base,
        world.database,
        world.member,
        revision,
        1,
        controller.signal,
      );
      const production = readReplicationFrames(
        response,
        controller.signal,
      )[Symbol.asyncIterator]();
      const acknowledgement = await withTimeout(
        production.next(),
        7_000,
        "production resume acknowledgement",
      );
      expect(acknowledgement.value?.type).toBe("ResumeReady");
      const parked = production.next();
      controller.abort();
      await expect(withTimeout(
        parked,
        7_000,
        "production reader cancellation",
      )).rejects.toMatchObject({ name: "AbortError" });
    });

    test("refresh resume converges grants/revocations and claim/principal replacements reset", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, RESUME_DATABASE, true);
      const firstResponse = await openReplication(base, world.database, world.member);
      const firstIterator = readReplicationNdjson(firstResponse)[Symbol.asyncIterator]();
      const initial = await collectCommittedSnapshot(firstIterator);
      await closeIterator(firstIterator);
      expect(titlesOf(initial.state)).toEqual(["Beta", "Gamma", "Omega"]);
      let state = initial.state;
      const initialIdentity = state.identity!;

      const refreshed = await signToken(world.database, "member", "alice-sub", {
        org: "acme",
      });
      const armedReconstruction = await testAdmin(
        base,
        world.database,
        "/checkpoint",
        {
          scope: "worker",
          action: "arm-throw",
          name: "replication.resume.reconstruct",
        },
      );
      expect(armedReconstruction.status).toBe(200);
      const recoveryResponse = await openReplication(
        base,
        world.database,
        refreshed,
        state.committed!.revision,
      );
      const recovery = readReplicationNdjson(recoveryResponse)[Symbol.asyncIterator]();
      try {
        const reset = await observed(recovery, "unreconstructable resume reset");
        expect(reset.frame).toEqual({
          type: "Reset",
          protocol: 1,
          identity: initialIdentity,
        });
        state = applyObservedFrame(state, reset);
        const replacement = await collectCommittedSnapshot(recovery, state);
        state = replacement.state;
        expect(state.committed?.revision).toBe(initial.state.committed?.revision);
        expect(replacement.frames.some((item) => item.frame.type === "ResumeReady"))
          .toBe(false);
      } finally {
        await closeIterator(recovery);
      }

      const granted = await transfer(
        base,
        world.database,
        world.admin,
        world.hiddenId!,
        world.ids.bob,
        "acme",
      );
      expect(granted.status).toBe(200);
      await currentBasis(base, world.database);
      const resumedResponse = await openReplication(
        base,
        world.database,
        refreshed,
        state.committed!.revision,
      );
      const resumed = readReplicationNdjson(resumedResponse)[Symbol.asyncIterator]();
      try {
        const grant = await withTimeout(resumed.next(), 7_000, "grant change");
        expect(grant.done).toBe(false);
        expect(grant.value!.frame.type).toBe("Change");
        if (grant.value!.frame.type === "Change") {
          expect(grant.value!.frame.identity).toEqual(initialIdentity);
          expect(grant.value!.frame.from).toBe(state.committed!.revision);
        }
        state = applyObservedFrame(state, grant.value!);
        expect(titlesOf(state)).toEqual([
          "Alpha-hidden-secret",
          "Beta",
          "Gamma",
          "Omega",
        ]);

        await armCheckpoint(
          base,
          world.database,
          "operation.claimed",
          "transactor",
        );
        const revokedFrame = resumed.next();
        const revokedRequest = transfer(
          base,
          world.database,
          world.admin,
          world.hiddenId!,
          world.ids.bob,
          "other",
        );
        await waitForCheckpoint(
          base,
          world.database,
          "operation.claimed",
          "transactor",
        );
        await releaseCheckpoint(
          base,
          world.database,
          "operation.claimed",
          "transactor",
        );
        const revoked = await withTimeout(
          revokedRequest,
          7_000,
          "revoke operation",
        );
        expect(revoked.status).toBe(200);
        const revoke = await withTimeout(revokedFrame, 7_000, "revoke change");
        expect(revoke.done).toBe(false);
        expect(revoke.value!.frame.type).toBe("Change");
        state = applyObservedFrame(state, revoke.value!);
        expect(titlesOf(state)).toEqual(["Beta", "Gamma", "Omega"]);
      } finally {
        await releaseCheckpoint(
          base,
          world.database,
          "operation.claimed",
          "transactor",
        );
        await closeIterator(resumed);
      }

      const changedClaim = await signToken(
        world.database,
        "member",
        "alice-sub",
        { org: "other" },
      );
      const claimResponse = await openReplication(
        base,
        world.database,
        changedClaim,
        state.committed!.revision,
      );
      const claimIterator = readReplicationNdjson(claimResponse)[Symbol.asyncIterator]();
      try {
        const reset = await observed(claimIterator, "claim reset");
        expect(reset.frame.type).toBe("Reset");
        state = applyObservedFrame(state, reset);
        expect(state.committed).toBeUndefined();
        const replacement = await collectCommittedSnapshot(claimIterator, state);
        state = replacement.state;
        expect(replacement.frames.some((item) => item.frame.type === "ResumeReady"))
          .toBe(false);
        expect(state.identity?.principal).not.toBe(initialIdentity.principal);
        expect(titlesOf(state)).toEqual([
          "Alpha-hidden-secret",
          "Beta",
          "Gamma",
        ]);
      } finally {
        await closeIterator(claimIterator);
      }

      const replacementPrincipal = await signToken(
        world.database,
        "member",
        "bob-sub",
        { org: "other" },
      );
      const principalResponse = await openReplication(
        base,
        world.database,
        replacementPrincipal,
        state.committed!.revision,
      );
      const principalIterator = readReplicationNdjson(principalResponse)[Symbol.asyncIterator]();
      try {
        const reset = await observed(principalIterator, "principal reset");
        expect(reset.frame.type).toBe("Reset");
        const resetState = applyReplicationFrame(state, reset.frame);
        expect(Result.isSuccess(resetState)).toBe(true);
        if (Result.isSuccess(resetState)) {
          expect(resetState.success.committed).toBeUndefined();
          expect(resetState.success.identity?.principal)
            .not.toBe(state.identity?.principal);
        }
      } finally {
        await closeIterator(principalIterator);
      }
    });

    test("a real watch failure aborts parked initial snapshot and resume work opaquely", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, WATCH_FAILURE_DATABASE, false);
      const baselineResponse = await openReplication(
        base,
        world.database,
        world.member,
      );
      const baselineIterator = readReplicationNdjson(
        baselineResponse,
      )[Symbol.asyncIterator]();
      const baseline = await collectCommittedSnapshot(baselineIterator);
      await closeIterator(baselineIterator);

      const expectOpaqueClose = async (
        pending: Promise<IteratorResult<ObservedReplicationFrame>>,
        iterator: AsyncIterator<ObservedReplicationFrame>,
        label: string,
      ): Promise<void> => {
        const terminal = await withTimeout(pending, 7_000, `${label} terminal`);
        expect(terminal.done).toBe(false);
        expect(terminal.value?.frame).toEqual({
          type: "TerminalError",
          protocol: 1,
          code: "closed",
          identity: baseline.state.identity,
        });
        const ended = await withTimeout(iterator.next(), 7_000, `${label} close`);
        expect(ended.done).toBe(true);
      };

      await armCheckpoint(
        base,
        world.database,
        "replication.snapshot.chunk",
      );
      await armCheckpoint(
        base,
        world.database,
        "replication.watch.failed",
      );
      const snapshotResponse = await openReplication(
        base,
        world.database,
        world.member,
      );
      const snapshotIterator = readReplicationNdjson(
        snapshotResponse,
      )[Symbol.asyncIterator]();
      try {
        const start = await observed(snapshotIterator, "watch-failure snapshot start");
        expect(start.frame.type).toBe("SnapshotStart");
        const pending = snapshotIterator.next();
        await waitForCheckpoint(
          base,
          world.database,
          "replication.snapshot.chunk",
        );
        const closedWatch = await testAdmin(
          base,
          world.database,
          "/reconnect",
          {},
        );
        expect(closedWatch.status).toBe(200);
        await waitForCheckpoint(
          base,
          world.database,
          "replication.watch.failed",
        );
        await releaseCheckpoint(
          base,
          world.database,
          "replication.snapshot.chunk",
        );
        await releaseCheckpoint(
          base,
          world.database,
          "replication.watch.failed",
        );
        await expectOpaqueClose(pending, snapshotIterator, "parked snapshot");
      } finally {
        await releaseCheckpoint(
          base,
          world.database,
          "replication.snapshot.chunk",
        );
        await releaseCheckpoint(
          base,
          world.database,
          "replication.watch.failed",
        );
        await closeIterator(snapshotIterator);
      }

      await currentBasis(base, world.database);
      await armCheckpoint(base, world.database, "replication.resume.ready");
      await armCheckpoint(
        base,
        world.database,
        "replication.watch.failed",
      );
      const resumeResponse = await openReplication(
        base,
        world.database,
        world.member,
        baseline.state.committed!.revision,
      );
      const resumeIterator = readReplicationNdjson(
        resumeResponse,
      )[Symbol.asyncIterator]();
      try {
        const pending = resumeIterator.next();
        await waitForCheckpoint(
          base,
          world.database,
          "replication.resume.ready",
        );
        const closedWatch = await testAdmin(
          base,
          world.database,
          "/reconnect",
          {},
        );
        expect(closedWatch.status).toBe(200);
        await waitForCheckpoint(
          base,
          world.database,
          "replication.watch.failed",
        );
        await releaseCheckpoint(
          base,
          world.database,
          "replication.resume.ready",
        );
        await releaseCheckpoint(
          base,
          world.database,
          "replication.watch.failed",
        );
        await expectOpaqueClose(pending, resumeIterator, "parked resume");
      } finally {
        await releaseCheckpoint(
          base,
          world.database,
          "replication.resume.ready",
        );
        await releaseCheckpoint(
          base,
          world.database,
          "replication.watch.failed",
        );
        await closeIterator(resumeIterator);
      }

      await armCheckpoint(base, world.database, "replication.resume.ready");
      const cancelled = new AbortController();
      const cancelledResponse = await openReplication(
        base,
        world.database,
        world.member,
        baseline.state.committed!.revision,
        1,
        cancelled.signal,
      );
      const cancelledIterator = readReplicationNdjson(
        cancelledResponse,
      )[Symbol.asyncIterator]();
      try {
        const pending = cancelledIterator.next();
        const settled = pending.then(
          (value) => ({ type: "value" as const, value }),
          (error: unknown) => ({ type: "error" as const, error }),
        );
        await waitForCheckpoint(
          base,
          world.database,
          "replication.resume.ready",
        );
        cancelled.abort();
        await releaseCheckpoint(
          base,
          world.database,
          "replication.resume.ready",
        );
        const outcome = await withTimeout(
          settled,
          7_000,
          "cancelled resume close",
        );
        if (outcome.type === "value") expect(outcome.value.done).toBe(true);
      } finally {
        cancelled.abort();
        await releaseCheckpoint(
          base,
          world.database,
          "replication.resume.ready",
        );
        try {
          await closeIterator(cancelledIterator);
        } catch (cause) {
          if (!(cause instanceof Error) || cause.name !== "AbortError") throw cause;
        }
      }
    });

    test("an interrupted real snapshot never exposes a partial value", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, INTERRUPT_DATABASE, false);
      for (let index = 0; index < 8; index++) {
        await create(base, world.database, world.admin, ConformanceIssue.ns, {
          key: `interrupt-visible-${index}`,
          title: `Interrupt visible ${index}`,
          owner: world.ids.alice,
          org: "acme",
        });
      }
      const response = await openReplication(base, world.database, world.member);
      const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
      let state = emptyClientReplicationState();
      try {
        const start = await observed(iterator, "interrupted start");
        const partial = await observed(iterator, "interrupted chunk");
        expect(start.frame.type).toBe("SnapshotStart");
        expect(partial.frame.type).toBe("SnapshotChunk");
        state = applyObservedFrame(state, start);
        state = applyObservedFrame(state, partial);
        expect(state.committed).toBeUndefined();
      } finally {
        await closeIterator(iterator);
      }

      const retry = await openReplication(base, world.database, world.member);
      const retryIterator = readReplicationNdjson(retry)[Symbol.asyncIterator]();
      try {
        const complete = await collectCommittedSnapshot(retryIterator, state);
        expect(complete.state.committed).toBeDefined();
        expect(titlesOf(complete.state)).toHaveLength(11);
      } finally {
        await closeIterator(retryIterator);
      }
    });

    test("a fixed bounded cycle makes zero hidden activity and a hidden burst byte-identical", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, NONINTERFERENCE_DATABASE, false);
      const zero = await observeBackpressuredBurst(base, world, 0);
      const restored = await rename(
        base,
        world.database,
        world.member,
        world.ids.parent,
        "Beta",
      );
      expect(restored.status).toBe(200);
      await currentBasis(base, world.database);

      const hidden = await observeBackpressuredBurst(base, world, 24);
      expect(zero.checkpoints).toEqual(["cycle", "silent", "cycle", "change"]);
      expect(hidden.checkpoints).toEqual(zero.checkpoints);
      expect(hidden.snapshot).toEqual(zero.snapshot);
      expect(hidden.visible).toBe(zero.visible);
      expect(hidden.visible).not.toMatch(/Parked hidden/);
    });

    test("another binding's capacity pressure cannot deny a first-seen resume", async () => {
      const base = ctx.urls().conformanceUrl;
      const zero = await observeFirstSeenRetention(
        base,
        RETENTION_ZERO_DATABASE,
        false,
      );
      const hidden = await observeFirstSeenRetention(
        base,
        RETENTION_PRESSURE_DATABASE,
        true,
      );
      expect(hidden).toEqual(zero);
      expect(hidden).toEqual({
        titles: ["Beta", "Gamma", "Omega"],
        resume: "ready",
      });
    });
  });
};
