/**
 * `:db/cas` through the real Transactor / Replica DOs.
 *
 * Public `/db/*` is fail-closed. These cases go through
 * `POST /__test__/db/:name/transact|query` so a write hits
 * `Transactor.handleRequest` → real SQLite/R2, and a read hits Replica
 * `/query`. Storage faults use the existing checkpoint / abort admin.
 */

import { describe, expect, test } from "bun:test";
import { attr, testAdmin, uniqueDb, type LocalUrls } from "./fixtures.ts";

const SCHEMA = [
  attr(":k/id", "long", { ":db/unique": ":db.unique/identity" }),
  attr(":k/v", "string"),
  attr(":k/n", "long"),
];

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

const eidOf = (ack: { tempids: Record<string, number> }): number => {
  const eid = ack.tempids.k ?? Object.values(ack.tempids)[0];
  if (typeof eid !== "number") throw new Error(`no tempid: ${JSON.stringify(ack.tempids)}`);
  return eid;
};

const bootstrap = async (
  url: string,
  db: string,
): Promise<{ eid: number; t: number }> => {
  requireOk("schema", await testAdmin(url, db, "/transact", { tx: SCHEMA }));
  const seed = requireOk(
    "seed",
    await testAdmin(url, db, "/transact", { tx: [{ ":db/id": "k", ":k/id": 1, ":k/v": "old" }] }),
  );
  return { eid: eidOf(seed), t: seed.t };
};

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

const tryTransact = async (
  url: string,
  db: string,
  tx: unknown[],
): Promise<{ status: number; body: any } | { thrown: unknown }> => {
  try {
    return await testAdmin(url, db, "/transact", { tx });
  } catch (err) {
    return { thrown: err };
  }
};

/** Replica entity read with a brief reconnect window after isolate abort. */
const queryEntity = async (
  url: string,
  db: string,
  eid: number,
  minT?: number,
): Promise<{ status: number; body: any }> => {
  const headers = minT === undefined ? undefined : { "x-ramose-min-t": String(minT) };
  return testAdmin(url, db, "/query", { entity: eid }, headers);
};

const queryFindId = async (
  url: string,
  db: string,
  id: number,
  minT?: number,
): Promise<{ status: number; body: any }> => {
  const headers = minT === undefined ? undefined : { "x-ramose-min-t": String(minT) };
  return testAdmin(
    url,
    db,
    "/query",
    { query: `[:find ?e :where [?e :k/id ${id}]]` },
    headers,
  );
};

/**
 * Prefer a replica read. If the replica is still reconnecting, a redundant
 * CAS on the transactor proves the durable value (match ⇒ survived;
 * `tx/cas-conflict` / `tx/lookup-ref` ⇒ it did not).
 */
const assertDurableV = async (
  url: string,
  db: string,
  eid: number,
  expected: string,
  minT?: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const q = await queryEntity(url, db, eid, minT);
      if (q.status === 200 && q.body?.entity?.[":k/v"] === expected) return;
    } catch {
      // replica isolate may still be reconnecting after transactor abort
    }
    await Bun.sleep(50 * (attempt + 1));
  }
  const probe = await testAdmin(url, db, "/transact", {
    tx: [[":db/cas", eid, ":k/v", expected, expected]],
  });
  if (probe.status === 200) return;
  throw new Error(
    `durable :k/v is not ${JSON.stringify(expected)}: ${probe.status} ${JSON.stringify(probe.body)}`,
  );
};

/**
 * Prove a sibling `:k/n` add did not land. Replica 200 with `:k/n` set fails
 * immediately. If the replica never answers, a transactor CAS expected=1 on
 * `:k/n` is the fallback: 200 means the sibling landed; 409 `tx/cas-conflict`
 * means absent. Anything else cannot prove absence.
 */
const assertSiblingNAbsent = async (
  url: string,
  db: string,
  eid: number,
  minT?: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const q = await queryEntity(url, db, eid, minT);
      if (q.status === 200 && q.body?.entity !== undefined) {
        if (q.body.entity[":k/n"] !== undefined) {
          throw new Error(`sibling :k/n landed on replica: ${JSON.stringify(q.body.entity)}`);
        }
        return;
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("sibling :k/n landed")) throw err;
      // replica isolate may still be reconnecting after transactor abort
    }
    await Bun.sleep(50 * (attempt + 1));
  }
  const probe = await testAdmin(url, db, "/transact", {
    tx: [[":db/cas", eid, ":k/n", 1, 1]],
  });
  if (probe.status === 200) {
    throw new Error("sibling :k/n landed: transactor CAS [:k/n 1 → 1] acknowledged");
  }
  if (probe.status === 409 && probe.body?.code === "tx/cas-conflict") return;
  throw new Error(
    `could not prove sibling :k/n is absent: ${probe.status} ${JSON.stringify(probe.body)}`,
  );
};

