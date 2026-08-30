import { describe, expect, test } from "bun:test";
import { attr, testAdmin, uniqueDb, type LocalUrls } from "./fixtures.ts";

type BasisFetch = {
  readonly basis: {
    readonly db: string;
    readonly t: number;
    readonly replica?: string;
  };
  readonly hit: boolean;
  readonly reason: "hit" | "off" | "miss" | "expired" | "min-t";
  readonly calls: number;
  readonly behind: boolean;
};

const basis = async (
  base: string,
  db: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: BasisFetch; res: Response }> =>
  testAdmin(base, db, "/basis", { action: "fetch" }, headers) as Promise<{
    status: number;
    body: BasisFetch;
    res: Response;
  }>;

const bootstrap = async (base: string, db: string): Promise<number> => {
  const response = await testAdmin(base, db, "/transact", {
    tx: [attr(":basis/value", "string")],
  });
  expect(response.status).toBe(200);
  return response.body.t as number;
};

export function registerBasisCache(target: { urls: () => LocalUrls }): void {
  describe("real Worker basis cache", () => {
    test("cache-off fetches every time, cache-on hits, and explicit invalidation refetches", async () => {
      const base = target.urls().openUrl;
      const db = uniqueDb("basis");
      const initialT = await bootstrap(base, db);
      const off = {
        "x-ramose-cache-basis": "0",
        "x-ramose-replica-hint": "wnam",
      };
      for (let n = 0; n < 2; n++) {
        const fetched = await basis(base, db, off);
        expect(fetched.status).toBe(200);
        expect(fetched.body).toMatchObject({
          hit: false,
          reason: "off",
          calls: 1,
          behind: false,
          basis: { db, t: initialT },
        });
      }

      const peer = {
        "x-ramose-cache-basis": "1",
        "x-ramose-cache-mode": "peer",
        "x-ramose-replica-hint": "wnam",
      };
      const miss = await basis(base, db, peer);
      const hit = await basis(base, db, peer);
      expect(miss.body).toMatchObject({ hit: false, reason: "miss", calls: 1 });
      expect(hit.body).toMatchObject({ hit: true, reason: "hit", calls: 0 });
      expect(hit.body.basis.t).toBe(initialT);

      const committed = await testAdmin(base, db, "/transact", {
        tx: [{ ":basis/value": "new" }],
      });
      expect(committed.status).toBe(200);
      expect((await basis(base, db, peer)).body).toMatchObject({
        hit: true,
        basis: { t: initialT },
      });

      const invalidated = await testAdmin(base, db, "/basis", {
        action: "invalidate",
      });
      expect(invalidated.status).toBe(200);
      expect(invalidated.body).toEqual({ ok: true, db, invalidated: true });
      const refreshed = await basis(base, db, {
        ...peer,
        "x-ramose-min-t": String(committed.body.t),
      });
      expect(refreshed.body).toMatchObject({
        hit: false,
        reason: "miss",
        calls: 1,
        behind: false,
        basis: { t: committed.body.t },
      });
    });

    test("min-T fences a cached basis and retries a genuinely lagging Replica", async () => {
      const base = target.urls().openUrl;
      const db = uniqueDb("minbasis");
      const initialT = await bootstrap(base, db);
      const peer = {
        "x-ramose-cache-basis": "1",
        "x-ramose-cache-mode": "peer",
      };
      expect((await basis(base, db, peer)).body.reason).toBe("miss");

      const committed = await testAdmin(base, db, "/transact", {
        tx: [{ ":basis/value": "fenced" }],
      });
      expect(committed.status).toBe(200);
      const fenced = await basis(base, db, {
        ...peer,
        "x-ramose-min-t": String(committed.body.t),
      });
      expect(fenced.body).toMatchObject({
        hit: false,
        reason: "min-t",
        calls: 1,
        behind: false,
        basis: { t: committed.body.t },
      });

      const impossibleT = committed.body.t + 1;
      const lagging = await basis(base, db, {
        "x-ramose-cache-basis": "0",
        "x-ramose-min-t": String(impossibleT),
      });
      expect(lagging.body.hit).toBe(false);
      expect(lagging.body.reason).toBe("off");
      expect(lagging.body.calls).toBe(6);
      expect(lagging.body.behind).toBe(true);
      expect(lagging.body.basis.t).toBe(committed.body.t);
      expect(lagging.body.basis.t).toBeGreaterThan(initialT);
      expect(lagging.res.headers.get("x-ramose-basis-behind")).toBe("1");
    });

    test("hint selection reaches distinct real Replica Durable Objects", async () => {
      const base = target.urls().openUrl;
      const db = uniqueDb("hintbasis");
      await bootstrap(base, db);
      const west = await basis(base, db, {
        "x-ramose-cache-basis": "0",
        "x-ramose-replica-hint": "wnam",
      });
      const east = await basis(base, db, {
        "x-ramose-cache-basis": "0",
        "x-ramose-replica-hint": "enam",
      });
      const westAgain = await basis(base, db, {
        "x-ramose-cache-basis": "0",
        "x-ramose-replica-hint": "wnam",
      });
      expect(west.status).toBe(200);
      expect(east.status).toBe(200);
      expect(west.body.basis.replica).toBeDefined();
      expect(east.body.basis.replica).toBeDefined();
      expect(east.body.basis.replica).not.toBe(west.body.basis.replica);
      expect(westAgain.body.basis.replica).toBe(west.body.basis.replica);
      expect(west.res.headers.get("x-ramose-replica-hint")).toBe("wnam");
      expect(east.res.headers.get("x-ramose-replica-hint")).toBe("enam");
    });
  });
}
