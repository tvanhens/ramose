import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import type {
  LogicalDatom,
  ReplicationIdentity,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import {
  collectCommittedSnapshot,
  nextVisibleFrame,
  readReplicationNdjson,
} from "../support/replication.ts";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { CONFORMANCE_DATABASES } from "./conformance-catalog.ts";
import {
  ConformanceIssue,
  ConformanceUser,
} from "./conformance-catalog.ts";
import { create, install, invoke, seedWorld } from "./conformance.ts";
import { loadConformanceProof } from "./conformance-proof.ts";
import type { LocalUrls } from "./fixtures.ts";
import { closeIterator, openReplication } from "./replication.ts";

const RECORDING_DATABASE = CONFORMANCE_DATABASES[10]!;

const FIXTURE_DIRECTORY = join(import.meta.dir, "..", "browser", "frames");
const FIXTURE_NAME = "optimistic-fence";

export const RECORD_FRAMES_ENV = "RAMOSE_RECORD_FRAMES";

const attributesOf = (
  datoms: readonly LogicalDatom[],
): readonly AttributeSpec[] => {
  const specs = new Map<string, AttributeSpec>();
  for (const datom of datoms) {
    if (specs.has(datom.field)) continue;
    specs.set(datom.field, {
      ident: datom.field,
      valueType: `:db.type/${datom.value.type}` as AttributeSpec["valueType"],
      index: true,
    });
  }
  return [...specs.values()].sort((left, right) =>
    left.ident < right.ident ? -1 : left.ident > right.ident ? 1 : 0
  );
};

export const registerFrameRecorder = (
  options: { readonly urls: () => LocalUrls },
): void => {
  describe("browser frame fixture recording", () => {
    test("records one real activation's snapshot, resume, and change frames", async () => {

      if (process.env[RECORD_FRAMES_ENV] !== "1") return;
      const base = options.urls().conformanceUrl;

      await loadConformanceProof(base);
      await install(base, RECORDING_DATABASE);

      await seedWorld(base, RECORDING_DATABASE, false)
        .catch((cause: unknown) => {
          console.warn(
            `[record:frames] reusing the existing world in ${RECORDING_DATABASE}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
          return undefined;
        });

      const admin = await signToken(RECORDING_DATABASE, "admin", "admin-sub", {
        org: "admin-org",
      });
      const token = await signToken(RECORDING_DATABASE, "member", "alice-sub", {
        org: "acme",
      });

      const run = Date.now().toString(36);
      const changeTitle = `Recorded change ${run}`;
      const owner = await create(base, RECORDING_DATABASE, admin, ConformanceUser.ns, {
        sub: `recorder-${run}`,
      });
      const subject = await create(
        base,
        RECORDING_DATABASE,
        admin,
        ConformanceIssue.ns,
        { key: `recorder-${run}`, title: `Recorded ${run}`, owner, org: "acme" },
      );

      const response = await openReplication(base, RECORDING_DATABASE, token);
      expect(response.status).toBe(200);
      const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
      let wire: readonly string[];
      let aliveWire: string;
      let identity: ReplicationIdentity;
      let revision: string;
      let datoms: readonly LogicalDatom[];
      try {
        const snapshot = await collectCommittedSnapshot(iterator);
        expect(snapshot.frames[0]?.frame.type).toBe("SnapshotStart");
        expect(snapshot.frames.at(-1)?.frame.type).toBe("SnapshotCommit");

        wire = snapshot.frames.map((observed) => observed.wire);
        const first = snapshot.frames[0]!.frame;
        if (!("identity" in first) || first.identity === undefined) {
          throw new Error("the recorded activation carries no identity");
        }
        identity = first.identity;
        revision = snapshot.state.committed!.revision;
        datoms = snapshot.state.committed?.datoms ?? [];
        expect(datoms.length).toBeGreaterThan(0);

        const beat = await iterator.next();
        if (beat.done || beat.value.frame.type !== "KeepAlive") {
          throw new Error(`the steady state was answered ${JSON.stringify(beat)}`);
        }
        expect(beat.value.frame.identity).toEqual(identity);
        aliveWire = beat.value.wire;
      } finally {
        await closeIterator(iterator);
      }

      const resumeResponse = await openReplication(
        base,
        RECORDING_DATABASE,
        token,
        revision,
      );
      expect(resumeResponse.status).toBe(200);
      const resuming = readReplicationNdjson(resumeResponse)[Symbol.asyncIterator]();
      let resumeWire: string;
      try {
        const ready = await resuming.next();
        if (ready.done || ready.value.frame.type !== "ResumeReady") {
          throw new Error(`the resume was answered ${JSON.stringify(ready)}`);
        }
        expect(ready.value.frame.revision).toBe(revision);
        expect(ready.value.frame.identity).toEqual(identity);
        resumeWire = ready.value.wire;
      } finally {
        await closeIterator(resuming);
      }

      const changeResponse = await openReplication(base, RECORDING_DATABASE, token);
      expect(changeResponse.status).toBe(200);
      const changing = readReplicationNdjson(changeResponse)[Symbol.asyncIterator]();
      let changeWire: string;
      let changeRevision: string;
      try {
        const before = await collectCommittedSnapshot(changing);
        expect(before.state.committed!.revision).toBe(revision);
        const pending = nextVisibleFrame(changing);
        const renamed = await invoke(base, RECORDING_DATABASE, token, {
          owner: { kind: "entity", name: ConformanceIssue.ns },
          localName: "rename",
        }, { title: changeTitle }, subject);
        expect(renamed.status).toBe(200);
        const next = await pending;
        if (next.done || next.value.frame.type !== "Change") {
          throw new Error(`the commit was answered ${JSON.stringify(next)}`);
        }
        expect(next.value.frame.from).toBe(revision);
        expect(next.value.frame.identity).toEqual(identity);
        changeWire = next.value.wire;
        changeRevision = next.value.frame.revision;
      } finally {
        await closeIterator(changing);
      }

      await Bun.write(
        join(FIXTURE_DIRECTORY, `${FIXTURE_NAME}.ndjson`),
        `${wire.join("\n")}\n`,
      );
      await Bun.write(
        join(FIXTURE_DIRECTORY, `${FIXTURE_NAME}-alive.ndjson`),
        `${[...wire, aliveWire].join("\n")}\n`,
      );
      await Bun.write(
        join(FIXTURE_DIRECTORY, `${FIXTURE_NAME}-resume.ndjson`),
        `${resumeWire}\n`,
      );
      await Bun.write(
        join(FIXTURE_DIRECTORY, `${FIXTURE_NAME}-change.ndjson`),
        `${changeWire}\n`,
      );

      await Bun.write(
        join(FIXTURE_DIRECTORY, `${FIXTURE_NAME}.client.json`),
        `${
          JSON.stringify({
            identity,
            attributes: attributesOf(datoms),
            revision,
            change: { from: revision, revision: changeRevision, title: changeTitle },
          }, null, 2)
        }\n`,
      );
    });
  });
};
