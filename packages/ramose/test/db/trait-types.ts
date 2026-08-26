/**
 * Compile-time pin: trait field flattening, create-shape required keys,
 * and flattened-name collisions (issue #316).
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

// @effect-diagnostics floatingEffect:off
// Bare calls below are the fixtures: their *types* are under test (often
// paired with `@ts-expect-error`), so they are deliberately neither yielded
// nor assigned. This file is compiled by `bun run typecheck`, never run.

import type {
  CatalogIdent,
  Eid,
  Equal,
  Expect,
  Tx,
} from "../../src/db/internal.ts";
import {
  Entity,
  Field,
  Schema,
  Trait,
  string,
} from "../../src/db/internal.ts";

const Taggable = Trait("taggable", {
  tag: string(),
});

const Soft = Trait("soft", {
  note: string({ optional: true }),
  tags: Field.many(string()),
});

const Issue = Entity(
  "issue",
  { title: string() },
  { traits: [Taggable] },
);

const Note = Entity(
  "note",
  { title: string() },
  { traits: [Soft] },
);

const Board = Schema({ issue: Issue, note: Note });

export type _tagIdent = Expect<
  Equal<(typeof Issue)["tag"]["ident"], ":taggable/tag">
>;
export type _sameField = Expect<
  Equal<(typeof Issue)["tag"], (typeof Taggable)["tag"]>
>;
export type _titleIdent = Expect<
  Equal<(typeof Issue)["title"]["ident"], ":issue/title">
>;

export type _boardIdents = Expect<
  Equal<
    CatalogIdent<typeof Board>,
    | ":issue/title"
    | ":taggable/tag"
    | ":note/title"
    | ":soft/note"
    | ":soft/tags"
  >
>;

declare const tx: Tx<typeof Board>;
declare const issue: Eid<typeof Issue>;
tx.put(Issue, { title: "Fix login", tag: "urgent" });
tx.put(Note, { title: "n" });
tx.put(Note, { title: "n", note: "aside", tags: ["a"] });
tx.set(issue, Issue.tag, "urgent");
tx.set(issue, ":taggable/tag", "urgent");
// @ts-expect-error reconstructed composer ident is not a catalog ident
tx.set(issue, ":issue/tag", "urgent");

{
  // @ts-expect-error create form requires the required trait field
  tx.put(Issue, { title: "Fix login" });
  // @ts-expect-error tag is string, not number
  tx.put(Issue, { title: "Fix login", tag: 1 });
}

const Timestamped = Trait("timestamped", { createdAt: string() });
const Annotated = Trait(
  "annotated",
  {},
  { traits: [Taggable, Timestamped] },
);
const Diamond = Entity(
  "diamond",
  { title: string() },
  { traits: [Taggable, Annotated] },
);
export type _diamondTag = Expect<
  Equal<(typeof Diamond)["tag"], (typeof Taggable)["tag"]>
>;
export type _diamondCreated = Expect<
  Equal<(typeof Diamond)["createdAt"]["ident"], ":timestamped/createdAt">
>;

const OtherTag = Trait("labeled", { tag: string() });
// @ts-expect-error conflicting flattened field names
Entity("clash", { title: string() }, { traits: [Taggable, OtherTag] });

// @ts-expect-error reserved field name — id, ns, fields, _tag, and traits are Entity / Trait metadata
Trait("post", { traits: string() });
