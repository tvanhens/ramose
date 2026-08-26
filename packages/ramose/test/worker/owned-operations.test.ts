/**
 * Peer `/op` for entity- and trait-owned operations: membership checks
 * run before policy and before the body (issue #317).
 */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import {
  Entity,
  EntityId,
  Field,
  Operation,
  Schema as DbSchema,
  Trait,
  defineOperations,
  schemaTx,
  string,
} from "../../src/db/internal.ts";
import { makePeer, post } from "./harness.ts";

const Taggable = Trait(
  "taggable",
  { tags: Field.many(string()) },
  {
    operations: {
      addTag: Operation({
        input: Schema.Struct({ tag: Schema.String }),
        output: Schema.Struct({}),
        run(op, { tag }) {
          op.self.set(Taggable.tags, tag);
          return {};
        },
      }),
    },
  },
);

const Issue = Entity(
  "issue",
  { title: string() },
  {
    traits: [Taggable],
    operations: {
      create: Operation({
        self: false,
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({ id: EntityId }),
        run(op, input) {
          return { id: op.create({ title: input.title }) };
        },
      }),
      rename: Operation({
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({}),
        run(op, { title }) {
          op.self.set(Issue.title, title);
          return {};
        },
      }),
    },
  },
);

const Doc = Entity("doc", { body: string() }, { traits: [Taggable] });
const User = Entity("user", { name: string() });
const App = DbSchema({ issue: Issue, doc: Doc, user: User });
const operations = defineOperations(App);

describe("owned operations on the peer", () => {
  test("self:false create returns an id and stamps membership", async () => {
    const peer = await makePeer("board", { operations });
    await peer.seed(schemaTx(App) as unknown[]);
    const { status, body } = await peer.json(
      "/db/board/op",
      post({
        name: "issue/create",
        input: { title: "Fix login" },
        clientOpId: "op-create",
      }),
    );
    expect(status).toBe(200);
    expect(typeof body.output.id).toBe("number");
    peer.close();
  });

  test("entity instance ops reject a foreign concrete type", async () => {
    const peer = await makePeer("board", { operations });
    await peer.seed(schemaTx(App) as unknown[]);
    const seed = await peer.seed([
      { ":db/id": "doc", ":ramose/type": ":doc", ":doc/body": "hi" },
    ]);
    const doc = seed.tempids.doc!;
    const { status, body } = await peer.json(
      "/db/board/op",
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
    peer.close();
  });

  test("trait ops accept any composer and reject a non-composer", async () => {
    const peer = await makePeer("board", { operations });
    await peer.seed(schemaTx(App) as unknown[]);
    const seed = await peer.seed([
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

    const onIssue = await peer.json(
      "/db/board/op",
      post({
        name: "taggable/addTag",
        entity: issue,
        input: { tag: "urgent" },
        clientOpId: "op-tag-issue",
      }),
    );
    expect(onIssue.status).toBe(200);

    const onDoc = await peer.json(
      "/db/board/op",
      post({
        name: "taggable/addTag",
        entity: doc,
        input: { tag: "reviewed" },
        clientOpId: "op-tag-doc",
      }),
    );
    expect(onDoc.status).toBe(200);

    const onUser = await peer.json(
      "/db/board/op",
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
    peer.close();
  });

  test("self:false does not require an entity argument", async () => {
    const peer = await makePeer("board", { operations });
    await peer.seed(schemaTx(App) as unknown[]);
    const missing = await peer.json(
      "/db/board/op",
      post({
        name: "issue/rename",
        input: { title: "x" },
        clientOpId: "op-need-entity",
      }),
    );
    expect(missing.status).toBe(409);
    expect(missing.body.reason).toBe("dangling");

    const created = await peer.json(
      "/db/board/op",
      post({
        name: "issue/create",
        input: { title: "no target" },
        clientOpId: "op-no-target",
      }),
    );
    expect(created.status).toBe(200);
    peer.close();
  });
});
