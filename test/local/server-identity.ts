import { beforeAll, describe, expect, test } from "bun:test";
import { MAX_REPLICATION_REVISIONS_PER_SCOPE } from "../../packages/ramose/src/internal/replica/revision-retention.ts";
import { CONFORMANCE_DATABASES } from "./conformance-catalog.ts";
import { loadConformanceProof } from "./conformance-proof.ts";
import { seedWorld } from "./conformance.ts";
import { testAdmin, uniqueDb, type LocalUrls } from "./fixtures.ts";
import { closeIterator, observed, openReplication } from "./replication.ts";
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

const scopeId = (): string =>
  [opaqueId(), opaqueId(), opaqueId(), opaqueId()].join("|");

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

      expect(first.isInternalSecret).toBe(false);

      const again = await probeIdentityRoot(base, uniqueDb("identity-root-2"));
      expect(again).toEqual(first);

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

        const frame = (await observed(resumedIterator, "resumed identity ready"))
          .frame;

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

      const eid = 4_294_967_296;

      const token = await sealEntityId(base, database, scope, eid);
      expect(token).toMatch(/^[A-Za-z0-9_-]{55}$/);

      expect(await sealEntityId(base, database, scope, eid)).toBe(token);

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
      tampered[35] = tampered[35]! ^ 0x40;
      expect(await openEntityId(base, database, scope, base64Url(tampered)))
        .toEqual({ type: "denied" });

      const versioned = envelopeOf(token);
      versioned[0] = 2;
      expect(await openEntityId(base, database, scope, base64Url(versioned)))
        .toEqual({ type: "update-required", reason: "codec-version" });
    });

    test("a revision store quarantines state sealed under a replaced key id", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = uniqueDb("identity-quarantine");
      const scope = scopeId();
      const revision = opaqueId();
      const current = (await probeIdentityRoot(base, database)).keyId;
      const replaced = "z".repeat(22);
      expect(replaced).not.toBe(current);

      const remembered = await testAdmin(base, database, "/replication-revision", {
        action: "remember",
        revision,
        scope,
        basisT: 7,
        keyId: current,
      });
      expect(remembered.status).toBe(200);
      expect(remembered.body).toEqual({ ok: true, stored: true, ordinal: 1 });

      const resolved = await testAdmin(base, database, "/replication-revision", {
        action: "resolve",
        revision,
        scope,
        keyId: current,
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body).toEqual({ found: true, basisT: 7 });

      const quarantinedRead = await testAdmin(
        base,
        database,
        "/replication-revision",
        { action: "resolve", revision, scope, keyId: replaced },
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
          scope,
          basisT: 99,
          keyId: replaced,
        },
      );
      expect(quarantinedWrite.status).toBe(409);

      const stillThere = await testAdmin(base, database, "/replication-revision", {
        action: "resolve",
        revision,
        scope,
        keyId: current,
      });
      expect(stillThere.status).toBe(200);
      expect(stillThere.body).toEqual({ found: true, basisT: 7 });
    });

    test("one dense ordinal per visible change, and a lagging stream mints none", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = uniqueDb("revision-ordinal");
      const scope = scopeId();
      const keyId = (await probeIdentityRoot(base, database)).keyId;
      const committed = opaqueId();
      const advanced = opaqueId();
      const lagging = opaqueId();
      const remember = (revision: string, basisT: number) =>
        testAdmin(base, database, "/replication-revision", {
          action: "remember",
          revision,
          scope,
          basisT,
          keyId,
        });
      const resolve = (revision: string) =>
        testAdmin(base, database, "/replication-revision", {
          action: "resolve",
          revision,
          scope,
          keyId,
        });

      expect((await remember(committed, 4)).body)
        .toEqual({ ok: true, stored: true, ordinal: 1 });

      expect((await remember(committed, 9)).body)
        .toEqual({ ok: true, stored: true, ordinal: 1 });
      expect((await remember(committed, 4)).body)
        .toEqual({ ok: true, stored: true, ordinal: 1 });
      expect((await resolve(committed)).body).toEqual({ found: true, basisT: 9 });

      expect((await remember(lagging, 8)).body)
        .toEqual({ ok: true, stored: false, refused: "stale-basis" });
      expect((await resolve(lagging)).body).toEqual({ found: false });

      expect((await remember(advanced, 9)).body)
        .toEqual({ ok: true, stored: true, ordinal: 2 });
      expect((await resolve(advanced)).body).toEqual({ found: true, basisT: 9 });
    });

    test("one counter spans every identity rotation inside a partition scope", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = uniqueDb("revision-rotation");
      const scope = scopeId();
      const keyId = (await probeIdentityRoot(base, database)).keyId;
      const remember = (revision: string, basisT: number) =>
        testAdmin(base, database, "/replication-revision", {
          action: "remember",
          revision,
          scope,
          basisT,
          keyId,
        });

      expect((await remember(opaqueId(), 3)).body)
        .toEqual({ ok: true, stored: true, ordinal: 1 });
      expect((await remember(opaqueId(), 4)).body)
        .toEqual({ ok: true, stored: true, ordinal: 2 });
      expect((await remember(opaqueId(), 5)).body)
        .toEqual({ ok: true, stored: true, ordinal: 3 });
    });

    test("advancing a remembered revision does not refresh its eviction order", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = uniqueDb("revision-retention");
      const scope = scopeId();
      const keyId = (await probeIdentityRoot(base, database)).keyId;
      const revisions = Array.from(
        { length: MAX_REPLICATION_REVISIONS_PER_SCOPE + 1 },
        opaqueId,
      );

      for (let index = 0; index < MAX_REPLICATION_REVISIONS_PER_SCOPE; index++) {
        const remembered = await testAdmin(
          base,
          database,
          "/replication-revision",
          {
            action: "remember",
            revision: revisions[index],
            scope,
            basisT: index + 1,
            keyId,
          },
        );
        expect(remembered.status).toBe(200);
        expect(remembered.body)
          .toEqual({ ok: true, stored: true, ordinal: index + 1 });
      }

      await testAdmin(base, database, "/replication-revision", {
        action: "remember",
        revision: revisions[0],
        scope,
        basisT: 99,
        keyId,
      });
      const advanced = await testAdmin(
        base,
        database,
        "/replication-revision",
        { action: "resolve", revision: revisions[0], scope, keyId },
      );
      expect(advanced.body).toEqual({ found: true, basisT: 99 });

      await testAdmin(base, database, "/replication-revision", {
        action: "remember",
        revision: revisions.at(-1),
        scope,
        basisT: 100,
        keyId,
      });

      const evicted = await testAdmin(
        base,
        database,
        "/replication-revision",
        { action: "resolve", revision: revisions[0], scope, keyId },
      );
      expect(evicted.body).toEqual({ found: false });

      const retained = await testAdmin(
        base,
        database,
        "/replication-revision",
        { action: "resolve", revision: revisions[1], scope, keyId },
      );
      expect(retained.body).toEqual({ found: true, basisT: 2 });
    });
  });
};
