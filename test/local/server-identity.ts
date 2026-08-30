/**
 * #474 slice 6 — the durable server identity/sealing root over the real local
 * Ramose stack (real Worker, real Replica Durable Object, real R2).
 *
 * The defect this proves fixed: every replication identity and revision used to
 * be an HMAC of `RAMOSE_INTERNAL_SECRET`, which `peer.ts` re-mints on every
 * owned-server deployment — so an ordinary redeploy rotated every identity and
 * orphaned every persisted revision. Identities now come from a once-generated
 * record in Durable Object state, and the rotating secret stays the Worker→DO
 * capability only.
 *
 * It also covers #475 milestone E0: the sealed `EntityId` codec derives from
 * that same live record, inside workerd, using only WebCrypto (HKDF-SHA-256,
 * AES-256-GCM, HMAC-SHA-256).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { CONFORMANCE_DATABASES } from "./conformance-catalog.ts";
import { loadConformanceProof } from "./conformance-proof.ts";
import { seedWorld } from "./conformance.ts";
import { testAdmin, uniqueDb, type LocalUrls } from "./fixtures.ts";
import { closeIterator, openReplication } from "./replication.ts";
import {
  collectCommittedSnapshot,
  readReplicationNdjson,
} from "../support/replication.ts";

const IDENTITY_DATABASE = CONFORMANCE_DATABASES[19]!;

type IdentityProbe = {
  readonly version: number;
  readonly keyId: string;
  readonly createdAt: number;
  readonly objectId: string;
  readonly isInternalSecret: boolean;
};

const probeIdentityRoot = async (
  base: string,
  database: string,
): Promise<IdentityProbe> => {
  const response = await testAdmin(base, database, "/server-identity", {
    action: "probe",
  });
  expect(response.status).toBe(200);
  return response.body as IdentityProbe;
};

/** Discard the isolate's cached root: the next derivation is a cold isolate. */
const coldIsolate = async (base: string, database: string): Promise<void> => {
  const response = await testAdmin(base, database, "/server-identity", {
    action: "forget-isolate-cache",
  });
  expect(response.status).toBe(200);
  expect(response.body.forgotten).toBe(true);
};

type EntityIdScope = {
  readonly server: string;
  readonly principal: string;
  readonly database: string;
};

const sealEntityId = async (
  base: string,
  database: string,
  scope: EntityIdScope,
  eid: number,
): Promise<string> => {
  const response = await testAdmin(base, database, "/server-identity", {
    action: "seal-entity-id",
    scope,
    eid,
  });
  expect(response.status).toBe(200);
  return response.body.token as string;
};

const openEntityId = async (
  base: string,
  database: string,
  scope: EntityIdScope,
  token: string,
): Promise<unknown> => {
  const response = await testAdmin(base, database, "/server-identity", {
    action: "open-entity-id",
    scope,
    token,
  });
  expect(response.status).toBe(200);
  return response.body.resolution;
};

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const envelopeOf = (token: string): Uint8Array =>
  Uint8Array.from(
    atob(`${token.replaceAll("-", "+").replaceAll("_", "/")}=`),
    (character) => character.charCodeAt(0),
  );

const opaqueId = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

