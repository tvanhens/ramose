// @effect-diagnostics floatingEffect:off

import type {
  CatalogIdent,
  Eid,
  Equal,
  Expect,
  RefWriteTarget,
  Tx,
} from "../../src/db/internal.ts";
import {
  Entity,
  Field,
  Ref,
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

const Board = Schema("trait-types-board", { issue: Issue, note: Note });

const Link = Entity("link", { target: Ref(Taggable) });
const Plain = Entity("plain", { title: string() });
const TraitRefs = Schema("trait-types-refs", {
  issue: Issue,
  note: Note,
  link: Link,
  plain: Plain,
});
export type _traitRefTarget = Expect<
  Equal<RefWriteTarget<typeof TraitRefs, ":link/target">, typeof Issue>
>;
declare const traitRefTx: Tx<typeof TraitRefs>;
declare const plain: Eid<typeof Plain>;
traitRefTx.put(Link, { target: issue });
// @ts-expect-error
traitRefTx.put(Link, { target: plain });

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
// @ts-expect-error
tx.set(issue, ":issue/tag", "urgent");

{
  // @ts-expect-error
  tx.put(Issue, { title: "Fix login" });
  // @ts-expect-error
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
const TransitiveLink = Entity("transitiveLink", { target: Ref(Taggable) });
const TransitiveRefs = Schema("trait-types-transitive", {
  issue: Issue,
  diamond: Diamond,
  transitiveLink: TransitiveLink,
});
export type _transitiveTraitRefTarget = Expect<
  Equal<
    RefWriteTarget<typeof TransitiveRefs, ":transitiveLink/target">,
    typeof Issue | typeof Diamond
  >
>;

const OtherTag = Trait("labeled", { tag: string() });
// @ts-expect-error
Entity("clash", { title: string() }, { traits: [Taggable, OtherTag] });

// @ts-expect-error
Trait("post", { traits: string() });
const DocFieldTrait = Trait("postDoc", { doc: string() }, { doc: "Trait docs." });
DocFieldTrait.doc.ident;
