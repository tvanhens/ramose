/**
 * Host-Worker service-binding transport (`Ramose.Databases(Server)`).
 */

import { describe, expect, test } from "bun:test";
import { json, uniqueDb, type LocalUrls } from "./fixtures.ts";

export function registerServiceBinding(target: { urls: () => LocalUrls }): void {
  describe("service binding", () => {
    test("a host Worker installs and writes through env.Open.fetch", async () => {
      const { appUrl } = target.urls();
      const name = uniqueDb("bind");
      const created = await json(appUrl, `/t/${name}`, { method: "PUT" });
      expect(created.status).toBe(200);
      expect(created.body.t).toBeGreaterThan(0);
      const written = await json(appUrl, `/t/${name}`, { method: "POST" });
      expect(written.status).toBe(200);
      expect(written.body.names).toEqual(["Ada"]);
    });
  });
}

export function registerCatalogSeed(target: { urls: () => LocalUrls }): void {
  describe("owned-server catalog seeding", () => {
    test("Server databases: installs the catalog so a write on :user/name succeeds", async () => {
      const { seededUrl } = target.urls();
      const { status, body } = await json(seededUrl, "/db/movies/transact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx: [{ ":user/name": "Ada" }] }),
      });
      expect(status).toBe(200);
      expect(body.t).toBeGreaterThan(0);
      const q = await json(seededUrl, "/db/movies/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: { find: ["?n"], where: [["?e", ":user/name", "?n"]] },
        }),
      });
      expect(q.status).toBe(200);
      expect(q.body.result).toEqual([["Ada"]]);
    });
  });
}
