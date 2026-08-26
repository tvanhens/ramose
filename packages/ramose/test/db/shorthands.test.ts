/**
 * Value shorthands: runtime lowering, option bag, Field.many / Field.unique /
 * Field.owned, and the advanced Field(schema) form.
 */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import {
  Enum,
  Field,
  type FieldOptions,
  Ref,
  Schema as DbSchema,
  Entity,
  boolean,
  bytes,
  enumMembersOf,
  float,
  int,
  schemaTx,
  string,
  stored,
  timestamp,
  uuid,
} from "../../src/db/internal.ts";
import { query } from "../../src/internal/core/index.ts";
import { attribute, Harness } from "../internal/transactor/harness.ts";

const User = Entity("user", {
  name: Field.unique(string({ doc: "display name" }), "upsert"),
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
      n: Field(Schema.Finite),
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

  test("literals need stored(schema, vt)", () => {
    const Flag = Entity("flag", {
      state: Field(stored(Schema.Literals(["on", "off"]), "string")),
    });
    expect(schemaTx(DbSchema({ flag: Flag }))[0]).toMatchObject({
      ":db/ident": ":flag/state",
      ":db/valueType": ":db.type/string",
    });
  });

  test("un-inferable schemas throw at schemaTx, not as string", () => {
    const Bad = Entity("bad", {
      state: Field(Schema.Literals(["on", "off"]) as never),
    });
    expect(() => schemaTx(DbSchema({ bad: Bad }))).toThrow(
      /cannot infer value type from this Schema \(ast\._tag=Union\)/,
    );
  });
});

describe("uuid public type", () => {
  test("is a string schema, not a { vt, v } struct", () => {
    expect(User.token.valueType).toBe("uuid");
    expect(User.token.schema.ast._tag).toBe("String");
  });
});

describe("Field composition merge", () => {
  test("composition cannot change valueType; stored() brands the schema", () => {
    expect(Field.unique(string(), "upsert").valueType).toBe("string");
    expect(Field.many(Field.owned(string())).valueType).toBe("string");
    expect(Field.unique(string(), "upsert", { doc: "slug" }).valueType).toBe(
      "string",
    );
    expect(Field(stored(Schema.String, "uuid")).valueType).toBe("uuid");
  });

  test("stored() does not mutate the shared Schema.String", () => {
    expect(Field(Schema.String).valueType).toBe("string");
    expect(Field(stored(Schema.String, "uuid")).valueType).toBe("uuid");
    expect(Field(Schema.String).valueType).toBe("string");
  });

  test("a valueType key in the options bag throws", () => {
    const bag = { valueType: "uuid" } as FieldOptions;
    expect(() => Field(Schema.String, bag)).toThrow(
      "ramose/schema: valueType is not a field option. Brand the schema with stored(schema, vt).",
    );
    expect(() => Field(string(), bag)).toThrow(
      "ramose/schema: valueType is not a field option. Brand the schema with stored(schema, vt).",
    );
    expect(() => string(bag)).toThrow(
      "ramose/schema: valueType is not a field option. Brand the schema with stored(schema, vt).",
    );
  });

  test("retired type-bearing keys in the options bag throw", () => {
    expect(() => Field(Schema.String, { cardinality: "many" } as FieldOptions)).toThrow(
      "ramose/schema: cardinality is not a field option. Use Field.many(schema).",
    );
    expect(() => Field(Schema.String, { unique: "upsert" } as FieldOptions)).toThrow(
      'ramose/schema: unique is not a field option. Use Field.unique(schema, "upsert" | "strict").',
    );
    expect(() => Field(Schema.String, { owned: true } as FieldOptions)).toThrow(
      "ramose/schema: owned is not a field option. Use Field.owned(schema).",
    );
    expect(() =>
      Field(Schema.String, { isComponent: true } as FieldOptions),
    ).toThrow("ramose/schema: owned is not a field option. Use Field.owned(schema).");
  });

  test("owned composes through Field.owned / Field.many / Field.unique", () => {
    expect(Field.owned(string()).owned).toBe(true);
    expect(Field.many(Field.owned(string())).owned).toBe(true);
    expect(Field.many(Field.owned(string())).cardinality).toBe("many");
    expect(Field.unique(Field.owned(string()), "upsert").owned).toBe(true);
    expect(Field(Field.owned(string()), { doc: "keep" }).owned).toBe(true);
    expect(Field(Field.owned(string()), { doc: "keep" }).doc).toBe("keep");
  });

  test("annotating FieldOptions cannot erase many / unique / owned", () => {
    const bag: FieldOptions = { doc: "shared" };
    const many = Field.many(string(), bag);
    const unique = Field.unique(string(), "strict", bag);
    const owned = Field.owned(string(), bag);
    expect(many.cardinality).toBe("many");
    expect(many.doc).toBe("shared");
    expect(unique.unique).toBe("strict");
    expect(unique.doc).toBe("shared");
    expect(owned.owned).toBe(true);
    expect(owned.doc).toBe("shared");
  });

  test("isOptional is true from { optional: true } or an AST that admits undefined", () => {
    expect(string().isOptional).toBe(false);
    expect(string({ optional: true }).isOptional).toBe(true);
    expect(Field(Schema.String).isOptional).toBe(false);
    // Type-level Opt stays false unless `{ optional: true }` — unchanged.
    // Runtime still reads the AST. Widen through boolean so tsc does not
    // fight the existing OptionalOf inference.
    const runtimeOptional = (field: { readonly isOptional: boolean }): boolean =>
      field.isOptional;
    expect(runtimeOptional(Field(stored(Schema.UndefinedOr(Schema.String), "string")))).toBe(
      true,
    );
    expect(runtimeOptional(Field(stored(Schema.optional(Schema.String), "string")))).toBe(true);
  });

  test("Field.unique always indexes; index: false is discarded", () => {
    expect(Field.unique(string({ index: false }), "upsert").index).toBe(true);
  });

  test("bare Field(Ref) is an untargeted ref", () => {
    expect(Field(Ref).valueType).toBe("ref");
  });

  test("Enum([]) throws before a schema is built", () => {
    expect(() => Enum([] as never)).toThrow(
      "ramose/schema: Enum([...]) needs at least one value",
    );
  });

  test("Enum carries members through Entity stamp and Field composition", () => {
    expect(User.role.members).toEqual(["admin", "member"]);
    expect(User.role.valueType).toBe("string");
    const composed = Field(Enum(["low", "med"]), { doc: "priority" });
    expect(enumMembersOf(composed.schema)).toEqual(["low", "med"]);
    expect(composed.doc).toBe("priority");
    expect(composed.valueType).toBe("string");
  });
});

describe("uuid through the server", () => {
  test("a plain string writes and a string comes back from query", async () => {
    const h = new Harness();
    await h.transactor.init();
    await h.transactor.transact([attribute(":item/uid", "uuid")]);
    const ack = await h.transactor.transact([
      { ":db/id": "item", ":item/uid": "3F333DF6-90A4-4FDA-8DD3-9485D27CEE36" },
    ]);
    const uid = await query(
      h.transactor.connection.db(),
      `[:find ?uid . :in $ ?e :where [?e :item/uid ?uid]]`,
      [ack.tempids.item],
    );
    expect(uid).toBe("3f333df6-90a4-4fda-8dd3-9485d27cee36");
    expect(typeof uid).toBe("string");
  });
});
