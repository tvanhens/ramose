/**
 * Compile-time fixtures for `Query.from`. `bun run typecheck` compiles this file.
 *
 * Pins the fluent app spelling: header example (row is
 * `{ id: Eid<Comment>, text: string, at: Date, issue: { id: Eid<Issue> } }`),
 * object-literal `where` with inline values, leftover `params({ issueId })`
 * bindings, and foreign-set tokens.
 */

import type {
  Db,
  Eid,
  EntityRow,
  Equal,
  Expect,
  Param,
  Row,
} from "../../src/db/internal.ts";
import { Entity, Field, Instant, Long, Query, Ref, params, stored } from "../../src/db/internal.ts";
import * as Schema from "effect/Schema";

import { Movies, User } from "./fixture.ts";

const Issue = Entity("issue", {
  title: Field(Schema.String),
  done: Field(Schema.Boolean),
  rank: Field(Long),
});

const Comment = Entity("comment", {
  text: Field(Schema.String),
  at: Field(Instant),
  issue: Ref(Issue),
});

declare const db: Db<typeof Movies>;

// ── Decision 4: Issue.id produces branded Eid — no recased idOf ────────────

const p = params({ issueId: Issue.id });
type IssueIdValue = (typeof p)["issueId"] extends Param<infer T, any, any> ? T : never;
type _issueIdIsEid = Expect<Equal<IssueIdValue, Eid<typeof Issue>>>;

// ── header example (inline values — documented spelling) ───────────────────

declare const issueId: Eid<typeof Issue>;
const commentsInline = Query.from(Comment)
  .where({ issue: issueId })
  .orderBy(Comment.at, "asc");
const _inlineRun = db.query(commentsInline);
type _inlineOk = Expect<
  Equal<typeof _inlineRun, Promise<readonly EntityRow<typeof Comment>[]>>
>;

// leftover params path — still accepted
const commentsQuery = Query.from(Comment)
  .where({ issue: p.issueId })
  .orderBy(Comment.at, "asc");

type HeaderRow = Row<typeof commentsQuery>;
type _headerEntity = Expect<Equal<HeaderRow, EntityRow<typeof Comment>>>;
type _headerId = Expect<Equal<HeaderRow["id"], Eid<typeof Comment>>>;
type _headerText = Expect<Equal<HeaderRow["text"], string>>;
type _headerAt = Expect<Equal<HeaderRow["at"], Date>>;
type _headerIssue = Expect<
  Equal<HeaderRow["issue"], { readonly id: Eid<typeof Issue> }>
>;

const commentShape = {
  id: Comment.id,
  text: Comment.text,
} as const;
const commentTitles = Query.from(Comment)
  .where({ issue: p.issueId })
  .select(commentShape)
  .orderBy(Comment.at, "asc");
type _selectRow = Expect<
  Equal<Row<typeof commentTitles>, { readonly id: Eid<typeof Comment>; readonly text: string }>
>;

const _bound = db.query(commentsQuery, { issueId: 1 as Eid<typeof Issue> });
type _boundOk = Expect<Equal<typeof _bound, Promise<readonly EntityRow<typeof Comment>[]>>>;

// @ts-expect-error a declared head must be bound at the terminal
db.query(commentsQuery);

// @ts-expect-error issueId is an Eid, not a string
db.query(commentsQuery, { issueId: "nope" });

// ── object-literal where is typechecked ────────────────────────────────────

Query.from(Comment).where({ text: "ok" });
Query.from(Comment).where({ issue: p.issueId, text: "ok" });

// @ts-expect-error unknown field is not a where key
Query.from(Comment).where({ nope: true });

// @ts-expect-error text is a string, not a number
Query.from(Comment).where({ text: 42 });

// ── foreign-set token is a type error ──────────────────────────────────────

const other = params({ title: Issue.title });
Query.from(Comment).where({ issue: p.issueId });
// @ts-expect-error token from a different params() set
Query.from(Comment).where({ issue: p.issueId }).where({ text: other.title });

// unused keys of the same set still type the whole record
const wide = params({ issueId: Issue.id, extra: User.name });
const partial = Query.from(Comment).where({ issue: wide.issueId });
// @ts-expect-error the set still requires `extra`
db.query(partial, { issueId: 1 as Eid<typeof Issue> });
db.query(partial, { issueId: 1 as Eid<typeof Issue>, extra: "Ada" });

// ── .ids() is today's { id } row ───────────────────────────────────────────

const onlyIds = Query.from(Comment).ids();
type _ids = Expect<Equal<Row<typeof onlyIds>, { readonly id: number }>>;

const idsThenSelect = Query.from(Comment).ids().select({ text: Comment.text });
type _idsThenSelect = Expect<Equal<Row<typeof idsThenSelect>, { readonly text: string }>>;
const selectThenIds = Query.from(Comment).select({ text: Comment.text }).ids();
type _selectThenIds = Expect<Equal<Row<typeof selectThenIds>, { readonly id: number }>>;

// ── optional fields only are `| undefined` ─────────────────────────────────

const Note = Entity("note", {
  body: Field(Schema.String),
  subtitle: Field(stored(Schema.optional(Schema.String), "string")),
  author: Ref(User),
});
type NoteRow = EntityRow<typeof Note>;
type _noteBody = Expect<Equal<NoteRow["body"], string>>;
type _noteSub = Expect<Equal<NoteRow["subtitle"], string | undefined>>;
type _noteAuthor = Expect<Equal<NoteRow["author"], { readonly id: Eid<typeof User> }>>;

// ── .orderBy keys are typechecked like .where ──────────────────────────────

Query.from(Comment).orderBy(Comment.at, "asc");
Query.from(Comment).orderBy("at", "asc");
// @ts-expect-error unknown field is not an orderBy key
Query.from(Comment).orderBy("nope", "asc");
Query.from(Comment).select(commentShape).orderBy("text", "asc");
// @ts-expect-error a column that was not selected is not an orderBy string key
Query.from(Comment).select(commentShape).orderBy("at", "asc");
