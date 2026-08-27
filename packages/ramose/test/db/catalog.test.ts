/**
 * Runtime lowering: catalog → ident datoms, q clauses, tx ops. No peer I/O.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Field,
  Schema as DbSchema,
  Entity,
  schemaTx,
  txBuilder,
  again,
  lowerPullPattern,
  reshapePullResult,
  Long,
  Ref,
  type Eid,
  txOps,
  txSchema,
} from "../../src/db/internal.ts";

const User = Entity("user", {
  name: Field.unique(Schema.String, "upsert", { doc: "display name" }),
  age: Field(Long, { optional: true }),
  friends: Field.many(Ref.self),
  bestFriend: Field(Ref.self, { optional: true }),
});

const Meta = Entity("meta", {
  source: Field(Schema.String),
});

const Movies = DbSchema({ user: User, meta: Meta });

describe("schemaTx", () => {
  test("lowers to ident datom maps (separate ensure tx)", () => {
    expect(schemaTx(Movies)).toEqual([
      {
        ":db/ident": ":user/name",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
        ":db/unique": ":db.unique/identity",
        ":db/index": true,
        ":db/doc": "display name",
      },
      {
        ":db/ident": ":user/age",
        ":db/valueType": ":db.type/long",
        ":db/cardinality": ":db.cardinality/one",
        ":db/optional": true,
      },
      {
        ":db/ident": ":user/friends",
        ":db/valueType": ":db.type/ref",
        ":db/cardinality": ":db.cardinality/many",
      },
      {
        ":db/ident": ":user/bestFriend",
        ":db/valueType": ":db.type/ref",
        ":db/cardinality": ":db.cardinality/one",
        ":db/optional": true,
      },
      {
        ":db/ident": ":meta/source",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
      { ":db/ident": ":meta", ":ramose/kind": ":ramose.kind/entity" },
      { ":db/ident": ":user", ":ramose/kind": ":ramose.kind/entity" },
    ]);
  });
});

describe("transaction builder", () => {
  test("entity is a bag: attrs from two namespaces lower to :db/add", () => {
    const tx = txBuilder(Movies);
    Effect.runSync(
      Effect.gen(function* () {
        const ada = yield* tx.entity();
        yield* ada.set(User.name, "Ada");
        yield* ada.set(User.age, 36);
        yield* ada.set(Meta.source, "import");
        yield* ada.remove(User.age, 35);
        yield* tx.set(1001, User.friends, 1002);
        yield* tx.delete(1001);
        const byLookup = yield* tx.entity([User.name, "Ada"]);
        yield* byLookup.set(Meta.source, "lookup");
      }),
    );
    expect(txOps(tx)).toEqual([
      [":db/add", "tmp-1", ":ramose/type", ":user"],
      [":db/add", "tmp-1", ":user/name", "Ada"],
      [":db/add", "tmp-1", ":user/age", 36],
      [":db/add", "tmp-1", ":ramose/type", ":meta"],
      [":db/add", "tmp-1", ":meta/source", "import"],
      [":db/retract", "tmp-1", ":user/age", 35],
      [":db/add", 1001, ":ramose/type", ":user"],
      [":db/add", 1001, ":user/friends", 1002],
      [":db/retractEntity", 1001],
      [":db/add", [":user/name", "Ada"], ":ramose/type", ":meta"],
      [":db/add", [":user/name", "Ada"], ":meta/source", "lookup"],
    ]);
    expect(txSchema(tx)).toBe(Movies);
  });

  test("put lowers to map form; undefined is omitted; many is an array", () => {
    const tx = txBuilder(Movies);
    Effect.runSync(
      Effect.gen(function* () {
        const bea = yield* tx.entity();
        yield* bea.set(User.name, "Bea");
        const ada = yield* tx.put(User, {
          name: "Ada",
          age: undefined,
          friends: [1002, bea],
        });
        yield* tx.put(User, ada, { age: 36 });
        yield* tx.put(User, { name: "Ada" });
      }),
    );
    expect(txOps(tx)).toEqual([
      [":db/add", "tmp-1", ":ramose/type", ":user"],
      [":db/add", "tmp-1", ":user/name", "Bea"],
      {
        ":db/id": "tmp-2",
        ":ramose/type": ":user",
        ":user/name": "Ada",
        ":user/friends": [1002, "tmp-1"],
      },
      { ":db/id": "tmp-2", ":ramose/type": ":user", ":user/age": 36 },
      { ":db/id": "tmp-3", ":ramose/type": ":user", ":user/name": "Ada" },
    ]);
  });

  test("put expands a card-many ident-shaped string pair to :db/add", () => {
    const Doc = Entity("doc", {
      tags: Field.many(Schema.String),
    });
    const Docs = DbSchema({ doc: Doc });
    const tx = txBuilder(Docs);
    Effect.runSync(tx.put(Doc, { tags: [":alpha", "beta"] }));
    expect(txOps(tx)).toEqual([
      { ":db/id": "tmp-1", ":ramose/type": ":doc" },
      [":db/add", "tmp-1", ":doc/tags", ":alpha"],
      [":db/add", "tmp-1", ":doc/tags", "beta"],
    ]);
  });

  test("put unwraps {id} rows and op.principal in ref slots", () => {
    const tx = txBuilder(Movies);
    Effect.runSync(
      Effect.gen(function* () {
        yield* tx.put(User, {
          name: "Ada",
          bestFriend: { id: 1002 as Eid<typeof User> },
        });
        yield* tx.put(User, { name: "Bea", bestFriend: { eid: 1003, class: "user" } });
        yield* tx.put(User, { name: "Cam", bestFriend: { eid: null, class: "user" } });
        yield* tx.put(User, 1001, { age: 36 });
      }),
    );
    expect(txOps(tx)).toEqual([
      { ":db/id": "tmp-1", ":ramose/type": ":user", ":user/name": "Ada", ":user/bestFriend": 1002 },
      { ":db/id": "tmp-2", ":ramose/type": ":user", ":user/name": "Bea", ":user/bestFriend": 1003 },
      { ":db/id": "tmp-3", ":ramose/type": ":user", ":user/name": "Cam" },
      { ":db/id": 1001, ":ramose/type": ":user", ":user/age": 36 },
    ]);
  });
});


describe("pull lowering", () => {
  test("literate map becomes :as / nested AST the peer already accepts", () => {
    expect(
      lowerPullPattern({
        name: User.name,
        age: User.age.optional,
        friends: User.friends.select({ name: User.name }),
      }),
    ).toEqual([
      { kind: "attr", attr: ":user/name", reverse: false, as: "name" },
      { kind: "attr", attr: ":user/age", reverse: false, as: "age" },
      {
        kind: "attr",
        attr: ":user/friends",
        reverse: false,
        as: "friends",
        sub: [{ kind: "attr", attr: ":user/name", reverse: false, as: "name" }],
      },
    ]);
  });

  test("ident-keyed array stays ident strings", () => {
    expect(lowerPullPattern([User.name, ":user/age", "*"])).toEqual([
      ":user/name",
      ":user/age",
      "*",
    ]);
  });
});

describe("reshapePullResult", () => {
  test("required field missing → null; optional missing → undefined", () => {
    expect(
      reshapePullResult({ name: User.name, age: User.age }, { name: "Ada" }),
    ).toBeNull();
    expect(
      reshapePullResult(
        { name: User.name, age: User.age.optional },
        { name: "Ada" },
      ),
    ).toEqual({ name: "Ada", age: undefined });
  });

  test("required card-one .select missing or incomplete → parent null", () => {
    expect(
      reshapePullResult(
        {
          name: User.name,
          bestFriend: User.bestFriend.select({ name: User.name }),
        },
        { name: "Ada" },
      ),
    ).toBeNull();
    expect(
      reshapePullResult(
        {
          name: User.name,
          bestFriend: User.bestFriend.select({ name: User.name }),
        },
        { name: "Ada", bestFriend: { ":db/id": 9 } },
      ),
    ).toBeNull();
    expect(
      reshapePullResult(
        {
          name: User.name,
          bestFriend: User.bestFriend.optional.select({ name: User.name }),
        },
        { name: "Ada" },
      ),
    ).toEqual({ name: "Ada", bestFriend: undefined });
  });

  test("required scalar null is missing", () => {
    expect(
      reshapePullResult(
        { name: User.name, age: User.age },
        { name: "Ada", age: null },
      ),
    ).toBeNull();
  });

  test("nested many filters incomplete children; empty after filter is []", () => {
    expect(
      reshapePullResult(
        { friends: User.friends.select({ name: User.name }) },
        {
          friends: [
            { name: "Alonzo" },
            { ":db/id": 2 },
            { name: null },
          ],
        },
      ),
    ).toEqual({ friends: [{ name: "Alonzo" }] });
    expect(
      reshapePullResult(
        { friends: User.friends.select({ name: User.name }) },
        { friends: [{ ":db/id": 2 }] },
      ),
    ).toEqual({ friends: [] });
  });

  const Node = Entity("node", {
    label: Field(Schema.String),
    next: Field(Ref.self),
    kids: Field.many(Ref.self),
  });

  test("IR stub remaps to the shape's id key and is not dropped", () => {
    const shape = {
      id: Node.id,
      label: Node.label,
      kids: Node.kids.select(again(2), { limit: 10 }),
    };
    expect(
      reshapePullResult(shape, {
        id: 1,
        label: "root",
        kids: [
          { id: 2, label: "child", kids: [{ ":db/id": 1 }] },
        ],
      }),
    ).toEqual({
      id: 1,
      label: "root",
      kids: [{ id: 2, label: "child", kids: [{ id: 1 }] }],
    });
  });

  test("missing card-one again does not drop the parent", () => {
    const shape = {
      id: Node.id,
      label: Node.label,
      next: Node.next.select(again(2)),
    };
    expect(
      reshapePullResult(shape, {
        id: 1,
        label: "leaf",
      }),
    ).toEqual({
      id: 1,
      label: "leaf",
      next: undefined,
    });
  });

  test("card-one cycle stub keeps the parent", () => {
    const shape = {
      id: Node.id,
      label: Node.label,
      next: Node.next.select(again(2)),
    };
    expect(
      reshapePullResult(shape, {
        id: 1,
        label: "a",
        next: { id: 2, label: "b", next: { ":db/id": 1 } },
      }),
    ).toEqual({
      id: 1,
      label: "a",
      next: { id: 2, label: "b", next: { id: 1 } },
    });
  });
});

describe("again through a targeted forward ref", () => {
  const Project = Entity("project", { name: Field(Schema.String) });
  const Todo = Entity("todo", {
    title: Field(Schema.String),
    project: Field(Ref(() => Project)),
  });

  test("a :todo/… shape recurring through Todo.project throws the cross-entity again error", () => {
    expect(() =>
      lowerPullPattern({
        id: Todo.id,
        title: Todo.title,
        project: Todo.project.select(again(1)),
      }),
    ).toThrow(
      /select field "project": Todo\.project\.select\(Ramose\.again\(1\)\) is a :project\/… edge — again re-applies this shape, which is a :todo\/… row/,
    );
  });
});

