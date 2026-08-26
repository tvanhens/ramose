/**
 * Compile-time pin: trait field flattening, create-shape required keys,
 * and flattened-name collisions (issue #316).
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

import { pipe } from "effect/Function";
import type {
  AllRow,
  CatalogIdent,
  Db,
  Eid,
  EntityRef,
  EntityRow,
  Equal,
  Expect,
  Extends,
  Row,
  SchemaEid,
  Tx,
} from "../../src/db/internal.ts";
import {
  Entity,
  Field,
  Query,
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

const Board = Schema({ issue: Issue, note: Note });

type _tagIdent = Expect<
  Equal<(typeof Issue)["tag"]["ident"], ":taggable/tag">
>;
type _sameField = Expect<
  Equal<(typeof Issue)["tag"], (typeof Taggable)["tag"]>
>;
type _titleIdent = Expect<
  Equal<(typeof Issue)["title"]["ident"], ":issue/title">
>;

type _boardIdents = Expect<
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
type _diamondTag = Expect<
  Equal<(typeof Diamond)["tag"], (typeof Taggable)["tag"]>
>;
type _diamondCreated = Expect<
  Equal<(typeof Diamond)["createdAt"]["ident"], ":timestamped/createdAt">
>;

const OtherTag = Trait("labeled", { tag: string() });
// @ts-expect-error conflicting flattened field names
Entity("clash", { title: string() }, { traits: [Taggable, OtherTag] });

// @ts-expect-error reserved field name — id, ns, fields, _tag, and traits are Entity / Trait metadata
Trait("post", { traits: string() });

const Todo = Entity("todo", { title: string() });
const Doc = Entity("doc", { title: string() }, { traits: [Taggable] });
const Favorite = Entity("favorite", {
  target: Ref(Taggable),
});
const Catalog = Schema({
  issue: Issue,
  note: Note,
  todo: Todo,
  doc: Doc,
  favorite: Favorite,
});

declare const catalogTx: Tx<typeof Catalog>;
declare const issueEid: Eid<typeof Issue>;
declare const docEid: Eid<typeof Doc>;
declare const noteEid: Eid<typeof Note>;
declare const todoEid: Eid<typeof Todo>;
declare const taggableEid: Eid<typeof Taggable>;
catalogTx.put(Favorite, { target: issueEid });
catalogTx.put(Favorite, { target: docEid });
catalogTx.put(Favorite, { target: taggableEid });
// @ts-expect-error a Soft composer is not a Taggable target
catalogTx.put(Favorite, { target: noteEid });
// @ts-expect-error known non-composer is not a trait-ref target
catalogTx.put(Favorite, { target: todoEid });

const taggableListing = Query.from(Taggable);
type TaggableRow = Row<typeof taggableListing>;
type _traitDefault = Expect<Equal<TaggableRow, EntityRow<typeof Taggable>>>;
type _traitId = Expect<Equal<TaggableRow["id"], Eid<typeof Taggable>>>;
type _traitTag = Expect<Equal<TaggableRow["tag"], string>>;
type _noTitle = Expect<
  Equal<"title" extends keyof TaggableRow ? true : false, false>
>;

const urgent = Query.from(Taggable)
  .where(Query.is(Taggable.tag, "urgent"))
  .select({ id: Taggable.id, tag: Taggable.tag });
type _urgent = Expect<
  Equal<Row<typeof urgent>, { readonly id: Eid<typeof Taggable>; readonly tag: string }>
>;

const taggedIssues = Query.from(Issue)
  .where(Query.is(Issue.tag, "urgent"))
  .select({ title: Issue.title, tag: Issue.tag });
type _taggedIssues = Expect<
  Equal<
    Row<typeof taggedIssues>,
    { readonly title: string; readonly tag: string }
  >
>;

const favorites = Query.from(Favorite).select({
  target: Favorite.target.select({
    id: Taggable.id,
    tag: Taggable.tag,
  }),
});
type _favTarget = Expect<
  Equal<
    Row<typeof favorites>["target"],
    { readonly id: Eid<typeof Taggable>; readonly tag: string }
  >
>;

const pipedTaggable = Query.q(() =>
  pipe(Query.entities(Taggable), Query.select({ tag: Taggable.tag })),
);
type _pipedTag = Expect<Equal<Row<typeof pipedTaggable>, { readonly tag: string }>>;
const pipedIds = Query.q(() => pipe(Query.entities(Taggable), Query.ids()));
type _pipedIds = Expect<Equal<Row<typeof pipedIds>, { readonly id: Eid<typeof Taggable> }>>;
pipe(Query.entities(Taggable), Query.orderBy(Taggable.tag));
pipe(Query.entities(Taggable), Query.limit(1));
pipe(Query.entities(Taggable), Query.offset(0));

declare const catalogDb: Db<typeof Catalog>;
const pulledTrait = catalogDb.pull(taggableEid, { tag: Taggable.tag });
type _pullTrait = Expect<
  Equal<Awaited<typeof pulledTrait>, { readonly tag: string } | null>
>;
catalogDb.livePull(taggableEid, { tag: Taggable.tag });
type _traitEidIsSubject = Expect<Extends<Eid<typeof Taggable>, EntityRef<typeof Catalog>>>;
type _traitEidInSchema = Expect<Extends<Eid<typeof Taggable>, SchemaEid<typeof Catalog>>>;

const issueFavorites = Query.from(Issue).where(Query.some(Favorite.target));
type _issueFavs = Expect<Equal<Row<typeof issueFavorites>, EntityRow<typeof Issue>>>;
Query.backlink(Favorite.target)(Query.entities(Issue));
Query.from(Taggable).where(Query.some(Favorite.target));
// @ts-expect-error Todo does not compose Taggable
Query.from(Todo).where(Query.some(Favorite.target));
// @ts-expect-error Note composes Soft, not Taggable
Query.from(Note).where(Query.some(Favorite.target));

const Inner = Trait("inner", { value: string() });
const Outer = Trait("outer", {}, { traits: [Inner] });
type _allOuter = Expect<
  Equal<keyof AllRow<typeof Outer>, ":db/id" | ":inner/value">
>;
type _noOuterValue = Expect<
  Equal<":outer/value" extends keyof AllRow<typeof Outer> ? true : false, false>
>;
