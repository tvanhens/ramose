/**
 * Ident-name rule and Entity / Schema definition-time validation (#184).
 *
 * Reserved keys, bad names, catalog-key / ns drift, and duplicate entities
 * used to install silently. These tests pin the throw and the exported
 * predicate — type-level rejection lives in `entity-schema-types.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  Entity,
  IDENT_NAME_RE,
  RESERVED_ENTITY_NAMES,
  RESERVED_FIELD_KEYS,
  Schema,
  Trait,
  isIdentName,
  isReservedEntityName,
  isReservedFieldKey,
  string,
  type AnyEntity,
  type AnyField,
} from "../../src/db/index.ts";
import { merge, type EntityMap } from "../../src/db/internal.ts";

const OK = ["a", "todo", "User", "createdAt", "created_at", "created-at", "x".repeat(64)];
const BAD = [
  "",
  "1todo",
  "-leading",
  "_leading",
  "my ns",
  "my/ns",
  "a b",
  "has.dot",
  "has:colon",
  "x".repeat(65),
];

describe("ident names", () => {
  test("the regex is the entity / field name rule", () => {
    for (const ok of OK) expect(IDENT_NAME_RE.test(ok)).toBe(true);
    for (const bad of BAD) expect(IDENT_NAME_RE.test(bad)).toBe(false);
  });

  test("isIdentName is the regex as a predicate", () => {
    for (const name of [...OK, ...BAD]) {
      expect(isIdentName(name)).toBe(IDENT_NAME_RE.test(name));
    }
  });

  test("reserved field keys are the Entity metadata names", () => {
    expect([...RESERVED_FIELD_KEYS]).toEqual(["id", "ns", "fields", "_tag", "traits"]);
    for (const key of RESERVED_FIELD_KEYS) {
      expect(isReservedFieldKey(key)).toBe(true);
    }
    expect(isIdentName("id")).toBe(true);
    expect(isIdentName("ns")).toBe(true);
    expect(isIdentName("fields")).toBe(true);
    expect(isIdentName("traits")).toBe(true);
    expect(isIdentName("_tag")).toBe(false);
    expect(isReservedFieldKey("title")).toBe(false);
  });

  test("db and ramose are reserved entity / trait namespaces", () => {
    expect([...RESERVED_ENTITY_NAMES]).toEqual(["db", "ramose"]);
    for (const name of RESERVED_ENTITY_NAMES) {
      expect(isReservedEntityName(name)).toBe(true);
      expect(isIdentName(name)).toBe(true);
    }
    expect(isReservedEntityName("todo")).toBe(false);
  });
});

describe("Entity()", () => {
  test("stamps a valid name and keeps Entity.id as :db/id", () => {
    const Post = Entity("post", { title: string() });
    expect(Post.ns).toBe("post");
    expect(Post.title.ident).toBe(":post/title");
    expect(Post.id.ident).toBe(":db/id");
    expect(Post.fields.title).toBe(Post.title);
  });

  test("rejects a reserved field key before it can overwrite metadata", () => {
    for (const key of RESERVED_FIELD_KEYS) {
      expect(() => Entity("post", { [key]: string() })).toThrow(
        /reserved — id, ns, fields, _tag, and traits are Entity \/ Trait metadata/,
      );
    }
    const Post = Entity("post", { title: string() });
    expect(Post.id.ident).toBe(":db/id");
    expect(Post.ns).toBe("post");
    expect(Post._tag).toBe("Entity");
    expect(Post.fields.title.ident).toBe(":post/title");
  });

  test("rejects an invalid entity name", () => {
    const name: string = "my ns/x";
    expect(() => Entity(name, { title: string() })).toThrow(
      /invalid entity name "my ns\/x"/,
    );
  });

  test("rejects system namespaces as entity or trait names", () => {
    const db: string = "db";
    const ramose: string = "ramose";
    expect(() => Entity(db, { name: string() })).toThrow(
      /entity name "db" is reserved/,
    );
    expect(() => Entity(ramose, { name: string() })).toThrow(
      /entity name "ramose" is reserved/,
    );
    expect(() => Trait(db, { name: string() })).toThrow(
      /trait name "db" is reserved/,
    );
    expect(() => Trait(ramose, { name: string() })).toThrow(
      /trait name "ramose" is reserved/,
    );
  });

  test("rejects an invalid field key", () => {
    const fields: Record<string, AnyField> = { "a b": string() };
    expect(() => Entity("post", fields)).toThrow(/invalid field name "a b"/);
  });
});

describe("Schema()", () => {
  const Todo = Entity("todo", { title: string() });
  const Label = Entity("label", { name: string() });

  test("object form accepts a key that equals the entity name", () => {
    const schema = Schema({ todo: Todo, label: Label });
    expect(Object.keys(schema.entities)).toEqual(["todo", "label"]);
    expect(schema.entities.todo).toBe(Todo);
  });

  test("array form keys each entity by its own name", () => {
    const schema = Schema([Todo, Label]);
    expect(schema.entities.todo).toBe(Todo);
    expect(schema.entities.label).toBe(Label);
    expect(schema).toEqual(Schema({ todo: Todo, label: Label }));
  });

  test("rejects a catalog key that does not match the entity name", () => {
    const drifted = { todos: Todo } as unknown as EntityMap;
    expect(() => Schema(drifted)).toThrow(
      /Schema key "todos" does not match Entity name "todo"/,
    );
  });

  test("rejects two array entries with the same entity name", () => {
    const Other = Entity("todo", { done: string() });
    const dupes: readonly AnyEntity[] = [Todo, Other];
    expect(() => Schema(dupes)).toThrow(/duplicate entity name "todo"/);
  });

  test("rejects a non-entity in the array form", () => {
    const list = [Todo, { ns: "ghost" }] as readonly AnyEntity[];
    expect(() => Schema(list)).toThrow(
      /Schema\(\[\.\.\.\]\) expects Entity values/,
    );
  });

  test("array form does not treat Object.prototype names as duplicates", () => {
    const proto = [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ] as const;
    for (const ns of proto) {
      const E = Entity(ns, { title: string() });
      expect(Schema([E]).entities[ns]).toBe(E);
    }
    const Ctor = Entity("constructor", { title: string() });
    expect(Schema({ constructor: Ctor }).entities.constructor).toBe(Ctor);
  });
});

describe("merge()", () => {
  test("concatenates disjoint schemas", () => {
    const Todo = Entity("todo", { title: string() });
    const Label = Entity("label", { name: string() });
    const merged = merge(Schema({ todo: Todo }), Schema({ label: Label }));
    expect(merged.entities.todo).toBe(Todo);
    expect(merged.entities.label).toBe(Label);
  });

  test("rejects an overlapping entity name", () => {
    const A = Entity("todo", { title: string() });
    const B = Entity("todo", { done: string() });
    expect(() =>
      // @ts-expect-error duplicate entity name
      merge(Schema({ todo: A }), Schema({ todo: B })),
    ).toThrow(/duplicate entity name "todo"/);
  });
});
