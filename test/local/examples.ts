/**
 * Example clients against the local peer — data plane is fail-closed.
 */

import { describe, expect, test } from "bun:test";
import * as Ramose from "ramose/db";
import { Todos } from "../../examples/todos/schema.ts";
import { uniqueDb, type LocalUrls } from "./fixtures.ts";

export function registerExamples(target: { urls: () => LocalUrls }): void {
  describe("example acceptance", () => {
    test("todos install is unauthorized", async () => {
      const ramose = Ramose.connect({ url: target.urls().openUrl });
      try {
        const db = ramose.db(uniqueDb("todos"), Todos);
        await expect(db.install()).rejects.toMatchObject({ _tag: "Unauthorized" });
      } finally {
        await ramose.close();
      }
    });
  });
}
