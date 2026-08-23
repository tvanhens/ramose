/**
 * Value shorthands: runtime lowering, option bag, Field.many / Field.unique,
 * and the advanced Field(schema) form.
 */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import {
  Enum,
  Field,
  Ref,
  Schema as DbSchema,
  Entity,
  boolean,
  bytes,
  float,
  int,
  schemaTx,
  string,
  timestamp,
  uuid,
} from "../../src/db/internal.ts";

const User = Entity("user", {
  name: string({ unique: "upsert", doc: "display name" }),
  age: int(),
  score: float(),
  active: boolean(),
  createdAt: timestamp(),
  token: uuid(),
  avatar: bytes(),
  role: Enum(["admin", "member"]),
  friends: Field.many(Ref.self),
  bestFriend: Ref.self,
});

const Label = Entity("label", {
  name: Field.unique(string(), "upsert"),
  color: string(),
});

const Issue = Entity("issue", {
  title: string(),
  labels: Field.many(Ref(Label)),
  author: Ref(User),
});

const Catalog = DbSchema({ user: User, label: Label, issue: Issue });

describe("shorthand schemaTx", () => {
  test("lowers branded shorthands to :db.type/*", () => {
    expect(schemaTx(Catalog)).toEqual([
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
      },
      {
        ":db/ident": ":user/score",
        ":db/valueType": ":db.type/double",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":user/active",
        ":db/valueType": ":db.type/boolean",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":user/createdAt",
        ":db/valueType": ":db.type/instant",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":user/token",
        ":db/valueType": ":db.type/uuid",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":user/avatar",
        ":db/valueType": ":db.type/bytes",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":user/role",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
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
      },
      {
        ":db/ident": ":label/name",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
        ":db/unique": ":db.unique/identity",
        ":db/index": true,
      },
      {
        ":db/ident": ":label/color",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":issue/title",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":issue/labels",
        ":db/valueType": ":db.type/ref",
        ":db/cardinality": ":db.cardinality/many",
      },
      {
        ":db/ident": ":issue/author",
        ":db/valueType": ":db.type/ref",
        ":db/cardinality": ":db.cardinality/one",
      },
    ]);
  });
});

describe("advanced Field(schema)", () => {
  test("raw Effect Schema still installs when inference holds", () => {
    const Note = Entity("note", {
      body: Field(Schema.String),
      n: Field(Schema.Number),
      ok: Field(Schema.Boolean),
    });
    expect(schemaTx(DbSchema({ note: Note }))).toEqual([
      {
        ":db/ident": ":note/body",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":note/n",
        ":db/valueType": ":db.type/double",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":note/ok",
        ":db/valueType": ":db.type/boolean",
        ":db/cardinality": ":db.cardinality/one",
      },
    ]);
  });

  test("literals need an explicit valueType", () => {
    const Flag = Entity("flag", {
      state: Field(Schema.Literals(["on", "off"]), { valueType: "string" }),
    });
    expect(schemaTx(DbSchema({ flag: Flag }))[0]).toMatchObject({
      ":db/ident": ":flag/state",
      ":db/valueType": ":db.type/string",
    });
  });
});

describe("uuid public type", () => {
  test("is a string schema, not a { vt, v } struct", () => {
    expect(User.token.valueType).toBe("uuid");
    expect(User.token.schema.ast._tag).toBe("String");
  });
});
