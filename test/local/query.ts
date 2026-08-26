/**
 * Public `db.query` / pull / asOf over the real local peer.
 */

import { describe, expect, test } from "bun:test";
import * as Ramose from "ramose/db";
import { uniqueDb, type LocalUrls } from "./fixtures.ts";
import { Movies, User, createNamed } from "./ops.ts";

const names = Ramose.Query.from(User).select({ name: User.name });

export function registerQuery(target: { urls: () => LocalUrls }): void {
  describe("public db.query over the local peer", () => {
    test("install → run → query → pull → asOf", async () => {
      const ramose = Ramose.connect({ url: target.urls().openUrl });
      try {
        const db = ramose.db(uniqueDb("q"), Movies);
        await db.install();
        const report = await db.run(createNamed, { name: "Ada" });
        expect(await report.dbAfter.query(names)).toEqual([{ name: "Ada" }]);
        const rows = await report.dbAfter.query(
          Ramose.Query.from(User).select({ id: User.id, name: User.name }),
        );
        const pulled = await report.dbAfter.pull(rows[0]!.id, { name: User.name });
        expect(pulled).toEqual({ name: "Ada" });
        expect(await db.asOf(report.t - 1).query(names)).toEqual([]);
      } finally {
        await ramose.close();
      }
    });
  });
}
