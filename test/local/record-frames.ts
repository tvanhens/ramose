/**
 * Record the browser lane's replication frame fixture from the real stack.
 *
 * The browser lane cannot reach a Ramose peer: it is a Chromium page served by
 * Vite, with no Worker, no Durable Object, and no R2. But
 * `ReplicationSession`'s own settled-frame path — the one #476's observation
 * fence hangs off — only runs when real frames arrive over a real response. So
 * the frames are *recorded here*, against the real local Worker, and replayed
 * there as inert bytes.
 *
 * Nothing about this is a peer. It opens one ordinary authenticated
 * `/db/:name/replicate` activation against the deployed local stack, reads the
 * verbatim wire lines the Worker wrote through the same public decoder the
 * product uses, and writes them to disk. The fixture is therefore a *recording*
 * of real server output, never hand-authored — which is what makes drift
 * detectable: re-running this command against a changed protocol produces a
 * different file, and the browser suite fails on the difference.
 *
 * Inert unless `RAMOSE_RECORD_FRAMES=1`, so the ordinary conformance lane never
 * writes to the working tree. Run it with `bun run record:frames`.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import type {
  LogicalDatom,
  ReplicationIdentity,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import {
  collectCommittedSnapshot,
  readReplicationNdjson,
} from "../support/replication.ts";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { CONFORMANCE_DATABASES } from "./conformance-catalog.ts";
import { install, seedWorld } from "./conformance.ts";
import { loadConformanceProof } from "./conformance-proof.ts";
import type { LocalUrls } from "./fixtures.ts";
import { closeIterator, openReplication } from "./replication.ts";

/** The database this fixture is recorded from. */
const RECORDING_DATABASE = CONFORMANCE_DATABASES[10]!;

/** Where the browser lane reads it back. */
const FIXTURE_DIRECTORY = join(import.meta.dir, "..", "browser", "frames");
const FIXTURE_NAME = "optimistic-fence";

export const RECORD_FRAMES_ENV = "RAMOSE_RECORD_FRAMES";

/**
 * The client schema this recording was taken against, derived from the
 * recorded datoms themselves.
 *
 * Derived rather than hand-written for the same reason the frames are recorded
 * rather than authored: the browser lane must install exactly what the server
 * sent. Every conformance field is cardinality-one, so the value type each
 * datom carries is the whole spec; a field the recording never exercises is
 * absent, which is correct — the snapshot does not contain it either.
 */
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
    test("records one real activation's snapshot frames", async () => {
      // Inert in the ordinary lane: recording writes to the working tree, and
      // no test run may ever do that on its own.
      if (process.env[RECORD_FRAMES_ENV] !== "1") return;
      const base = options.urls().conformanceUrl;
      // The deployment-bound catalog proof every real invocation carries, read
      // from the deployed test registry rather than fabricated.
      await loadConformanceProof(base);
      await install(base, RECORDING_DATABASE);
      // The local stack keeps its storage between runs, so this database may
      // already hold the world a previous recording seeded — and its unique
      // fields would refuse a second seed. Either way what follows is a real
      // authenticated activation over whatever the authoritative database
      // actually contains; the recording never depends on having written it.
      const seeded = await seedWorld(base, RECORDING_DATABASE, false)
        .then((world) => world.member)
        .catch((cause: unknown) => {
          console.warn(
            `[record:frames] reusing the existing world in ${RECORDING_DATABASE}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
          return undefined;
        });
      // An admin reads every row of both entities, so a database this recording
      // did not seed still yields a non-empty snapshot.
      const token = seeded ??
        await signToken(RECORDING_DATABASE, "admin", "admin-sub", {
          org: "admin-org",
        });
      const response = await openReplication(base, RECORDING_DATABASE, token);
      expect(response.status).toBe(200);
      const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
      let wire: readonly string[];
      let identity: ReplicationIdentity;
      let datoms: readonly LogicalDatom[];
      try {
        const snapshot = await collectCommittedSnapshot(iterator);
        expect(snapshot.frames[0]?.frame.type).toBe("SnapshotStart");
        expect(snapshot.frames.at(-1)?.frame.type).toBe("SnapshotCommit");
        // The verbatim lines the Worker wrote, in the order it wrote them.
        wire = snapshot.frames.map((observed) => observed.wire);
        const first = snapshot.frames[0]!.frame;
        if (!("identity" in first) || first.identity === undefined) {
          throw new Error("the recorded activation carries no identity");
        }
        identity = first.identity;
        datoms = snapshot.state.committed?.datoms ?? [];
        expect(datoms.length).toBeGreaterThan(0);
      } finally {
        await closeIterator(iterator);
      }
      await Bun.write(
        join(FIXTURE_DIRECTORY, `${FIXTURE_NAME}.ndjson`),
        `${wire.join("\n")}\n`,
      );
      // The client half of the recording: the identity the frames carry and the
      // schema they install against. The browser lane reads both from here, so
      // it pins nothing of its own and a re-recording stays self-consistent.
      await Bun.write(
        join(FIXTURE_DIRECTORY, `${FIXTURE_NAME}.client.json`),
        `${JSON.stringify({ identity, attributes: attributesOf(datoms) }, null, 2)}\n`,
      );
    });
  });
};
