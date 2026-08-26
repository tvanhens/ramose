/**
 * Representative Todos and Reef acceptance against the local open peer.
 */

import { describe, expect, test } from "bun:test";
import * as Ramose from "ramose/db";
import { addReefIssue, addReefUser } from "../../e2e-ops.ts";
import { Todos } from "../../examples/todos/schema.ts";
import { addTodo, todoQuery } from "../../examples/todos/src/todos.ts";
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

export function registerExamples(target: { urls: () => LocalUrls }): void {
  describe("example acceptance", () => {
    test("todos: install → add → live query", async () => {
      const ramose = Ramose.connect({ url: target.urls().openUrl });
      try {
        const db = ramose.db(uniqueDb("todos"), Todos);
        await db.install();
        const live = db.live(todoQuery);
        const seen: Array<readonly { title: string; done: boolean }[]> = [];
        live.subscribe((rows) => {
          seen.push(rows);
        });
        await addTodo(db, "Ship local tests");
        for (let i = 0; i < 40 && (seen.at(-1)?.length ?? 0) < 1; i++) {
          await Bun.sleep(100);
        }
        expect(seen.at(-1)?.map((r) => r.title)).toEqual(["Ship local tests"]);
        expect(seen.at(-1)?.[0]?.done).toBe(false);
        const rows = await db.query(todoQuery);
        expect(rows.map((r) => r.title)).toEqual(["Ship local tests"]);
        live.close();
      } finally {
        await ramose.close();
      }
    });

    test("reef: install → add user + issue → query the board", async () => {
      const ramose = Ramose.connect({ url: target.urls().openUrl });
      try {
        const db = ramose.db(uniqueDb("reefex"), ReefBoard);
        await db.install();
        await db.run(addReefUser, { name: "Ada" });
        const people = await db.query(
          Ramose.Query.from(ReefUser).select({ id: ReefUser.id, name: ReefUser.name }),
        );
        await db.run(addReefIssue, {
          title: "Board it",
          status: "todo",
          rank: 1,
          creatorId: people[0]!.id,
        });
        const board = await db.query(
          Ramose.Query.from(ReefIssue).select({
            title: ReefIssue.title,
            status: ReefIssue.status,
            creator: ReefIssue.creator.select({ name: ReefUser.name }),
          }),
        );
        expect(board).toEqual([{ title: "Board it", status: "todo", creator: { name: "Ada" } }]);
      } finally {
        await ramose.close();
      }
    });
  });
}
