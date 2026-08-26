/**
 * Peer `/op` for entity- and trait-owned operations: membership checks
 * run before policy and before the body.
 */

import { describe, expect, test } from "bun:test";
import { schemaTx } from "../../packages/ramose/src/db/ensure.ts";
import { json, post, seedTx, uniqueDb, type LocalUrls } from "../local/fixtures.ts";
import { Board } from "../local/ops.ts";

export interface OwnedOperationsTarget {
  readonly urls: () => LocalUrls;
}

const seedBoard = (base: string, db: string) =>
  seedTx(base, db, schemaTx(Board) as unknown[]);

export function registerOwnedOperationsContract(target: OwnedOperationsTarget): void {
  describe("owned operations on the peer", () => {
    test("self:false create returns an id and stamps membership", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("board");
      await seedBoard(openUrl, db);
      const { status, body } = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "issue/create",
          input: { title: "Fix login" },
          clientOpId: "op-create",
        }),
      );
      expect(status).toBe(200);
      expect(typeof body.output.id).toBe("number");
    });

    test("entity instance ops reject a foreign concrete type", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("board");
      await seedBoard(openUrl, db);
      const seed = await seedTx(openUrl, db, [
        { ":db/id": "doc", ":ramose/type": ":doc", ":doc/body": "hi" },
      ]);
      const doc = seed.tempids.doc!;
      const { status, body } = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "issue/rename",
          entity: doc,
          input: { title: "nope" },
          clientOpId: "op-foreign-entity",
        }),
      );
      expect(status).toBe(409);
      expect(body.reason).toBe("foreign");
      expect(body.operation).toBe("issue/rename");
    });

    test("trait ops accept any composer and reject a non-composer", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("board");
      await seedBoard(openUrl, db);
      const seed = await seedTx(openUrl, db, [
        {
          ":db/id": "issue",
          ":ramose/type": ":issue",
          ":issue/title": "Fix login",
        },
        {
          ":db/id": "doc",
          ":ramose/type": ":doc",
          ":doc/body": "notes",
        },
        { ":db/id": "user", ":user/name": "Ada" },
      ]);
      const issue = seed.tempids.issue!;
      const doc = seed.tempids.doc!;
      const user = seed.tempids.user!;

      const onIssue = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "taggable/addTag",
          entity: issue,
          input: { tag: "urgent" },
          clientOpId: "op-tag-issue",
        }),
      );
      expect(onIssue.status).toBe(200);

      const onDoc = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "taggable/addTag",
          entity: doc,
          input: { tag: "reviewed" },
          clientOpId: "op-tag-doc",
        }),
      );
      expect(onDoc.status).toBe(200);

      const onUser = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "taggable/addTag",
          entity: user,
          input: { tag: "nope" },
          clientOpId: "op-tag-user",
        }),
      );
      expect(onUser.status).toBe(409);
      expect(onUser.body.reason).toBe("foreign");
      expect(onUser.body.operation).toBe("taggable/addTag");
    });

    test("self:false does not require an entity argument", async () => {
      const { openUrl } = target.urls();
      const db = uniqueDb("board");
      await seedBoard(openUrl, db);
      const missing = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "issue/rename",
          input: { title: "x" },
          clientOpId: "op-need-entity",
        }),
      );
      expect(missing.status).toBe(409);
      expect(missing.body.reason).toBe("dangling");

      const created = await json(
        openUrl,
        `/db/${db}/op`,
        post({
          name: "issue/create",
          input: { title: "no target" },
          clientOpId: "op-no-target",
        }),
      );
      expect(created.status).toBe(200);
    });
  });
}