export const registerServerIdentity = (ctx: { urls: () => LocalUrls }) => {
  describe("durable server identity and sealing root", () => {
    beforeAll(() => loadConformanceProof(ctx.urls().conformanceUrl));

    test("the root is generated once in real DO state and is not the rotating capability", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = uniqueDb("identity-root");

      const first = await probeIdentityRoot(base, database);
      expect(first.version).toBe(1);
      expect(first.keyId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(Number.isSafeInteger(first.createdAt)).toBe(true);
      // The two secrets are separate values, asserted without either leaving
      // the Worker.
      expect(first.isInternalSecret).toBe(false);

      // Repeated reads never regenerate, and the object is a fixed name, not a
      // function of the database, deployment, or region.
      const again = await probeIdentityRoot(base, uniqueDb("identity-root-2"));
      expect(again).toEqual(first);

      // A cold Worker isolate — what an ordinary redeploy produces — re-reads
      // the same durable record instead of minting a new one.
      await coldIsolate(base, database);
      expect(await probeIdentityRoot(base, database)).toEqual(first);
    });

    test("a cold isolate re-derives identical identities and resolves the persisted revision", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, IDENTITY_DATABASE, false);
      const root = await probeIdentityRoot(base, world.database);

      const response = await openReplication(base, world.database, world.member);
      expect(response.status).toBe(200);
      const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
      const snapshot = await collectCommittedSnapshot(iterator);
      await closeIterator(iterator);
      const start = snapshot.frames[0]!.frame;
      if (start.type !== "SnapshotStart") throw new Error("expected SnapshotStart");
      const identity = start.identity;
      const revision = snapshot.state.committed!.revision;

      // Every isolate-level cache the identity path could hide behind is
      // dropped: this is the redeploy the old derivation broke.
      await coldIsolate(base, world.database);
      expect((await probeIdentityRoot(base, world.database)).keyId)
        .toBe(root.keyId);

      const resumed = await openReplication(
        base,
        world.database,
        world.member,
        revision,
      );
      expect(resumed.status).toBe(200);
      const resumedIterator = readReplicationNdjson(
        resumed,
      )[Symbol.asyncIterator]();
      try {
        const ready = await resumedIterator.next();
        expect(ready.done).toBe(false);
        const frame = ready.value!.frame;
        // A rotated identity would have produced a Reset plus a fresh snapshot
        // under a different authenticator instead.
        expect(frame.type).toBe("ResumeReady");
        if (frame.type !== "ResumeReady") throw new Error("expected ResumeReady");
        expect(frame.revision).toBe(revision);
        expect(frame.identity).toEqual(identity);
      } finally {
        await closeIterator(resumedIterator);
      }
    });

    test("the sealed EntityId codec derives from the live root and survives a cold isolate", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = uniqueDb("entity-id");
      const scope: EntityIdScope = {
        server: opaqueId(),
        principal: opaqueId(),
        database: opaqueId(),
      };
      // Beyond 32 bits: the eight-byte big-endian encoding is exercised in the
      // real runtime, not only in the pure suite.
      const eid = 4_294_967_296;

      const token = await sealEntityId(base, database, scope, eid);
      expect(token).toMatch(/^[A-Za-z0-9_-]{71}$/);
      // Deterministic inside the live Worker: handles are cache- and
      // replay-comparable.
      expect(await sealEntityId(base, database, scope, eid)).toBe(token);

      // A cold Worker isolate — what an ordinary redeploy produces — re-reads
      // the same durable record, reproduces the same handle, and still opens
      // the one minted before the restart.
      await coldIsolate(base, database);
      expect(await sealEntityId(base, database, scope, eid)).toBe(token);
      expect(await openEntityId(base, database, scope, token)).toEqual({
        type: "resolved",
        eid,
        scope,
      });
    });

    test("a wrong scope or tampered handle is sealed, and an unreadable codec version quarantines", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = uniqueDb("entity-id-failures");
      const scope: EntityIdScope = {
        server: opaqueId(),
        principal: opaqueId(),
        database: opaqueId(),
      };
      const token = await sealEntityId(base, database, scope, 12);

      // Another principal or another database gets the ordinary sealed denial,
      // indistinguishable from not-found.
      for (
        const wrong of [
          { ...scope, principal: opaqueId() },
          { ...scope, database: opaqueId() },
          { ...scope, server: opaqueId() },
        ]
      ) {
        expect(await openEntityId(base, database, wrong, token))
          .toEqual({ type: "denied" });
      }

      const tampered = envelopeOf(token);
      tampered[30] = tampered[30]! ^ 0x40;
      expect(await openEntityId(base, database, scope, base64Url(tampered)))
        .toEqual({ type: "denied" });

      // A codec version this build cannot read is a data-free quarantine, so a
      // queued target is reported update-required rather than cleared.
      const versioned = envelopeOf(token);
      versioned[0] = 2;
      expect(await openEntityId(base, database, scope, base64Url(versioned)))
        .toEqual({ type: "update-required", reason: "codec-version" });
    });

    test("a revision store quarantines state sealed under a replaced key id", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = uniqueDb("identity-quarantine");
      const binding = opaqueId();
      const revision = opaqueId();
      const current = (await probeIdentityRoot(base, database)).keyId;
      const replaced = "z".repeat(22);
      expect(replaced).not.toBe(current);

      const remembered = await testAdmin(base, database, "/replication-revision", {
        action: "remember",
        revision,
        binding,
        basisT: 7,
        keyId: current,
      });
      expect(remembered.status).toBe(200);
      expect(remembered.body).toEqual({ ok: true, stored: true });

      const resolved = await testAdmin(base, database, "/replication-revision", {
        action: "resolve",
        revision,
        binding,
        keyId: current,
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body).toEqual({ found: true, basisT: 7 });

      // Explicit key loss/replacement: the persisted state is unreachable and
      // stays that way — no basis, and no silent rebinding to the new key.
      const quarantinedRead = await testAdmin(
        base,
        database,
        "/replication-revision",
        { action: "resolve", revision, binding, keyId: replaced },
      );
      expect(quarantinedRead.status).toBe(409);
      expect(quarantinedRead.body).toEqual({
        error: "server-identity-incompatible",
        persisted: current,
      });

      const quarantinedWrite = await testAdmin(
        base,
        database,
        "/replication-revision",
        {
          action: "remember",
          revision,
          binding,
          basisT: 99,
          keyId: replaced,
        },
      );
      expect(quarantinedWrite.status).toBe(409);

      // The refused write corrupted nothing: the original record is intact
      // under the original key id.
      const stillThere = await testAdmin(base, database, "/replication-revision", {
        action: "resolve",
        revision,
        binding,
        keyId: current,
      });
      expect(stillThere.status).toBe(200);
      expect(stillThere.body).toEqual({ found: true, basisT: 7 });
    });
  });
};
