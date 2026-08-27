/**
 * Client SDK 401 and `/health` against the real local Worker.
 *
 * `/db/*` stays fail-closed. Recorders forward; they do not invent replies.
 * Successful install / transact / query / live / pull are out of scope.
 */

import { describe, expect, test } from "bun:test";
import { pipe } from "effect/Function";
import * as Ramose from "ramose/db";
import { connectRecorded } from "../support/live.ts";
import { uniqueDb, type LocalUrls } from "./fixtures.ts";
import { createNamed, Movies, setName, User } from "./ops.ts";

const names = Ramose.Query.q(() =>
  pipe(Ramose.Query.entities(User), Ramose.Query.select({ name: User.name })),
);

const operations = Ramose.defineOperations(Movies, { createNamed, setName });

const expectUnauthorized401 = (error: unknown): Ramose.Unauthorized => {
  expect(error).toBeInstanceOf(Ramose.Unauthorized);
  const denied = error as Ramose.Unauthorized;
  expect(denied._tag).toBe("Unauthorized");
  expect(denied.name).toBe("Unauthorized");
  expect(denied.status).toBe(401);
  expect((error as { constructor?: { name?: string } }).constructor?.name).not.toBe(
    "FiberFailure",
  );
  return denied;
};

const dbCall401 = (
  rec: { readonly calls: readonly { readonly url: string; readonly status: number }[] },
  db: string,
) => rec.calls.find((call) => call.url.includes(`/db/${db}/`) && call.status === 401);

export function registerClientSdk(target: { urls: () => LocalUrls }): void {
  describe("client SDK against the local peer", () => {
    test("query is Unauthorized, not NetworkError / FiberFailure", async () => {
      const { client, rec, close } = connectRecorded(target.urls().openUrl);
      const db = uniqueDb("q");
      try {
        await client.db(db, Movies).query(names);
        throw new Error("expected failure");
      } catch (error) {
        expectUnauthorized401(error);
        expect((error as Ramose.Unauthorized).message).toBe("unauthorized");
        expect(error).not.toBeInstanceOf(Ramose.NetworkError);
        const denied = dbCall401(rec, db);
        expect(denied).toBeDefined();
        expect(denied?.status).toBe(401);
      } finally {
        await close();
      }
    });

    test("db.live is terminal Unauthorized on first contact", async () => {
      const { client, rec, close } = connectRecorded(target.urls().openUrl);
      const db = uniqueDb("lv");
      const live = client.db(db, Movies).live(names);
      try {
        const error = await new Promise<unknown>((resolve, reject) => {
          live.subscribe(() => reject(new Error("expected live emission")), resolve);
        });
        expectUnauthorized401(error);
        const denied = dbCall401(rec, db);
        expect(denied).toBeDefined();
        expect(denied?.status).toBe(401);
      } finally {
        live.close();
        await close();
      }
    });

    test("db.run against fail-closed /db/* is Unauthorized 401", async () => {
      const { client, rec, close } = connectRecorded(target.urls().openUrl);
      const db = uniqueDb("wr");
      try {
        await client.db(db, Movies).run(createNamed, { name: "Ada" });
        throw new Error("expected failure");
      } catch (error) {
        expectUnauthorized401(error);
        const denied = rec.calls.find(
          (call) => call.url.includes(`/db/${db}/`) && call.status === 401,
        );
        expect(denied).toBeDefined();
        expect(denied?.status).toBe(401);
        expect(denied?.url).toMatch(/\/db\/[^/]+\/(op|transact|info)/);
      } finally {
        await close();
      }
    });

    test("db.basis() against fail-closed /info is Unauthorized 401", async () => {
      const { client, rec, close } = connectRecorded(target.urls().openUrl);
      const db = uniqueDb("bs");
      try {
        await client.db(db, Movies).basis();
        throw new Error("expected failure");
      } catch (error) {
        expectUnauthorized401(error);
        const denied = rec.calls.find(
          (call) =>
            call.method === "GET" &&
            call.url.includes(`/db/${db}/info`) &&
            call.status === 401,
        );
        expect(denied).toBeDefined();
      } finally {
        await close();
      }
    });

    test("checkOperations() against openUrl passes", async () => {
      const { client, rec, close } = connectRecorded(target.urls().openUrl, {
        operations,
      });
      try {
        await client.checkOperations();
        const health = rec.calls.find((call) => call.url.includes("/health"));
        expect(health).toBeDefined();
        expect(health?.method).toBe("GET");
        expect(health?.status).toBe(200);
        expect(health?.url).toMatch(/\/health$/);
      } finally {
        await close();
      }
    });

    test("checkOperations() against emptyUrl fails with OperationsCoverageError", async () => {
      const { client, rec, close } = connectRecorded(target.urls().emptyUrl, {
        operations,
      });
      try {
        await client.checkOperations();
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(Ramose.OperationsCoverageError);
        const coverage = error as Ramose.OperationsCoverageError;
        expect(coverage._tag).toBe("OperationsCoverageError");
        expect(coverage.missing).toContain("user/create");
        expect(coverage.missing).toContain("user/set-name");
        const health = rec.calls.find((call) => call.url.includes("/health"));
        expect(health).toBeDefined();
        expect(health?.method).toBe("GET");
        expect(health?.status).toBe(200);
      } finally {
        await close();
      }
    });
  });
}
