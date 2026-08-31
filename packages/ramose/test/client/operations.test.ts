import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as EffectSchema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  Entity,
  Field,
  Schema,
  Trait,
  string,
} from "../../src/db/internal.ts";
import { compositionFromSchema } from "../../src/db/composition.ts";
import { EntityId } from "../../src/db/Operation.ts";
import { inputEntityRefHandles } from "../../src/internal/authorization/entity-targets.ts";
import { lowerOwnedOperations } from "../../src/internal/authorization/authoring/index.ts";
import {
  CatalogId,
  DigestHex,
} from "../../src/internal/authorization/identities.ts";
import { completeSchema } from "../../src/internal/authorization/read-tables.ts";
import {
  encodedInputRefs,
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

const Board = Entity("board", { name: string() }, {
  operations: (Operation) => ({
    createCard: Operation({
      self: false,
      input: EffectSchema.Struct({
        title: EffectSchema.String,
        rank: EffectSchema.Finite,
        author: EntityId,
        watchers: EffectSchema.Array(EntityId),
        parent: EffectSchema.optionalKey(EntityId),
        origin: EffectSchema.Struct({ board: EntityId }),
      }),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});

const Relocated = Entity("relocated", { name: string() }, {
  operations: (Operation) => ({
    createRelocated: Operation({
      self: false,
      input: EffectSchema.Struct({
        title: EffectSchema.String,
        author: EntityId,
      }).pipe(EffectSchema.encodeKeys({ author: "wireAuthor" })),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});

type BuriedWire = {
  readonly title: string;
  readonly holder: { readonly author: number };
};

type BuriedValue = {
  readonly title: string;
  readonly author: number;
};

const Buried = Entity("buried", { name: string() }, {
  operations: (Operation) => ({
    createBuried: Operation({
      self: false,
      input: EffectSchema.Struct({
        title: EffectSchema.String,
        holder: EffectSchema.Struct({ author: EntityId }),
      }).pipe(
        EffectSchema.decodeTo(
          EffectSchema.Struct({
            title: EffectSchema.String,
            author: EntityId,
          }),
          {
            decode: SchemaGetter.transform((value: BuriedWire): BuriedValue => ({
              title: value.title,
              author: value.holder.author,
            })),
            encode: SchemaGetter.transform((value: BuriedValue): BuriedWire => ({
              title: value.title,
              holder: { author: value.author },
            })),
          },
        ),
      ),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});

type SwappedWire = {
  readonly slot: number;
  readonly rank: number;
};

type SwappedValue = {
  readonly author: number;
  readonly rank: number;
};

const Swapped = Entity("swapped", { name: string() }, {
  operations: (Operation) => ({
    createSwapped: Operation({
      self: false,
      input: EffectSchema.Struct({
        slot: EntityId,
        rank: EffectSchema.Finite,
      }).pipe(
        EffectSchema.decodeTo(
          EffectSchema.Struct({
            author: EntityId,
            rank: EffectSchema.Finite,
          }),
          {
            decode: SchemaGetter.transform((value: SwappedWire): SwappedValue => ({
              author: value.slot,
              rank: value.rank,
            })),
            encode: SchemaGetter.transform((value: SwappedValue): SwappedWire => ({
              slot: value.rank,
              rank: value.author,
            })),
          },
        ),
      ),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});

const SwappingSchema = Schema("swapping", { swapped: Swapped });
SwappingSchema.applyPolicy(() => {});

const BuryingSchema = Schema("burying", { buried: Buried });
BuryingSchema.applyPolicy(() => {});

const RelocatingSchema = Schema("relocating", { relocated: Relocated });
RelocatingSchema.applyPolicy(() => {});

const BoardSchema = Schema("boards", { board: Board });
BoardSchema.applyPolicy(() => {});

const AppSchema = Schema("app", { issue: Issue, note: Note });
AppSchema.applyPolicy(() => {});

const installed = () =>
  installClientOperations(AppSchema, completeSchema(AppSchema));

const createCard = () =>
  installClientOperations(BoardSchema, completeSchema(BoardSchema))
    .database.get("createCard")!;

describe("the installed client mutation surface", () => {
  test("pins the version the deployment lowered, from the authored catalog alone", async () => {
    const operations = installed();
    const deployed = await Effect.runPromise(lowerOwnedOperations(
      CatalogId.make("app"),
      [completeSchema(AppSchema)],
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
        compositionFromSchema(completeSchema(AppSchema)),
        { kind: "entity", name: "issue" },
      ).get("close")!.version(),
    ).toBe(byName.get("issue.close")!);
  });

  test("separates targetless from targeted, and reaches trait operations through composition", async () => {
    const operations = installed();
    const composition = compositionFromSchema(completeSchema(AppSchema));

    expect([...operations.database.keys()]).toEqual(["createIssue"]);
    expect(operations.database.get("createIssue")?.self).toBe(false);

    const issue = selfOperationsFor(operations, composition, {
      kind: "entity",
      name: "issue",
    });
    expect([...issue.keys()].sort()).toEqual(["addTag", "close"]);
    expect(issue.get("addTag")?.owner).toEqual({ kind: "trait", name: "taggable" });
    expect(issue.get("close")?.self).toBe(true);

    expect([...selfOperationsFor(operations, composition, {
      kind: "entity",
      name: "note",
    }).keys()]).toEqual([]);

    expect([...selfOperationsFor(operations, composition, {
      kind: "trait",
      name: "taggable",
    }).keys()]).toEqual(["addTag"]);
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

  test("encodes an opaque handle at every declared reference position", () => {
    const create = createCard();
    const author = "e".repeat(55);
    const watcher = "f".repeat(55);
    const parent = "cr1_parent";
    const board = "cr1_board";

    expect(
      create.encode({
        title: "Offline",
        rank: 3,
        author,
        watchers: [watcher],
        parent,
        origin: { board },
      }),
    ).toEqual({
      title: "Offline",
      rank: 3,
      author,
      watchers: [watcher],
      parent,
      origin: { board },
    });

    expect(inputEntityRefHandles(
      create.input,
      create.encode({
        title: "Offline",
        rank: 3,
        author,
        watchers: [watcher],
        origin: { board },
      }),
    )).toEqual([["author"], ["origin", "board"], ["watchers", 0]]);
  });

  test("encodes a reference at the wire key a renaming codec gives it", () => {
    const relocating = installClientOperations(
      RelocatingSchema,
      completeSchema(RelocatingSchema),
    ).database.get("createRelocated")!;
    const author = "e".repeat(55);
    const encoded = relocating.encode({ author, title: "Offline" });
    expect(encoded).toEqual({ wireAuthor: author, title: "Offline" });
    expect(JSON.stringify(encoded)).not.toContain(String(Number.MIN_SAFE_INTEGER));
  });

  test("declares the outbox's reference positions where the wire carries them", () => {
    const relocating = installClientOperations(
      RelocatingSchema,
      completeSchema(RelocatingSchema),
    ).database.get("createRelocated")!;
    const author = "e".repeat(55);
    const encoded = relocating.encode({ author, title: "Offline" });

    expect(encodedInputRefs(relocating, encoded)).toEqual([
      { path: ["wireAuthor"], ref: author as never },
    ]);
    expect(inputEntityRefHandles(relocating.input, encoded)).toEqual([]);

    const create = createCard();
    const board = "cr1_board";
    const watcher = "f".repeat(55);
    expect(encodedInputRefs(
      create,
      create.encode({
        title: "Offline",
        rank: 3,
        author,
        watchers: [watcher],
        origin: { board },
      }),
    )).toEqual([
      { path: ["author"], ref: author as never },
      { path: ["origin", "board"], ref: board as never },
      { path: ["watchers", 0], ref: watcher as never },
    ]);
  });

  test("refuses a codec that leaves an ordinary scalar where the reference belongs", () => {
    const swapping = installClientOperations(
      SwappingSchema,
      completeSchema(SwappingSchema),
    ).database.get("createSwapped")!;
    for (const rank of [-1, Number.MIN_SAFE_INTEGER]) {
      expect(() => swapping.encode({ author: "e".repeat(55), rank })).toThrow(
        /moved the entity reference/,
      );
    }
  });

  test("refuses to encode a reference the codec does not carry to the wire", () => {
    const burying = installClientOperations(
      BuryingSchema,
      completeSchema(BuryingSchema),
    ).database.get("createBuried")!;
    expect(() =>
      burying.encode({ author: "e".repeat(55), title: "Offline" })
    ).toThrow(/moved the entity reference/);
  });

  test("still refuses an input the declared schema rejects", () => {
    const create = createCard();
    expect(() =>
      create.encode({
        title: "Offline",
        rank: "three",
        author: "e".repeat(55),
        watchers: [],
        origin: { board: "cr1_board" },
      })
    ).toThrow();
    expect(() =>
      create.encode({
        rank: 3,
        author: "e".repeat(55),
        watchers: [],
        origin: { board: "cr1_board" },
      })
    ).toThrow();
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
