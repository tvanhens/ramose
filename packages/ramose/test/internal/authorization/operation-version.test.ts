/** Operation-scoped compatibility versions (#487). */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Entity,
  Schema as CatalogSchema,
  Trait,
  string,
} from "../../../src/db/internal.ts";
import type { AnySchema } from "../../../src/db/Schema.ts";
import { lowerOwnedOperations } from "../../../src/internal/authorization/authoring/index.ts";
import {
  CatalogId,
  DigestHex,
} from "../../../src/internal/authorization/identities.ts";
import {
  DEFAULT_OPERATION_REVISION,
  hashOperationVersion,
  normalizeContractRepresentation,
  operationVersionMaterial,
  requireOperationRevision,
  type OperationVersionDescriptor,
} from "../../../src/internal/authorization/operation-version.ts";

const catalog = CatalogId.make("app");
const deployment = DigestHex.make("a".repeat(64));
const redeployment = DigestHex.make("b".repeat(64));

const Taggable = () =>
  Trait("taggable", { tags: string() }, {
    operations: (Operation) => ({
      addTag: Operation({
        input: Schema.Struct({ tag: Schema.String }),
        output: Schema.Struct({}),
        run() {
          return {};
        },
      }),
    }),
  });

/** Baseline catalog. Every variant below changes exactly one thing. */
const baseCatalog = () => {
  const taggable = Taggable();
  const Issue = Entity("issue", { title: string() }, {
    traits: [taggable],
    operations: (Operation) => ({
      close: Operation({
        input: Schema.Struct({ reason: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run() {
          return { ok: true };
        },
      }),
    }),
  });
  const Note = Entity("note", { body: string() });
  return CatalogSchema({ issue: Issue, note: Note });
};

const documentedCatalog = () => {
  const taggable = Taggable();
  const Issue = Entity("issue", { title: string() }, {
    traits: [taggable],
    operations: (Operation) => ({
      close: Operation({
        doc: "Close one issue",
        input: Schema.Struct({ reason: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run() {
          return { ok: true };
        },
      }),
    }),
  });
  const Note = Entity("note", { body: string() });
  return CatalogSchema({ issue: Issue, note: Note });
};

/** Only JSON Schema documentation annotations differ from the baseline. */
const annotatedSchemaCatalog = () => {
  const taggable = Taggable();
  const Issue = Entity("issue", { title: string() }, {
    traits: [taggable],
    operations: (Operation) => ({
      close: Operation({
        input: Schema.Struct({
          reason: Schema.String.annotate({
            title: "Reason",
            description: "why the issue closed",
          }),
        }).annotate({ description: "close input" }),
        output: Schema.Struct({ ok: Schema.Boolean }).annotate({
          description: "close output",
        }),
        run() {
          return { ok: true };
        },
      }),
    }),
  });
  const Note = Entity("note", { body: string() });
  return CatalogSchema({ issue: Issue, note: Note });
};

/** Only the shared schema's `identifier` alias differs from the baseline. */
const aliasedSchemaCatalog = (alias: string) => () => {
  const taggable = Taggable();
  const Shared = Schema.Struct({ note: Schema.String }).annotate({
    identifier: alias,
  });
  const Issue = Entity("issue", { title: string() }, {
    traits: [taggable],
    operations: (Operation) => ({
      close: Operation({
        input: Schema.Struct({ reason: Schema.String, first: Shared, second: Shared }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run() {
          return { ok: true };
        },
      }),
    }),
  });
  const Note = Entity("note", { body: string() });
  return CatalogSchema({ issue: Issue, note: Note });
};

/** An unrelated entity, field, and operation added to the same catalog. */
const unrelatedCatalog = () => {
  const taggable = Taggable();
  const Issue = Entity("issue", { title: string() }, {
    traits: [taggable],
    operations: (Operation) => ({
      close: Operation({
        input: Schema.Struct({ reason: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run() {
          return { ok: true };
        },
      }),
    }),
  });
  const Note = Entity("note", { body: string(), pinned: string() });
  const Audit = Entity("audit", { message: string() }, {
    operations: (Operation) => ({
      record: Operation({
        input: Schema.Struct({ message: Schema.String }),
        output: Schema.Struct({}),
        run() {
          return {};
        },
      }),
    }),
  });
  return CatalogSchema({ issue: Issue, note: Note, audit: Audit });
};

const revisedCatalog = () => {
  const taggable = Taggable();
  const Issue = Entity("issue", { title: string() }, {
    traits: [taggable],
    operations: (Operation) => ({
      close: Operation({
        revision: 2,
        input: Schema.Struct({ reason: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run() {
          return { ok: true };
        },
      }),
    }),
  });
  const Note = Entity("note", { body: string() });
  return CatalogSchema({ issue: Issue, note: Note });
};

const changedInputCatalog = () => {
  const taggable = Taggable();
  const Issue = Entity("issue", { title: string() }, {
    traits: [taggable],
    operations: (Operation) => ({
      close: Operation({
        input: Schema.Struct({ reason: Schema.String, force: Schema.Boolean }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run() {
          return { ok: true };
        },
      }),
    }),
  });
  const Note = Entity("note", { body: string() });
  return CatalogSchema({ issue: Issue, note: Note });
};

const changedOutputCatalog = () => {
  const taggable = Taggable();
  const Issue = Entity("issue", { title: string() }, {
    traits: [taggable],
    operations: (Operation) => ({
      close: Operation({
        input: Schema.Struct({ reason: Schema.String }),
        output: Schema.Struct({ ok: Schema.String }),
        run() {
          return { ok: "yes" };
        },
      }),
    }),
  });
  const Note = Entity("note", { body: string() });
  return CatalogSchema({ issue: Issue, note: Note });
};

const targetlessCatalog = () => {
  const taggable = Taggable();
  const Issue = Entity("issue", { title: string() }, {
    traits: [taggable],
    operations: (Operation) => ({
      close: Operation({
        self: false,
        input: Schema.Struct({ reason: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run() {
          return { ok: true };
        },
      }),
    }),
  });
  const Note = Entity("note", { body: string() });
  return CatalogSchema({ issue: Issue, note: Note });
};

const writingCatalog = () => {
  const taggable = Taggable();
  const Audit = Entity("audit", { message: string() });
  const Issue = Entity("issue", { title: string() }, {
    traits: [taggable],
    operations: (Operation) => ({
      close: Operation({
        writes: [Audit],
        input: Schema.Struct({ reason: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run() {
          return { ok: true };
        },
      }),
    }),
  });
  const Note = Entity("note", { body: string() });
  return CatalogSchema({ issue: Issue, note: Note, audit: Audit });
};

/** `note` now composes the trait, so the trait operation admits one more type. */
const extraComposerCatalog = () => {
  const taggable = Taggable();
  const Issue = Entity("issue", { title: string() }, {
    traits: [taggable],
    operations: (Operation) => ({
      close: Operation({
        input: Schema.Struct({ reason: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        run() {
          return { ok: true };
        },
      }),
    }),
  });
  const Note = Entity("note", { body: string() }, { traits: [taggable] });
  return CatalogSchema({ issue: Issue, note: Note });
};

const versions = async (
  build: () => AnySchema,
  artifactHash = deployment,
): Promise<Record<string, string>> => {
  const lowered = await Effect.runPromise(
    lowerOwnedOperations(catalog, build(), artifactHash),
  );
  return Object.fromEntries(lowered.descriptors.map((descriptor) => [
    `${descriptor.id.owner.name}.${descriptor.id.localName}`,
    descriptor.version as string,
  ]));
};

const descriptorFixture = (
  overrides: Partial<OperationVersionDescriptor> = {},
): OperationVersionDescriptor => ({
  catalog,
  owner: { kind: "entity", name: "issue" },
  localName: "close",
  target: "required",
  revision: DEFAULT_OPERATION_REVISION,
  input: { representation: { type: "object" }, shape: { _tag: "opaque" } },
  output: { representation: { type: "object" }, shape: { _tag: "opaque" } },
  composers: [],
  writes: [],
  ...overrides,
});

describe("canonical operation version descriptor", () => {
  test("freezes exactly the operation-scoped field list", () => {
    expect(operationVersionMaterial(descriptorFixture({
      composers: ["note", "issue", "issue"],
      writes: ["audit", "note", "audit"],
      revision: 3,
    }))).toEqual({
      version: 1,
      operation: {
        catalog: "app",
        owner: { kind: "entity", name: "issue" },
        localName: "close",
        target: "required",
      },
      revision: 3,
      contract: {
        input: { representation: { type: "object" }, shape: { _tag: "opaque" } },
        output: { representation: { type: "object" }, shape: { _tag: "opaque" } },
      },
      // Deduplicated and sorted: authoring or discovery order never rotates.
      behavior: { composers: ["issue", "note"], writes: ["audit", "note"] },
    });
  });

  test("strips documentation keywords from a contract without touching data", () => {
    const document = {
      dialect: "draft-2020-12",
      schema: {
        type: "object",
        title: "Close input",
        description: "documentation",
        properties: {
          // A property literally named `description` is data, not an
          // annotation, and must survive with its own contract intact.
          description: { type: "string", description: "documented" },
          items: { type: "array", items: { type: "number", title: "n" } },
          choice: {
            anyOf: [{ type: "string", description: "a" }, { type: "null" }],
          },
          vendor: { "x-ramose": { description: "unknown keyword kept" } },
        },
        required: ["description"],
      },
      definitions: { Note: { type: "string", description: "note" } },
    };
    expect(normalizeContractRepresentation(document)).toEqual({
      dialect: "draft-2020-12",
      schema: {
        type: "object",
        properties: {
          description: { type: "string" },
          items: { type: "array", items: { type: "number" } },
          choice: { anyOf: [{ type: "string" }, { type: "null" }] },
          vendor: { "x-ramose": { description: "unknown keyword kept" } },
        },
        required: ["description"],
      },
      // Unreferenced definitions still land in a deterministic slot.
      definitions: { d0: { type: "string" } },
    });
    // An unrecognized document shape is hashed verbatim rather than guessed at.
    expect(normalizeContractRepresentation({ description: "not a document" }))
      .toEqual({ description: "not a document" });
  });

  test("renames definitions by structural position so wire aliases cannot rotate", () => {
    const document = (first: string, second: string) => ({
      dialect: "draft-2020-12",
      schema: {
        type: "object",
        properties: {
          // Sorted-key traversal, so `a` is reached before `b` whatever order
          // the projection happened to emit.
          b: { $ref: `#/$defs/${second}` },
          a: { $ref: `#/$defs/${first}` },
        },
      },
      definitions: {
        [second]: { type: "number" },
        // Self-recursive: the rename must terminate and stay consistent.
        [first]: {
          type: "object",
          properties: { next: { $ref: `#/$defs/${first}` } },
        },
      },
    });
    const canonical = {
      dialect: "draft-2020-12",
      schema: {
        type: "object",
        properties: {
          b: { $ref: "#/$defs/d1" },
          a: { $ref: "#/$defs/d0" },
        },
      },
      definitions: {
        d0: { type: "object", properties: { next: { $ref: "#/$defs/d0" } } },
        d1: { type: "number" },
      },
    };
    expect(normalizeContractRepresentation(document("Alpha", "Beta")))
      .toEqual(canonical);
    expect(normalizeContractRepresentation(document("Renamed", "Other")))
      .toEqual(canonical);
    // A reference that names nothing in the map is left exactly as it is.
    expect(normalizeContractRepresentation({
      schema: { $ref: "https://example.test/other#/$defs/Alpha" },
      definitions: { Alpha: { type: "string" } },
    })).toEqual({
      schema: { $ref: "https://example.test/other#/$defs/Alpha" },
      definitions: { d0: { type: "string" } },
    });
  });

  test("rejects a revision that is not a positive integer", () => {
    expect(requireOperationRevision(undefined, "issue.close")).toBe(1);
    expect(requireOperationRevision(7, "issue.close")).toBe(7);
    for (const bad of [0, -1, 1.5, "2", null, Number.NaN]) {
      expect(() => requireOperationRevision(bad, "issue.close")).toThrow(
        /revision must be a positive integer/,
      );
    }
  });

  test("hashes to a full canonical SHA-256 that changes with every covered field", async () => {
    const base = await Effect.runPromise(hashOperationVersion(descriptorFixture()));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const rotations = await Promise.all([
      descriptorFixture({ catalog: CatalogId.make("other") }),
      descriptorFixture({ owner: { kind: "trait", name: "issue" } }),
      descriptorFixture({ owner: { kind: "entity", name: "task" } }),
      descriptorFixture({ localName: "reopen" }),
      descriptorFixture({ target: "none" }),
      descriptorFixture({ revision: 2 }),
      descriptorFixture({
        input: { representation: { type: "string" }, shape: { _tag: "opaque" } },
      }),
      descriptorFixture({
        output: {
          representation: { type: "object" },
          shape: { _tag: "scalar", valueType: "string" },
        },
      }),
      descriptorFixture({ composers: ["note"] }),
      descriptorFixture({ writes: ["audit"] }),
    ].map((descriptor) => Effect.runPromise(hashOperationVersion(descriptor))));
    expect(new Set(rotations).size).toBe(rotations.length);
    for (const rotated of rotations) expect(rotated).not.toBe(base);
  });
});

describe("deployed operation versions", () => {
  test("survive a redeploy that rotates every deployment-bound hash", async () => {
    const first = await Effect.runPromise(
      lowerOwnedOperations(catalog, baseCatalog(), deployment),
    );
    const redeployed = await Effect.runPromise(
      lowerOwnedOperations(catalog, baseCatalog(), redeployment),
    );
    expect(redeployed.descriptors.map((entry) => entry.version)).toEqual(
      first.descriptors.map((entry) => entry.version),
    );
    // The deployment fences did rotate — that is what makes this meaningful.
    expect(redeployed.descriptors.map((entry) => entry.bodyHash)).not.toEqual(
      first.descriptors.map((entry) => entry.bodyHash),
    );
    expect(redeployed.descriptors.map((entry) => entry.inputSchemaHash))
      .not.toEqual(first.descriptors.map((entry) => entry.inputSchemaHash));
    for (const descriptor of first.descriptors) {
      expect(descriptor.version).toMatch(/^[0-9a-f]{64}$/);
      expect(descriptor.revision).toBe(1);
    }
    expect(new Set(first.descriptors.map((entry) => entry.version)).size)
      .toBe(first.descriptors.length);
  });

  test("ignore documentation and unrelated definitions in the same catalog", async () => {
    const base = await versions(baseCatalog);
    const documented = await versions(documentedCatalog);
    const annotated = await versions(annotatedSchemaCatalog);
    const unrelated = await versions(unrelatedCatalog);
    expect(documented).toEqual(base);
    // Schema `title`/`description` annotations are documentation too.
    expect(annotated).toEqual(base);
    // And an `identifier` rename is a wire alias, not a contract change.
    expect(await versions(aliasedSchemaCatalog("Shared"))).toEqual(
      await versions(aliasedSchemaCatalog("SharedRenamed")),
    );
    expect(unrelated["issue.close"]).toBe(base["issue.close"]!);
    expect(unrelated["taggable.addTag"]).toBe(base["taggable.addTag"]!);
  });

  test("rotate only the operation whose own contract, behavior, or revision moved", async () => {
    const base = await versions(baseCatalog);
    const variants: Record<string, () => AnySchema> = {
      revision: revisedCatalog,
      input: changedInputCatalog,
      output: changedOutputCatalog,
      target: targetlessCatalog,
      writes: writingCatalog,
    };
    for (const [label, build] of Object.entries(variants)) {
      const changed = await versions(build);
      expect(`${label}:${changed["issue.close"]}`).not.toBe(
        `${label}:${base["issue.close"]}`,
      );
      // The unrelated trait operation in the same catalog stays compatible.
      expect(changed["taggable.addTag"]).toBe(base["taggable.addTag"]!);
    }
  });

  test("rotate a targeted trait operation when its admissible composers change", async () => {
    const base = await versions(baseCatalog);
    const composed = await versions(extraComposerCatalog);
    expect(composed["taggable.addTag"]).not.toBe(base["taggable.addTag"]);
    expect(composed["issue.close"]).toBe(base["issue.close"]!);
  });
});
