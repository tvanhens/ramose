/**
 * Two real clients against the local peer — data plane is fail-closed.
 */

import { describe, expect, test } from "bun:test";
import * as Ramose from "ramose/db";
import { uniqueDb, type LocalUrls } from "./fixtures.ts";

const ReefUser = Ramose.Entity("user", {
  name: Ramose.string(),
});
const ReefIssue = Ramose.Entity("issue", {
  title: Ramose.string(),
  status: Ramose.string(),
  rank: Ramose.float(),
  creator: Ramose.Ref(ReefUser),
});
const ReefBoard = Ramose.Schema({ user: ReefUser, issue: ReefIssue });

export function registerMultiClient(target: { urls: () => LocalUrls }): void {
  describe("two-writer live", () => {
    test("install is unauthorized until authorized snapshots land", async () => {
      const ramose = Ramose.connect({ url: target.urls().openUrl });
      try {
        const db = ramose.db(uniqueDb("reef"), ReefBoard);
        await expect(db.install()).rejects.toMatchObject({ _tag: "Unauthorized" });
      } finally {
        await ramose.close();
      }
    });
  });
}
