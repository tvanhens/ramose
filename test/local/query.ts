/**
 * Public `db.query` over the local peer is fail-closed until
 * authorized application access lands.
 */

import { describe, expect, test } from "bun:test";
import * as Ramose from "ramose/db";
import { uniqueDb, type LocalUrls } from "./fixtures.ts";
import { Movies } from "./ops.ts";

export function registerQuery(target: { urls: () => LocalUrls }): void {
  describe("public db.query over the local peer", () => {
    test("install and query are unauthorized", async () => {
      const ramose = Ramose.connect({ url: target.urls().openUrl });
      try {
        const db = ramose.db(uniqueDb("q"), Movies);
        await expect(db.install()).rejects.toMatchObject({ _tag: "Unauthorized" });
      } finally {
        await ramose.close();
      }
    });
  });
}
