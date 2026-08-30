
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as EffectSchema from "effect/Schema";
import { Catalog } from "../../src/Catalog.ts";
import {
  Entity,
  Field,
  Schema,
  Trait,
  string,
} from "../../src/db/internal.ts";
import { compositionFromSchema } from "../../src/db/composition.ts";
import { compileReadAuthorization } from "../../src/internal/authorization/index.ts";
import { lowerOwnedOperations } from "../../src/internal/authorization/authoring/index.ts";
import {
  CatalogId,
  DigestHex,
} from "../../src/internal/authorization/identities.ts";
import { completeSchema } from "../../src/internal/authorization/read-tables.ts";
import {
  installClientOperations,
  selfOperationsFor,
} from "../../src/client/operations.ts";

const Taggable = Trait("taggable", { tag: string() }, {
  operations: (Operation) => ({
    addTag: Operation({
      input: EffectSchema.Struct({ tag: EffectSchema.String }),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});

const Issue = Entity("issue", { title: string() }, {
  traits: [Taggable],
  operations: (Operation) => ({
    close: Operation({
      input: EffectSchema.Struct({ reason: EffectSchema.String }),
      output: EffectSchema.Struct({ ok: EffectSchema.Boolean }),
      run() {
        return { ok: true };
      },
    }),
    createIssue: Operation({
      self: false,
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});

const Note = Entity("note", { body: Field(string()) });

const AppSchema = Schema({ issue: Issue, note: Note });

const AppCatalog = Catalog("app", {
  schema: AppSchema,
  policy: compileReadAuthorization({ schema: AppSchema, rules: [] }),
});

const installed = () =>
  installClientOperations(AppCatalog, completeSchema(AppCatalog));

describe("the installed client mutation surface", () => {
  test("pins the version the deployment lowered, from the authored catalog alone", async () => {
    const operations = installed();
    const deployed = await Effect.runPromise(lowerOwnedOperations(
      CatalogId.make("app"),
      [completeSchema(AppCatalog)],
      DigestHex.make("a".repeat(64)),
    ));
    const byName = new Map(deployed.descriptors.map((descriptor) =>
      [`${descriptor.id.owner.name}.${descriptor.id.localName}`, descriptor.version]
    ));
    expect(byName.size).toBe(3);
    expect(await operations.database.get("createIssue")!.version())
      .toBe(byName.get("issue.createIssue")!);
    expect(
      await selfOperationsFor(
        operations,
        compositionFromSchema(completeSchema(AppCatalog)),
        "issue",
      ).get("close")!.version(),
    ).toBe(byName.get("issue.close")!);
  });

  test("separates targetless from targeted, and reaches trait operations through composition", async () => {
    const operations = installed();
    const composition = compositionFromSchema(completeSchema(AppCatalog));

    expect([...operations.database.keys()]).toEqual(["createIssue"]);
    expect(operations.database.get("createIssue")?.self).toBe(false);

    const issue = selfOperationsFor(operations, composition, "issue");
    expect([...issue.keys()].sort()).toEqual(["addTag", "close"]);
    expect(issue.get("addTag")?.owner).toEqual({ kind: "trait", name: "taggable" });
    expect(issue.get("close")?.self).toBe(true);

    expect([...selfOperationsFor(operations, composition, "note").keys()]).toEqual([]);
  });

  test("carries the inert descriptor the durable queue needs, and no operation body", async () => {
    const operations = installed();
    const create = operations.database.get("createIssue")!;
    expect(await create.version()).toMatch(/^[0-9a-f]{64}$/);
    expect(create.version()).toBe(create.version());
    expect(create.allocations).toEqual([]);
    expect(create.input._tag).toBe("struct");
    expect(create.encode({ title: "Offline" })).toEqual({ title: "Offline" });
    expect(Object.keys(create)).not.toContain("run");
  });

  test("installs one projection entry per operation, whether or not it declares one", async () => {
    const operations = installed();
    expect(operations.installed.length).toBe(3);
    expect(operations.installed.every((entry) => entry.projection === undefined))
      .toBe(true);
    expect(operations.installed.map((entry) => entry.operation.localName).sort())
      .toEqual(["addTag", "close", "createIssue"]);
  });
});
