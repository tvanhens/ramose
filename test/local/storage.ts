/** Storage tiers exercised through the real local Worker, R2, and Cache API. */

import { describe, expect, test } from "bun:test";
import { testAdmin, uniqueDb, type LocalUrls } from "./fixtures.ts";

const decodeBase64Json = (bodyBase64: string): unknown =>
  JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(bodyBase64), (c) => c.charCodeAt(0))));

export function registerStorage(target: { urls: () => LocalUrls }): void {
  describe("storage tiers on the local peer", () => {
    test("cold R2, same-isolate memory, warm Cache API, and corrupt-cache fallback", async () => {
      const db = uniqueDb("tier");
      const result = await testAdmin(target.urls().openUrl, db, "/storage", {
        action: "tiers",
      });
      expect(result.status).toBe(200);
      const { expectedRows, depth, seed, cold, reuse, warm, fallback } = result.body;

      expect(depth).toBeGreaterThanOrEqual(2);
      expect(cold.rows).toBe(expectedRows);
      expect(cold.stats.r2Gets).toBeGreaterThan(0);
      expect(cold.stats.cacheHits).toBe(0);
      expect(new Set(cold.gets).size).toBe(cold.gets.length);
      const leaves = cold.gets.filter((key: string) => key.includes("/seg/")).length;
      expect(cold.gets.length).toBeLessThanOrEqual(leaves * depth);
      expect(cold.stats.r2Gets).toBe(cold.gets.length);

      expect(reuse.rows).toBe(expectedRows);
      expect(reuse.stats.r2Gets).toBe(0);
      expect(reuse.stats.cacheHits).toBe(0);
      expect(reuse.stats.memHits + reuse.stats.peekHits).toBeGreaterThan(0);

      expect(warm.rows).toBe(expectedRows);
      expect(warm.stats.r2Gets).toBe(0);
      expect(warm.stats.cacheHits).toBeGreaterThan(0);
      expect(warm.gets).toEqual([]);

      expect(fallback.corruptedKeys.length).toBeGreaterThan(0);
      expect(fallback.rows).toBe(expectedRows);
      expect(fallback.stats.r2Gets).toBeGreaterThan(0);
      expect(fallback.gets.length).toBeGreaterThan(0);
      expect(
        [...seed.rawCalls.get, ...seed.rawCalls.put, ...seed.rawCalls.head, ...seed.rawCalls.list].every(
          (key: string) => key.startsWith(`db/${db}/`),
        ),
      ).toBe(true);
    });

    test("content-addressed writes deduplicate through real R2", async () => {
      const db = uniqueDb("dedupe");
      const result = await testAdmin(target.urls().openUrl, db, "/storage", {
        action: "dedupe",
      });
      expect(result.status).toBe(200);
      expect(result.body.sameRoot).toBe(true);
      expect(result.body.skippedPuts).toBeGreaterThan(0);
      expect(result.body.unconditionalPuts).toBeGreaterThan(0);
      expect(new Set(result.body.beforeKeys).size).toBe(result.body.beforeKeys.length);
      expect(result.body.afterKeys).toEqual(result.body.beforeKeys);
      expect(
        [...result.body.rawCalls.put, ...result.body.rawCalls.head].every((key: string) =>
          key.startsWith(`db/${db}/seg/`),
        ),
      ).toBe(true);
    });

    test("root publication and namespaces are real, and corrupt R2 data fails closed", async () => {
      const urls = target.urls();
      const db = uniqueDb("root");
      const otherDb = uniqueDb("other");
      const seeded = await testAdmin(urls.openUrl, db, "/storage", {
        action: "seed",
        rows: 200,
      });
      expect(seeded.status).toBe(200);

      const current = await testAdmin(urls.openUrl, db, "/r2", {
        action: "get",
        key: "root/current",
      });
      const versionedKey = `roots/${String(seeded.body.rec.t).padStart(12, "0")}`;
      const versioned = await testAdmin(urls.openUrl, db, "/r2", {
        action: "get",
        key: versionedKey,
      });
      expect(current.body.found).toBe(true);
      expect(versioned.body.found).toBe(true);
      expect(decodeBase64Json(current.body.bodyBase64)).toEqual(seeded.body.rec);
      expect(decodeBase64Json(versioned.body.bodyBase64)).toEqual(seeded.body.rec);

      const ownObjects = await testAdmin(urls.openUrl, db, "/r2", {
        action: "list",
        prefix: "",
      });
      const otherObjects = await testAdmin(urls.openUrl, otherDb, "/r2", {
        action: "list",
        prefix: "",
      });
      expect(ownObjects.body.objects.length).toBeGreaterThan(0);
      expect(ownObjects.body.objects.every((object: { key: string }) => !object.key.startsWith("db/"))).toBe(true);
      expect(otherObjects.body.objects).toEqual([]);

      const healthy = await testAdmin(urls.openUrl, db, "/storage", {
        action: "cold-read",
      });
      expect(healthy.status).toBe(200);
      expect(healthy.body.rows).toBe(20);
      const corrupted = await testAdmin(urls.openUrl, db, "/r2", {
        action: "put",
        key: seeded.body.probeKey,
        bodyBase64: btoa("not-a-segment"),
      });
      expect(corrupted.status).toBe(200);
      const failed = await testAdmin(urls.openUrl, db, "/storage", {
        action: "cold-read",
      });
      expect(failed.status).toBe(500);
    });
  });
}
