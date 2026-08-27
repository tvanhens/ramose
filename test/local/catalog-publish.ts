/**
 * Catalog publication through the real Transactor / Replica DOs.
 *
 * Public `/db/*` is fail-closed. Writes go through
 * `POST /__test__/db/:name/publish-catalog` so the transactor reconstructs
 * the privileged tx. Ordinary `/transact` must not write catalog control
 * attrs. Storage faults use the existing checkpoint / abort admin.
 */

import { describe, expect, test } from "bun:test";
import {
  encodeInstalledCatalogUnit,
  type InstalledCatalogUnitV1,
} from "../../packages/ramose/src/internal/authorization/index.ts";
import {
  evolvedCatalogDescriptor,
  sealUnit,
} from "../../packages/ramose/test/internal/authorization/catalog-unit-fixtures.ts";
import {
  RAMOSE_CATALOG,
  RAMOSE_CATALOG_HEAD_IDENT,
  RAMOSE_CATALOG_IDENT,
  RAMOSE_CATALOG_UNIT_HASH_IDENT,
} from "../../packages/ramose/src/internal/core/schema.ts";
import { json, testAdmin, uniqueDb, type LocalUrls } from "./fixtures.ts";

const WRITE_FENCE = "transactor.commit.write";

const requireOk = (
  label: string,
  res: { status: number; body: unknown },
): { t: number; tempids: Record<string, number> } => {
  if (res.status !== 200) {
    throw new Error(`${label} failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body as { t: number; tempids: Record<string, number> };
};

const unitJson = (unit: InstalledCatalogUnitV1) => encodeInstalledCatalogUnit(unit);

const publishCatalog = (
  url: string,
  db: string,
  unit: InstalledCatalogUnitV1,
  expectedHead: number | null = null,
) =>
  testAdmin(url, db, "/publish-catalog", {
    unit: unitJson(unit),
    expectedHead,
  });

const abortTransactor = async (url: string, db: string): Promise<void> => {
  const aborted = await testAdmin(url, db, "/abort", { target: "transactor" });
  expect(aborted.status).toBe(200);
  expect(aborted.body.aborted).toBe(true);
};

const armWriteThrow = async (url: string, db: string, error: string): Promise<void> => {
  const armed = await testAdmin(url, db, "/checkpoint", {
    scope: "transactor",
    action: "arm-throw",
    name: WRITE_FENCE,
    error,
  });
  expect(armed.status).toBe(200);
  expect(armed.body.action).toBe("throw");
};

const isFailedWrite = (res: { status: number; body: any } | { thrown: unknown }): boolean => {
  if ("thrown" in res) return true;
  if (res.status !== 200) return true;
  return false;
};

const tryPublish = async (
  url: string,
  db: string,
  unit: InstalledCatalogUnitV1,
  expectedHead: number | null = null,
): Promise<{ status: number; body: any } | { thrown: unknown }> => {
  try {
    return await publishCatalog(url, db, unit, expectedHead);
  } catch (err) {
    return { thrown: err };
  }
};

const queryEntity = async (
  url: string,
  db: string,
  eid: number,
  minT?: number,
): Promise<{ status: number; body: any }> => {
  const headers = minT === undefined ? undefined : { "x-ramose-min-t": String(minT) };
  return testAdmin(url, db, "/query", { entity: eid }, headers);
};

const queryFindIdent = async (
  url: string,
  db: string,
  ident: string,
  minT?: number,
): Promise<{ status: number; body: any }> => {
  const headers = minT === undefined ? undefined : { "x-ramose-min-t": String(minT) };
  return testAdmin(
    url,
    db,
    "/query",
    { query: `[:find ?e :where [?e :db/ident ${ident}]]` },
    headers,
  );
};

const queryFindHash = async (
  url: string,
  db: string,
  hash: string,
  minT?: number,
): Promise<{ status: number; body: any }> => {
  const headers = minT === undefined ? undefined : { "x-ramose-min-t": String(minT) };
  return testAdmin(
    url,
    db,
    "/query",
    { query: `[:find ?e :where [?e ${RAMOSE_CATALOG_UNIT_HASH_IDENT} "${hash}"]]` },
    headers,
  );
};

const replicaRows = (body: any): unknown[] =>
  Array.isArray(body?.result) ? body.result : [];

const assertIdentPresent = async (
  url: string,
  db: string,
  ident: string,
  minT?: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const find = await queryFindIdent(url, db, ident, minT);
      if (find.status === 200 && replicaRows(find.body).length > 0) return;
    } catch {
      // replica isolate may still be reconnecting
    }
    await Bun.sleep(50 * (attempt + 1));
  }
  throw new Error(`ident ${ident} not visible on replica`);
};

const assertIdentAbsent = async (
  url: string,
  db: string,
  ident: string,
  minT?: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const find = await queryFindIdent(url, db, ident, minT);
      if (find.status === 200 && replicaRows(find.body).length === 0) return;
    } catch {
      // reconnecting
    }
    await Bun.sleep(50 * (attempt + 1));
  }
  throw new Error(`ident ${ident} is present on replica`);
};

const assertHashPresent = async (
  url: string,
  db: string,
  hash: string,
  minT?: number,
): Promise<number> => {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const find = await queryFindHash(url, db, hash, minT);
      if (find.status === 200 && replicaRows(find.body).length === 1) {
        const row = replicaRows(find.body)[0];
        const eid = Array.isArray(row) ? row[0] : row;
        if (typeof eid === "number") return eid;
      }
    } catch {
      // reconnecting
    }
    await Bun.sleep(50 * (attempt + 1));
  }
  throw new Error(`unit hash ${hash} not visible on replica`);
};

const assertHashAbsent = async (
  url: string,
  db: string,
  hash: string,
  minT?: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const find = await queryFindHash(url, db, hash, minT);
      if (find.status === 200 && replicaRows(find.body).length === 0) return;
    } catch {
      // reconnecting
    }
    await Bun.sleep(50 * (attempt + 1));
  }
  throw new Error(`unit hash ${hash} is present on replica`);
};

const resolveHeadAndUnit = async (
  url: string,
  db: string,
  minT?: number,
): Promise<{ head: number; unitHash: string }> => {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const catalog = await queryEntity(url, db, RAMOSE_CATALOG, minT);
      const head = catalog.body?.entity?.[RAMOSE_CATALOG_HEAD_IDENT];
      if (catalog.status === 200 && typeof head === "number") {
        const unit = await queryEntity(url, db, head, minT);
        const unitHash = unit.body?.entity?.[RAMOSE_CATALOG_UNIT_HASH_IDENT];
        if (unit.status === 200 && typeof unitHash === "string") {
          return { head, unitHash };
        }
      }
    } catch {
      // reconnecting
    }
    await Bun.sleep(50 * (attempt + 1));
  }
  throw new Error("could not resolve catalog head + unit on replica");
};

export function registerCatalogPublish(target: { urls: () => LocalUrls }): void {
  describe("catalog publish on the local transactor stack", () => {
    test("first publish is visible on replica as schema + catalog head", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cat1");
      const unit = await sealUnit();
      const ack = requireOk("publish", await publishCatalog(url, db, unit, null));
      await assertIdentPresent(url, db, ":issue/title", ack.t);
      await assertIdentPresent(url, db, ":user/authId", ack.t);
      const resolved = await resolveHeadAndUnit(url, db, ack.t);
      expect(resolved.unitHash).toBe(unit.unitHash);
      await assertHashPresent(url, db, unit.unitHash, ack.t);
    });

    test("concurrent first publishes: exactly one 200, one 409 tx/cas-conflict", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cat2");
      const first = await sealUnit();
      const second = await sealUnit(await evolvedCatalogDescriptor());
      const [a, b] = await Promise.all([
        publishCatalog(url, db, first, null),
        publishCatalog(url, db, second, null),
      ]);
      const ok = [a, b].filter((r) => r.status === 200);
      const conflict = [a, b].filter((r) => r.status === 409);
      expect(ok).toHaveLength(1);
      expect(conflict).toHaveLength(1);
      expect(conflict[0]!.body.tag).toBe("TxRejected");
      expect(conflict[0]!.body.code).toBe("tx/cas-conflict");
      const winner = a.status === 200 ? first : second;
      const loser = a.status === 200 ? second : first;
      const resolved = await resolveHeadAndUnit(url, db, ok[0]!.body.t);
      expect(resolved.unitHash).toBe(winner.unitHash);
      await assertHashPresent(url, db, winner.unitHash, ok[0]!.body.t);
      await assertHashAbsent(url, db, loser.unitHash, ok[0]!.body.t);
      if (winner === first) {
        await assertIdentAbsent(url, db, ":named", ok[0]!.body.t);
      }
    });

    test("wrong expectedHead is 409 and installs no schema", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cat3");
      const unit = await sealUnit();
      const r = await publishCatalog(url, db, unit, 99_999);
      expect(r.status).toBe(409);
      expect(r.body.tag).toBe("TxRejected");
      expect(r.body.code).toBe("tx/cas-conflict");
      await assertIdentAbsent(url, db, ":issue/title");
      await assertHashAbsent(url, db, unit.unitHash);
      const catalog = await queryEntity(url, db, RAMOSE_CATALOG);
      expect(catalog.status).toBe(200);
      expect(catalog.body.entity?.[RAMOSE_CATALOG_HEAD_IDENT]).toBeUndefined();
    });

    test("occupied type + changed trait closure is 409 tx/occupied-type", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cat4");
      const v1 = await sealUnit();
      const first = requireOk("publish v1", await publishCatalog(url, db, v1, null));
      requireOk(
        "occupy :issue",
        await testAdmin(url, db, "/transact", {
          tx: [
            { ":db/id": "u", ":user/authId": "ada" },
            { ":db/id": "i", ":issue/title": "Bug", ":issue/owner": "u" },
          ],
        }),
      );
      const v2 = await sealUnit(await evolvedCatalogDescriptor());
      const occupied = await publishCatalog(url, db, v2);
      expect(occupied.status).toBe(409);
      expect(occupied.body.tag).toBe("TxRejected");
      expect(occupied.body.code).toBe("tx/occupied-type");
      await assertIdentAbsent(url, db, ":named", first.t);
      const resolved = await resolveHeadAndUnit(url, db, first.t);
      expect(resolved.unitHash).toBe(v1.unitHash);
    });

    test("ordinary /transact cannot write :ramose.catalog/head", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cat5");
      const r = await testAdmin(url, db, "/transact", {
        tx: [
          [":db/cas", [":db/ident", RAMOSE_CATALOG_IDENT], RAMOSE_CATALOG_HEAD_IDENT, null, 1000],
        ],
      });
      expect(r.status).toBe(409);
      expect(r.body.tag).toBe("TxRejected");
      expect(r.body.code).toBe("tx/system");
      const catalog = await queryEntity(url, db, RAMOSE_CATALOG);
      expect(catalog.body.entity?.[RAMOSE_CATALOG_HEAD_IDENT]).toBeUndefined();
    });

    test("successful publish survives transactor abort/restart", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cat6");
      const unit = await sealUnit();
      const ack = requireOk("publish", await publishCatalog(url, db, unit, null));
      await abortTransactor(url, db);
      const resolved = await resolveHeadAndUnit(url, db, ack.t);
      expect(resolved.unitHash).toBe(unit.unitHash);
      await assertIdentPresent(url, db, ":issue/title", ack.t);
    });

    test("storage-fault at transactor.commit.write commits nothing", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cat7");
      const unit = await sealUnit();
      await armWriteThrow(url, db, "induced-catalog-write");
      const failed = await tryPublish(url, db, unit, null);
      expect(isFailedWrite(failed)).toBe(true);
      await abortTransactor(url, db);
      await assertIdentAbsent(url, db, ":issue/title");
      await assertHashAbsent(url, db, unit.unitHash);
      const retry = requireOk("retry publish", await publishCatalog(url, db, unit, null));
      const resolved = await resolveHeadAndUnit(url, db, retry.t);
      expect(resolved.unitHash).toBe(unit.unitHash);
    });

    test("public /db/* publish-catalog stays 401", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cat8");
      const unit = await sealUnit();
      const r = await json(url, `/db/${encodeURIComponent(db)}/publish-catalog`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unit: unitJson(unit), expectedHead: null }),
      });
      expect(r.status).toBe(401);
    });
  });
}
