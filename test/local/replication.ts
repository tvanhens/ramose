import { beforeAll, describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { isEntityId } from "../../packages/ramose/src/db/refs.ts";
import {
  applyReplicationFrame,
  decodeReplicationFrame,
  emptyClientReplicationState,
  readReplicationFrames,
  REPLICATION_KEEPALIVE_INTERVAL_MS,
  type ClientReplicationState,
  type ReplicationFrame,
} from "../../packages/ramose/src/internal/replication/index.ts";
import {
  applyObservedFrame,
  collectCommittedSnapshot,
  readReplicationNdjson,
  type ObservedReplicationFrame,
} from "../support/replication.ts";
import { closeObservedStream, type CancellableStream } from "../support/stream.ts";
import {
  CONFORMANCE_DATABASES,
  ConformanceIssue,
  conformanceInertReadCompatibilityHash,
  conformanceReadCompatibilityHash,
  conformanceRotatedReadCompatibilityHash,
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
import { json, fetchPastProxyBlip, post, testAdmin, type LocalUrls } from "./fixtures.ts";

const SNAPSHOT_DATABASE = CONFORMANCE_DATABASES[10]!;
const RESUME_DATABASE = CONFORMANCE_DATABASES[11]!;
const INTERRUPT_DATABASE = CONFORMANCE_DATABASES[12]!;
const NONINTERFERENCE_DATABASE = CONFORMANCE_DATABASES[13]!;
const RETENTION_ZERO_DATABASE = CONFORMANCE_DATABASES[14]!;
const RETENTION_PRESSURE_DATABASE = CONFORMANCE_DATABASES[15]!;
const WATCH_FAILURE_DATABASE = CONFORMANCE_DATABASES[16]!;
const RESUME_READY_DATABASE = CONFORMANCE_DATABASES[17]!;
const COMPATIBILITY_DATABASE = CONFORMANCE_DATABASES[18]!;
const ENTITY_HANDLE_DATABASE = CONFORMANCE_DATABASES[20]!;
const INERT_CHANGE_DATABASE = CONFORMANCE_DATABASES[21]!;
const HIDDEN_SCALE_DATABASE = CONFORMANCE_DATABASES[22]!;
const COLD_ISOLATE_DATABASE = CONFORMANCE_DATABASES[23]!;
const MULTI_DEVICE_DATABASE = CONFORMANCE_DATABASES[24]!;
const COMMIT_WAKE_DATABASE = CONFORMANCE_DATABASES[25]!;
const HIDDEN_WAKE_DATABASE = CONFORMANCE_DATABASES[26]!;
const WAKE_BURST_DATABASE = CONFORMANCE_DATABASES[27]!;
const SCOPE_ARMED_DATABASE = CONFORMANCE_DATABASES[28]!;
const SCOPE_BYSTANDER_DATABASE = CONFORMANCE_DATABASES[29]!;
const KEEPALIVE_DATABASE = CONFORMANCE_DATABASES[30]!;

const HIDDEN_SCALE_COMMITS = 1_000;

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
  protocol = 3,
  signal?: AbortSignal,
  readCompatibilityHash = conformanceReadCompatibilityHash,
): Promise<Response> => fetchPastProxyBlip(
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
  `replicate ${database}`,
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

export const observed = async (
  iterator: AsyncIterator<ObservedReplicationFrame>,
  label: string,
): Promise<ObservedReplicationFrame> => {
  const next = await withTimeout(iterator.next(), 7_000, label);
  if (next.done) throw new Error(`${label} closed before a frame`);
  return next.value;
};

export const closeIterator = (
  iterator: AsyncIterator<ObservedReplicationFrame> & CancellableStream,
): Promise<void> => closeObservedStream(iterator);

const nextVisible = async (
  iterator: AsyncIterator<ObservedReplicationFrame>,
  keepAlives?: string[],
): Promise<IteratorResult<ObservedReplicationFrame>> => {
  for (;;) {
    const next = await iterator.next();
    if (next.done || next.value.frame.type !== "KeepAlive") return next;
    keepAlives?.push(next.value.wire);
  }
};

type ObservedKeepAlive = {
  readonly wire: string;
  readonly at: number;
};

const observeKeepAlives = async (
  base: string,
  world: World,
  hidden: number,
): Promise<readonly ObservedKeepAlive[]> => {
  const controller = new AbortController();
  const response = await openReplication(
    base,
    world.database,
    world.member,
    undefined,
    3,
    controller.signal,
  );
  expect(response.status).toBe(200);
  const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
  const seen: ObservedKeepAlive[] = [];
  try {
    await collectCommittedSnapshot(iterator);
    let committed = 0;
    const noise = async (): Promise<void> => {
      for (let index = 0; index < hidden; index++) {
        await commitHidden(base, world, committed++);
      }
      if (hidden > 0) await currentBasis(base, world.database);
    };
    for (const beat of [1, 2]) {
      await noise();
      const next = await withTimeout(iterator.next(), 12_000, `keep-alive ${beat}`);
      if (next.done || next.value.frame.type !== "KeepAlive") {
        throw new Error(
          `a silent stream carried ${next.done ? "nothing" : next.value.frame.type}`,
        );
      }
      seen.push({ wire: next.value.wire, at: Date.now() });
    }
    expect(committed).toBe(hidden * 2);
    return Object.freeze(seen);
  } finally {
    controller.abort();
    await closeIterator(iterator);
  }
};

const waitForCheckpoint = async (
  base: string,
  database: string,
  name: string,
  scope: "worker" | "replica" | "transactor" = "worker",
  attempts = 320,
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt++) {
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
  readonly keepAlives: readonly string[];
  readonly snapshot: readonly string[];
  readonly visible: string;
  readonly committedOrdinal: number;
  readonly visibleOrdinal: number;
};

const withoutOrdinal = (wire: string): string =>
  wire.replace(/"ordinal":\d+/, '"ordinal":0');

const ordinalOf = (frame: ReplicationFrame): number => {
  if (frame.type !== "SnapshotCommit" && frame.type !== "Change") {
    throw new Error(`${frame.type} carries no visible-change ordinal`);
  }
  return frame.ordinal;
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

  const firstResponse = await openReplication(
    base,
    world.database,
    world.member,
  );
  const firstIterator = readReplicationNdjson(firstResponse)[Symbol.asyncIterator]();
  const first = await collectCommittedSnapshot(firstIterator);
  await closeIterator(firstIterator);
  const revision = first.state.committed!.revision;
  const ordinal = first.state.committed!.ordinal;

  await armCheckpoint(base, world.database, "replication.resume.ready");
  const controller = new AbortController();
  const resumedResponse = await openReplication(
    base,
    world.database,
    world.member,
    revision,
    3,
    controller.signal,
  );
  const resumed = readReplicationNdjson(resumedResponse)[Symbol.asyncIterator]();
  const next = resumed.next();
  try {
    await waitForCheckpoint(base, world.database, "replication.resume.ready");
    await releaseCheckpoint(base, world.database, "replication.resume.ready");
    const ready = await withTimeout(next, 7_000, "first-seen resume ready");
    expect(ready.done).toBe(false);
    expect(ready.value?.frame).toMatchObject({
      type: "ResumeReady",
      revision,
      ordinal,
    });
    const following = nextVisible(resumed);
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
  committed: { readonly revision: string; readonly ordinal: number },
  attempts = 320,
): Promise<ResumeObservation> => {
  const { revision, ordinal } = committed;
  const checkpoints: string[] = [];
  const controller = new AbortController();
  await armCheckpoint(base, world.database, "replication.resume.reconstruct");
  const response = await openReplication(
    base,
    world.database,
    world.member,
    revision,
    3,
    controller.signal,
  );
  const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
  const first = iterator.next();
  try {
    await waitForCheckpoint(
      base,
      world.database,
      "replication.resume.reconstruct",
      "worker",
      attempts,
    );
    checkpoints.push("resume.reconstruct");
    await armCheckpoint(base, world.database, "replication.resume.ready");
    await releaseCheckpoint(
      base,
      world.database,
      "replication.resume.reconstruct",
    );
    await waitForCheckpoint(
      base,
      world.database,
      "replication.resume.ready",
      "worker",
      attempts,
    );
    checkpoints.push("resume.ready");
    await releaseCheckpoint(base, world.database, "replication.resume.ready");

    const ready = await withTimeout(first, 7_000, "unchanged resume ready");
    if (ready.done || ready.value.frame.type !== "ResumeReady") {
      throw new Error(`unchanged resume did not acknowledge: ${JSON.stringify(ready)}`);
    }
    expect(ready.value.frame.revision).toBe(revision);
    expect(ready.value.frame.ordinal).toBe(ordinal);
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

const commitHidden = async (
  base: string,
  world: World,
  index: number,
): Promise<void> => {
  const response = await invoke(base, world.database, world.admin, {
    owner: { kind: "entity", name: ConformanceIssue.ns },
    localName: "create",
  }, {
    key: `parked-hidden-${index}`,
    title: `Parked hidden ${index}`,
    owner: world.ids.bob,
    org: "other",
  });
  expect(response.status).toBe(200);
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
  const keepAlives: string[] = [];
  try {
    const snapshot = await collectCommittedSnapshot(iterator);

    await armCheckpoint(base, world.database, "replication.wake");
    await armCheckpoint(base, world.database, "replication.cycle");
    const visibleFrame = nextVisible(iterator, keepAlives);
    expect(await Promise.race([
      visibleFrame.then(() => "frame" as const),
      Bun.sleep(750).then(() => "pending" as const),
    ])).toBe("pending");
    await waitForCheckpoint(base, world.database, "replication.cycle");
    checkpoints.push("cycle");

    for (let index = 0; index < hiddenCount; index++) {
      await commitHidden(base, world, index);
    }
    if (hiddenCount > 0) await currentBasis(base, world.database);
    await armCheckpoint(base, world.database, "replication.silent");
    await releaseCheckpoint(base, world.database, "replication.cycle");
    await waitForCheckpoint(base, world.database, "replication.silent");
    checkpoints.push("silent");
    await releaseCheckpoint(base, world.database, "replication.silent");

    const renamed = await rename(
      base,
      world.database,
      world.member,
      world.ids.parent,
      "Backpressure visible",
    );
    expect(renamed.status).toBe(200);
    await currentBasis(base, world.database);
    await waitForCheckpoint(base, world.database, "replication.wake");
    checkpoints.push("wake");
    await armCheckpoint(base, world.database, "replication.change");
    await releaseCheckpoint(base, world.database, "replication.wake");
    await waitForCheckpoint(base, world.database, "replication.change");
    checkpoints.push("change");
    await releaseCheckpoint(base, world.database, "replication.change");

    const next = await withTimeout(visibleFrame, 7_000, "visible burst frame");
    if (next.done || next.value.frame.type !== "Change") {
      throw new Error("visible burst did not produce one committed change");
    }
    const commit = snapshot.frames.at(-1)!;
    return {
      checkpoints: Object.freeze(checkpoints),
      keepAlives: Object.freeze([...keepAlives]),
      snapshot: Object.freeze(
        snapshot.frames.map((item) => withoutOrdinal(item.wire)),
      ),
      visible: withoutOrdinal(next.value.wire),
      committedOrdinal: ordinalOf(commit.frame),
      visibleOrdinal: ordinalOf(next.value.frame),
    };
  } finally {
    for (
      const name of [
        "replication.wake",
        "replication.cycle",
        "replication.silent",
        "replication.change",
      ]
    ) {
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
        3,
        undefined,
        ReadCompatibilityHash.make("z".repeat(43)),
      );
      expect(mismatched.status).toBe(409);
      expect(await mismatched.text()).toBe(
        `${JSON.stringify({ type: "TerminalError", protocol: 3, code: "update-required" })}\n`,
      );

      const unauthenticated = await openReplication(
        base,
        world.database,
        "not-a-token",
        undefined,
        3,
        undefined,
        ReadCompatibilityHash.make("z".repeat(43)),
      );
      expect(unauthenticated.status).toBe(401);

      const unresolved = await json(
        base,
        `/db/${encodeURIComponent(world.database)}/replicate`,
        {
          ...post({
            type: "Activate",
            protocol: 3,
            graphPath: ["missing"],
            scope: { type: "database" },
            readCompatibilityHash: "z".repeat(43),
          }),
          token: world.member,
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
          protocol: 3,
          code: "incompatible-version",
        });
      }

      const session = await json(
        base,
        `/db/${encodeURIComponent(world.database)}/session`,
        post({ op: "open", t: 42 }, world.member),
      );
      expect(session.status).toBe(401);
      expect(session.body).toEqual({ error: "unauthorized" });
    });

    test("every replicated entity arrives with its sealed handle, bound to this principal", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, ENTITY_HANDLE_DATABASE, false);
      const bindings = async (token: string) => {
        const response = await openReplication(base, world.database, token);
        expect(response.status).toBe(200);
        const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
        try {
          const snapshot = await collectCommittedSnapshot(iterator);
          return {
            handles: snapshot.state.committed?.handles ?? new Map<string, string>(),
            entities: new Set(
              (snapshot.state.committed?.datoms ?? []).flatMap((datom) =>
                datom.value.type === "ref"
                  ? [datom.entity, datom.value.value]
                  : [datom.entity]
              ),
            ),
          };
        } finally {
          await closeIterator(iterator);
        }
      };

      const mine = await bindings(world.member);

      expect(mine.entities.size).toBeGreaterThan(0);
      expect(new Set(mine.handles.keys())).toEqual(mine.entities);
      const handles = [...mine.handles.values()];

      for (const handle of handles) expect(isEntityId(handle)).toBe(true);
      expect(new Set(handles).size).toBe(handles.length);

      for (const [entity, handle] of mine.handles) {
        expect(handle).not.toBe(entity);
      }

      expect((await bindings(world.member)).handles).toEqual(mine.handles);

      const theirs = await bindings(world.admin);
      expect([...theirs.handles.values()].length).toBeGreaterThan(0);
      for (const handle of theirs.handles.values()) {
        expect(handles).not.toContain(handle);
      }
    });

    test("one device's minted handle is what another device replicates and targets", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, MULTI_DEVICE_DATABASE, false);
      const eid = String(world.ids.parent);

      const first = await rename(
        base,
        world.database,
        world.member,
        world.ids.parent,
        "Device one",
      );
      expect(first.status).toBe(200);
      const handle = first.body.result.id as string;
      expect(isEntityId(handle)).toBe(true);
      expect(JSON.stringify(first.body)).not.toContain(eid);

      const replicated = async () => {
        const response = await openReplication(base, world.database, world.member);
        expect(response.status).toBe(200);
        const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
        try {
          const snapshot = await collectCommittedSnapshot(iterator);
          return {
            handles: snapshot.state.committed!.handles,
            titles: titlesOf(snapshot.state),
            wire: snapshot.frames.map((observed) => observed.wire).join("\n"),
          };
        } finally {
          await closeIterator(iterator);
        }
      };

      const second = await replicated();
      expect([...second.handles.values()]).toContain(handle);
      expect(second.titles).toContain("Device one");
      expect(second.wire).not.toContain(`"${eid}"`);
      expect(second.wire).not.toContain(`:${eid}`);

      const again = await json(base, `/db/${world.database}/op`, {
        method: "POST",
        token: world.member,
        headers: { "content-type": "application/json", ...originHeaders },
        body: JSON.stringify({
          invocationId: crypto.randomUUID(),
          operation: {
            owner: { kind: "entity", name: ConformanceIssue.ns },
            localName: "rename",
          },
          target: handle,
          input: { title: "Device two" },
        }),
      });
      expect(again.status).toBe(200);
      expect(again.body.result.id).toBe(handle);
      expect(JSON.stringify(again.body)).not.toContain(eid);

      const converged = await replicated();
      expect(converged.titles).toContain("Device two");
      expect(converged.titles).not.toContain("Device one");
      expect([...converged.handles.values()]).toContain(handle);

      const theirs = await openReplication(base, world.database, world.admin);
      const iterator = readReplicationNdjson(theirs)[Symbol.asyncIterator]();
      try {
        const snapshot = await collectCommittedSnapshot(iterator);
        expect([...snapshot.state.committed!.handles.values()])
          .not.toContain(handle);
      } finally {
        await closeIterator(iterator);
      }
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
      const committed = {
        revision,
        ordinal: initial.state.committed!.ordinal,
      };

      const zero = await observeUnchangedResume(base, world, committed);
      await create(base, world.database, world.admin, ConformanceIssue.ns, {
        key: "resume-ready-hidden",
        title: "Resume ready hidden",
        owner: world.ids.bob,
        org: "other",
      });
      await currentBasis(base, world.database);
      const hidden = await observeUnchangedResume(base, world, committed);

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
        3,
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
          protocol: 3,
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
          protocol: 3,
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
        3,
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
      expect(zero.checkpoints).toEqual(["cycle", "silent", "wake", "change"]);
      expect(hidden.checkpoints).toEqual(zero.checkpoints);
      expect(hidden.snapshot).toEqual(zero.snapshot);
      expect(hidden.visible).toBe(zero.visible);
      for (const wire of [...zero.keepAlives, ...hidden.keepAlives]) {
        expect(JSON.parse(wire)).toEqual({
          type: "KeepAlive",
          protocol: 3,
          identity: JSON.parse(zero.visible).identity,
        });
      }
      expect(hidden.visible).not.toMatch(/Parked hidden/);
      expect(zero.visibleOrdinal).toBe(zero.committedOrdinal + 1);
      expect(hidden.visibleOrdinal).toBe(hidden.committedOrdinal + 1);
    });

    test("a silent stream carries keep-alives that hidden traffic cannot move", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, KEEPALIVE_DATABASE, false);
      const quiet = await observeKeepAlives(base, world, 0);
      const hidden = await observeKeepAlives(base, world, 2);

      expect(quiet.map((beat) => beat.wire)).toEqual([quiet[0]!.wire, quiet[0]!.wire]);
      expect(hidden.map((beat) => beat.wire)).toEqual([quiet[0]!.wire, quiet[0]!.wire]);
      expect(JSON.parse(quiet[0]!.wire).type).toBe("KeepAlive");

      const spacing = (beats: readonly { readonly at: number }[]): number =>
        beats[1]!.at - beats[0]!.at;
      for (const observed of [spacing(quiet), spacing(hidden)]) {
        expect(observed).toBeGreaterThan(REPLICATION_KEEPALIVE_INTERVAL_MS - 1_000);
        expect(observed).toBeLessThan(REPLICATION_KEEPALIVE_INTERVAL_MS + 3_000);
      }
      expect(Math.abs(spacing(hidden) - spacing(quiet))).toBeLessThan(2_000);
    });

    test("a documentation-only client build resumes without a reset or snapshot", async () => {
      const base = ctx.urls().conformanceUrl;
      expect(conformanceInertReadCompatibilityHash)
        .toBe(conformanceReadCompatibilityHash);
      expect(conformanceRotatedReadCompatibilityHash)
        .not.toBe(conformanceReadCompatibilityHash);

      const world = await seedWorld(base, INERT_CHANGE_DATABASE, false);
      const initial = await openReplication(base, world.database, world.member);
      expect(initial.status).toBe(200);
      const initialIterator = readReplicationNdjson(initial)[Symbol.asyncIterator]();
      const snapshot = await collectCommittedSnapshot(initialIterator);
      await closeIterator(initialIterator);
      const identity = snapshot.state.identity!;
      const revision = snapshot.state.committed!.revision;
      const resumeOrdinal = snapshot.state.committed!.ordinal;

      const controller = new AbortController();
      const resumedResponse = await openReplication(
        base,
        world.database,
        world.member,
        revision,
        3,
        controller.signal,
        conformanceInertReadCompatibilityHash,
      );
      expect(resumedResponse.status).toBe(200);
      const resumed = readReplicationNdjson(resumedResponse)[Symbol.asyncIterator]();
      const pending = resumed.next();
      try {
        const ready = await withTimeout(pending, 7_000, "inert-change resume");
        expect(ready.done).toBe(false);
        expect(ready.value?.frame).toEqual({
          type: "ResumeReady",
          protocol: 3,
          identity,
          revision,
          ordinal: resumeOrdinal,
        });
        const following = resumed.next();
        const quiet = await Promise.race([
          following.then(() => "frame" as const),
          Bun.sleep(200).then(() => "pending" as const),
        ]);
        expect(quiet).toBe("pending");
        void following.catch(() => undefined);
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
        await closeIterator(resumed);
      }

      const rotated = await openReplication(
        base,
        world.database,
        world.member,
        revision,
        3,
        undefined,
        conformanceRotatedReadCompatibilityHash,
      );
      expect(rotated.status).toBe(409);
      expect(await rotated.text()).toBe(
        `${JSON.stringify({
          type: "TerminalError",
          protocol: 3,
          code: "update-required",
        })}\n`,
      );
    });

    test(
      "a thousand hidden-only commits stay byte- and checkpoint-identical",
      async () => {
        const base = ctx.urls().conformanceUrl;
        const world = await seedWorld(base, HIDDEN_SCALE_DATABASE, false);
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
        const committed = {
          revision,
          ordinal: initial.state.committed!.ordinal,
        };
        const initialWire = initial.frames.map((item) => item.wire);

        const scaleAttempts = 320 + HIDDEN_SCALE_COMMITS * 4;
        const zero = await observeUnchangedResume(
          base,
          world,
          committed,
          scaleAttempts,
        );
        for (let index = 0; index < HIDDEN_SCALE_COMMITS; index++) {
          await commitHidden(base, world, index);
        }
        await currentBasis(base, world.database);
        const hidden = await observeUnchangedResume(
          base,
          world,
          committed,
          scaleAttempts,
        );

        expect(hidden.checkpoints).toEqual(zero.checkpoints);
        expect(hidden.frames).toEqual(zero.frames);
        expect(hidden.frames.join("\n")).not.toMatch(/Parked hidden|count|queue/);

        const after = await openReplication(base, world.database, world.member);
        const afterIterator = readReplicationNdjson(after)[Symbol.asyncIterator]();
        try {
          const complete = await collectCommittedSnapshot(afterIterator);
          expect(complete.frames.map((item) => item.wire)).toEqual(initialWire);
          expect(complete.state.committed?.revision).toBe(revision);
          expect(titlesOf(complete.state)).toEqual(["Beta", "Gamma", "Omega"]);
        } finally {
          await closeIterator(afterIterator);
        }
      },
      600_000,
    );

    test("a cold isolate keeps the identity, revision, and reusable replica", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, COLD_ISOLATE_DATABASE, false);
      const initial = await openReplication(base, world.database, world.member);
      expect(initial.status).toBe(200);
      const initialIterator = readReplicationNdjson(initial)[Symbol.asyncIterator]();
      const snapshot = await collectCommittedSnapshot(initialIterator);
      await closeIterator(initialIterator);
      const identity = snapshot.state.identity!;
      const revision = snapshot.state.committed!.revision;
      const resumeOrdinal = snapshot.state.committed!.ordinal;

      for (const target of ["transactor", "replica"] as const) {
        const aborted = await testAdmin(base, world.database, "/abort", { target });
        expect(aborted.status).toBe(200);
        expect(aborted.body.aborted).toBe(true);
      }

      const controller = new AbortController();
      const resumedResponse = await openReplication(
        base,
        world.database,
        world.member,
        revision,
        3,
        controller.signal,
      );
      expect(resumedResponse.status).toBe(200);
      const resumed = readReplicationNdjson(resumedResponse)[Symbol.asyncIterator]();
      const pending = resumed.next();
      try {
        const ready = await withTimeout(pending, 7_000, "cold isolate resume");
        expect(ready.done).toBe(false);
        expect(ready.value?.frame).toEqual({
          type: "ResumeReady",
          protocol: 3,
          identity,
          revision,
          ordinal: resumeOrdinal,
        });
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
        await closeIterator(resumed);
      }
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

    test("a visible commit wakes the stream without waiting for the lease cycle", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, COMMIT_WAKE_DATABASE, false);
      const response = await openReplication(base, world.database, world.member);
      expect(response.status).toBe(200);
      const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
      try {
        const snapshot = await collectCommittedSnapshot(iterator);
        await armCheckpoint(base, world.database, "replication.wake");
        await armCheckpoint(base, world.database, "replication.cycle");

        const renamed = await rename(
          base,
          world.database,
          world.member,
          world.ids.parent,
          "Woken by commit",
        );
        expect(renamed.status).toBe(200);
        await waitForCheckpoint(base, world.database, "replication.wake");
        expect(await checkpointPending(base, world.database, "replication.cycle"))
          .toBe(false);
        await releaseCheckpoint(base, world.database, "replication.wake");

        const woken = await observed(iterator, "commit wake change");
        expect(woken.frame.type).toBe("Change");
        if (woken.frame.type !== "Change") throw new Error("expected Change");
        expect(woken.frame.ordinal).toBe(snapshot.state.committed!.ordinal + 1);
        expect(woken.wire).toMatch(/Woken by commit/);
      } finally {
        await closeIterator(iterator);
        for (const name of ["replication.wake", "replication.cycle"]) {
          await testAdmin(base, world.database, "/checkpoint", {
            scope: "worker",
            action: "release",
            name,
          });
        }
      }
    });

    test("a hidden-only commit wakes the stream and emits nothing", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, HIDDEN_WAKE_DATABASE, false);
      const response = await openReplication(base, world.database, world.member);
      expect(response.status).toBe(200);
      const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
      try {
        const snapshot = await collectCommittedSnapshot(iterator);
        const quiet = nextVisible(iterator);
        await armCheckpoint(base, world.database, "replication.wake");

        await commitHidden(base, world, 0);
        await waitForCheckpoint(base, world.database, "replication.wake");
        await armCheckpoint(base, world.database, "replication.silent");
        await releaseCheckpoint(base, world.database, "replication.wake");
        await waitForCheckpoint(base, world.database, "replication.silent");
        await releaseCheckpoint(base, world.database, "replication.silent");

        expect(await Promise.race([
          quiet.then(() => "frame" as const),
          Bun.sleep(300).then(() => "pending" as const),
        ])).toBe("pending");

        const renamed = await rename(
          base,
          world.database,
          world.member,
          world.ids.parent,
          "Visible after hidden",
        );
        expect(renamed.status).toBe(200);
        const visible = await withTimeout(quiet, 7_000, "visible after hidden");
        if (visible.done || visible.value.frame.type !== "Change") {
          throw new Error("the visible commit produced no change");
        }
        expect(visible.value.frame.ordinal)
          .toBe(snapshot.state.committed!.ordinal + 1);
        expect(visible.value.wire).not.toMatch(/Parked hidden/);
      } finally {
        await closeIterator(iterator);
        for (const name of ["replication.wake", "replication.silent"]) {
          await testAdmin(base, world.database, "/checkpoint", {
            scope: "worker",
            action: "release",
            name,
          });
        }
      }
    });

    test("commits landing before the wake releases advance the stream once", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, WAKE_BURST_DATABASE, false);
      const response = await openReplication(base, world.database, world.member);
      expect(response.status).toBe(200);
      const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
      try {
        const snapshot = await collectCommittedSnapshot(iterator);
        const first = iterator.next();
        await armCheckpoint(base, world.database, "replication.wake");

        expect((await rename(
          base,
          world.database,
          world.member,
          world.ids.parent,
          "Burst one",
        )).status).toBe(200);
        await waitForCheckpoint(base, world.database, "replication.wake");
        expect((await rename(
          base,
          world.database,
          world.member,
          world.ids.parent,
          "Burst two",
        )).status).toBe(200);
        await releaseCheckpoint(base, world.database, "replication.wake");

        const coalesced = await withTimeout(first, 7_000, "coalesced change");
        if (coalesced.done || coalesced.value.frame.type !== "Change") {
          throw new Error("the burst produced no change");
        }
        expect(coalesced.value.frame.ordinal)
          .toBe(snapshot.state.committed!.ordinal + 1);
        expect(coalesced.value.wire).toMatch(/Burst two/);
        expect(coalesced.value.wire).not.toMatch(/Burst one/);

        const following = iterator.next();
        expect(await Promise.race([
          following.then(() => "frame" as const),
          Bun.sleep(300).then(() => "pending" as const),
        ])).toBe("pending");
        void following.catch(() => undefined);
      } finally {
        await closeIterator(iterator);
        await testAdmin(base, world.database, "/checkpoint", {
          scope: "worker",
          action: "release",
          name: "replication.wake",
        });
      }
    });

    test("checkpoints armed for one database never pause another database's stream", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, SCOPE_BYSTANDER_DATABASE, false);
      const armedNames = [
        "replication.snapshot.chunk",
        "replication.cycle",
        "replication.wake",
        "replication.change",
      ];
      for (const name of armedNames) {
        await armCheckpoint(base, SCOPE_ARMED_DATABASE, name);
      }
      try {
        const response = await openReplication(base, world.database, world.member);
        expect(response.status).toBe(200);
        const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
        try {
          const snapshot = await collectCommittedSnapshot(iterator);
          const renamed = await rename(
            base,
            world.database,
            world.member,
            world.ids.parent,
            "Scoped to my database",
          );
          expect(renamed.status).toBe(200);
          const woken = await observed(iterator, "cross-database scoped change");
          if (woken.frame.type !== "Change") {
            throw new Error("the scoped stream produced no change");
          }
          expect(woken.frame.ordinal).toBe(snapshot.state.committed!.ordinal + 1);
          expect(woken.wire).toMatch(/Scoped to my database/);
          for (const name of armedNames) {
            expect(await checkpointPending(base, SCOPE_ARMED_DATABASE, name))
              .toBe(false);
          }
        } finally {
          await closeIterator(iterator);
        }
      } finally {
        for (const name of armedNames) {
          await releaseCheckpoint(base, SCOPE_ARMED_DATABASE, name);
        }
      }
    });
  });
};
