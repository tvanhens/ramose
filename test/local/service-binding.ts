/**
 * Host-Worker service-binding transport (`Ramose.Databases(Server)`).
 * Catalog install and `/db/*` stay fail-closed.
 */

import { describe, expect, test } from "bun:test";
import { json, uniqueDb, type LocalUrls } from "./fixtures.ts";

export function registerServiceBinding(target: { urls: () => LocalUrls }): void {
  describe("service binding", () => {
    test("a host Worker cannot install through the Open service binding", async () => {
      const { appUrl } = target.urls();
      const name = uniqueDb("bind");
      const created = await json(appUrl, `/t/${name}`, { method: "PUT" });
      expect(created.status).not.toBe(200);
    });
  });
}

export function registerCatalogSeed(target: { urls: () => LocalUrls }): void {
  describe("owned-server catalog seeding", () => {
    test("Server databases: does not open a data-plane write", async () => {
      const { seededUrl } = target.urls();
      const { status } = await json(seededUrl, "/db/movies/transact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx: [{ ":user/name": "Ada" }] }),
      });
      expect(status).toBe(401);
    });
  });
}
