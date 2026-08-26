/**
 * Two real clients, one local QueryReplica — the two-writer live regression.
 *
 * Replaces `overlay-two-writer-live.test.ts`. No injected frames, no
 * polling `q()` as the pass: both standing `db.live` streams must converge.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as Ramose from "ramose/db";
import * as RamoseEffect from "ramose/db/effect";
import { addReefIssue, addReefUser, moveReefIssue } from "../../e2e-ops.ts";
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
const reefBoardQuery = Ramose.Query.from(ReefIssue)
  .select({
    id: ReefIssue.id,
    title: ReefIssue.title,
    status: ReefIssue.status,
    rank: ReefIssue.rank,
    creator: ReefIssue.creator.select({ name: ReefUser.name }),
  })
  .orderBy("rank", "asc");
type ReefBoardRow = Ramose.Row<typeof reefBoardQuery>;

export function registerMultiClient(target: { urls: () => LocalUrls }): void {
  describe("two-writer live", () => {
    test(
      "two clients moving two existing issues both see both moves on live (no refresh)",
      async () => {
        const url = target.urls().openUrl;
        const boardDb = uniqueDb("reef");
        const phoneRt = ManagedRuntime.make(RamoseEffect.layer({ url }));
        const computerRt = ManagedRuntime.make(RamoseEffect.layer({ url }));
        try {
          const phone = phoneRt.runSync(RamoseEffect.Databases).db(boardDb, ReefBoard);
          const computer = computerRt.runSync(RamoseEffect.Databases).db(boardDb, ReefBoard);
          await phoneRt.runPromise(phone.effect.install());
          const person = await phoneRt.runPromise(phone.effect.run(addReefUser, { name: "Ada" }));
          const people = await phoneRt.runPromise(
            person.dbAfter.effect.query(
              Ramose.Query.from(ReefUser).select({ id: ReefUser.id, name: ReefUser.name }),
            ),
          );
          const adaId = people[0]!.id;
          await phoneRt.runPromise(
            phone.effect.run(addReefIssue, {
              title: "One",
              status: "todo",
              rank: 1,
              creatorId: adaId,
            }),
          );
          await phoneRt.runPromise(
            phone.effect.run(addReefIssue, {
              title: "Two",
              status: "todo",
              rank: 2,
              creatorId: adaId,
            }),
          );

          const phoneSeen: Array<readonly ReefBoardRow[]> = [];
          const computerSeen: Array<readonly ReefBoardRow[]> = [];
          const phoneFiber = phoneRt.runFork(
            Stream.runForEach(phone.effect.live(reefBoardQuery), (rows) =>
              Effect.sync(() => phoneSeen.push(rows)),
            ),
          );
          const computerFiber = computerRt.runFork(
            Stream.runForEach(computer.effect.live(reefBoardQuery), (rows) =>
              Effect.sync(() => computerSeen.push(rows)),
            ),
          );

          const statusesOf = (rows: readonly ReefBoardRow[] | undefined) => {
            const out: Record<string, string> = {};
            for (const row of rows ?? []) out[row.title] = row.status;
            return out;
          };
          const bothMoves = (rows: readonly ReefBoardRow[] | undefined) => {
            const s = statusesOf(rows);
            return s.One === "doing" && s.Two === "done";
          };
          const waitSeed = async (seen: Array<readonly ReefBoardRow[]>) => {
            for (let i = 0; i < 80 && (seen.at(-1)?.length ?? 0) < 2; i++) {
              await Bun.sleep(100);
            }
          };
          await waitSeed(phoneSeen);
          await waitSeed(computerSeen);
          expect(statusesOf(phoneSeen.at(-1))).toEqual({ One: "todo", Two: "todo" });
          expect(statusesOf(computerSeen.at(-1))).toEqual({ One: "todo", Two: "todo" });

          const one = phoneSeen.at(-1)!.find((r) => r.title === "One");
          const two = phoneSeen.at(-1)!.find((r) => r.title === "Two");
          await Promise.all([
            phoneRt.runPromise(
              phone.effect.run(moveReefIssue, one!.id, { status: "doing", rank: 10 }),
            ),
            computerRt.runPromise(
              computer.effect.run(moveReefIssue, two!.id, { status: "done", rank: 20 }),
            ),
          ]);

          for (
            let i = 0;
            i < 90 && !(bothMoves(phoneSeen.at(-1)) && bothMoves(computerSeen.at(-1)));
            i++
          ) {
            await Bun.sleep(500);
          }
          await Effect.runPromise(Fiber.interrupt(phoneFiber));
          await Effect.runPromise(Fiber.interrupt(computerFiber));
          expect(statusesOf(phoneSeen.at(-1))).toEqual({ One: "doing", Two: "done" });
          expect(statusesOf(computerSeen.at(-1))).toEqual({ One: "doing", Two: "done" });
        } finally {
          await phoneRt.dispose();
          await computerRt.dispose();
        }
      },
      120_000,
    );
  });
}