const assertIdAbsent = async (
  url: string,
  db: string,
  id: number,
  minT?: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const find = await queryFindId(url, db, id, minT);
      if (find.status === 200 && Array.isArray(find.body?.result) && find.body.result.length === 0) {
        return;
      }
    } catch {
      // reconnecting
    }
    await Bun.sleep(50 * (attempt + 1));
  }
  const probe = await testAdmin(url, db, "/transact", {
    tx: [[":db/cas", [":k/id", id], ":k/v", "later", "later"]],
  });
  expect(probe.status).not.toBe(200);
  expect(probe.body?.code === "tx/lookup-ref" || probe.body?.code === "tx/missing-entity").toBe(
    true,
  );
};

export function registerCas(target: { urls: () => LocalUrls }): void {
  describe("CAS on the local transactor stack", () => {
    test("successful CAS survives transactor abort/restart", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cas1");
      const { eid, t } = await bootstrap(url, db);
      const cas = requireOk(
        "cas",
        await testAdmin(url, db, "/transact", {
          tx: [[":db/cas", eid, ":k/v", "old", "new"]],
        }),
      );
      await abortTransactor(url, db);
      await assertDurableV(url, db, eid, "new", cas.t ?? t);
    });

    test("CAS result survives a later storage-fault batch", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cas2");
      const { eid } = await bootstrap(url, db);
      const kept = requireOk(
        "cas kept",
        await testAdmin(url, db, "/transact", {
          tx: [[":db/cas", eid, ":k/v", "old", "kept"]],
        }),
      );
      await armWriteThrow(url, db, "induced-cas-write");
      const later = await tryTransact(url, db, [{ ":k/id": 2, ":k/v": "later" }]);
      expect(isFailedWrite(later)).toBe(true);
      await abortTransactor(url, db);
      await assertDurableV(url, db, eid, "kept", kept.t);
      await assertIdAbsent(url, db, 2, kept.t);
    });

    test("storage-fault batch containing a CAS does not land; restart can retry", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cas3");
      const { eid, t } = await bootstrap(url, db);
      await armWriteThrow(url, db, "induced-cas-write");
      const failed = await tryTransact(url, db, [[":db/cas", eid, ":k/v", "old", "x"]]);
      expect(isFailedWrite(failed)).toBe(true);
      await abortTransactor(url, db);
      await assertDurableV(url, db, eid, "old", t);
      const retry = requireOk(
        "retry cas",
        await testAdmin(url, db, "/transact", {
          tx: [[":db/cas", eid, ":k/v", "old", "x"]],
        }),
      );
      await assertDurableV(url, db, eid, "x", retry.t);
    });

    test("HTTP 409 for a mismatching CAS through the real transactor", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cas4");
      const { eid, t } = await bootstrap(url, db);
      const r = await testAdmin(url, db, "/transact", {
        tx: [[":db/cas", eid, ":k/v", "wrong", "x"]],
      });
      expect(r.status).toBe(409);
      expect(r.body.tag).toBe("TxRejected");
      expect(r.body.code).toBe("tx/cas-conflict");
      await assertDurableV(url, db, eid, "old", t);
    });

    test("concurrent same-expected different replacements: exactly one 200", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cas5");
      const { eid } = await bootstrap(url, db);
      const [a, b] = await Promise.all([
        testAdmin(url, db, "/transact", { tx: [[":db/cas", eid, ":k/v", "old", "a"]] }),
        testAdmin(url, db, "/transact", { tx: [[":db/cas", eid, ":k/v", "old", "b"]] }),
      ]);
      const ok = [a, b].filter((r) => r.status === 200);
      const conflict = [a, b].filter((r) => r.status === 409);
      expect(ok).toHaveLength(1);
      expect(conflict).toHaveLength(1);
      expect(conflict[0]!.body.tag).toBe("TxRejected");
      expect(conflict[0]!.body.code).toBe("tx/cas-conflict");
      const won = ok[0]!.body;
      const winner = a.status === 200 ? "a" : "b";
      expect(winner === "a" || winner === "b").toBe(true);
      await assertDurableV(url, db, eid, winner, won.t);
    });

    test("mismatch aborts a sibling add on the real transactor", async () => {
      const url = target.urls().openUrl;
      const db = uniqueDb("cas6");
      const { eid, t } = await bootstrap(url, db);
      const r = await testAdmin(url, db, "/transact", {
        tx: [
          [":db/cas", eid, ":k/v", "wrong", "x"],
          [":db/add", eid, ":k/n", 1],
        ],
      });
      expect(r.status).toBe(409);
      expect(r.body.tag).toBe("TxRejected");
      expect(r.body.code).toBe("tx/cas-conflict");
      await assertDurableV(url, db, eid, "old", t);
      await assertSiblingNAbsent(url, db, eid, t);
    });
  });
}
