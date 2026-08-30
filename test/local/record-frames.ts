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
    test("records one real activation's snapshot frames", async () => {

      if (process.env[RECORD_FRAMES_ENV] !== "1") return;
      const base = options.urls().conformanceUrl;

      await loadConformanceProof(base);
      await install(base, RECORDING_DATABASE);

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

      await Bun.write(
        join(FIXTURE_DIRECTORY, `${FIXTURE_NAME}.client.json`),
        `${JSON.stringify({ identity, attributes: attributesOf(datoms) }, null, 2)}\n`,
      );
    });
  });
};
