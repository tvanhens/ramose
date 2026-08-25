/**
 * Compile-time fixtures for `Query.from`. `bun run typecheck` compiles this file.
 *
 * Pins the fluent app spelling: header example (row is
 * `{ id: Eid<Comment>, text: string, at: Date, issue: { id: Eid<Issue> } }`),
 * and object-literal `where` with inline values.
 */

import type {
  Db,
  Eid,
  EntityRow,
  Equal,
  Expect,
  Row,
} from "../../src/db/internal.ts";
import { Entity, Field, Instant, Long, Q, Query, Ref, stored, string } from "../../src/db/internal.ts";
import type { Var } from "../../src/db/query/kernel.ts";
import * as Schema from "effect/Schema";
import { pipe } from "effect/Function";

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

// ── header example (inline values) ─────────────────────────────────────────

declare const issueId: Eid<typeof Issue>;
const commentsQuery = Query.from(Comment)
  .where({ issue: issueId })
  .orderBy(Comment.at, "asc");
const _inlineRun = db.query(commentsQuery);
type _inlineOk = Expect<
  Equal<typeof _inlineRun, Promise<readonly EntityRow<typeof Comment>[]>>
>;

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
  .where({ issue: issueId })
  .select(commentShape)
  .orderBy(Comment.at, "asc");
type _selectRow = Expect<
  Equal<Row<typeof commentTitles>, { readonly id: Eid<typeof Comment>; readonly text: string }>
>;

// ── object-literal where is typechecked ────────────────────────────────────

Query.from(Comment).where({ text: "ok" });
Query.from(Comment).where({ issue: issueId, text: "ok" });

// @ts-expect-error unknown field is not a where key
Query.from(Comment).where({ nope: true });

// @ts-expect-error text is a string, not a number
Query.from(Comment).where({ text: 42 });

// ── .ids() is today's { id } row ───────────────────────────────────────────

const onlyIds = Query.from(Comment).ids();
type _ids = Expect<Equal<Row<typeof onlyIds>, { readonly id: Eid<typeof Comment> }>>;

// ── select-less pipe `.ids()` / `follow` keep the focus namespace ───────────

const pipeIds = Query.q(() => pipe(Query.entities(Comment), Query.ids()));
type _pipeIds = Expect<
  Equal<Row<typeof pipeIds>, { readonly id: Eid<typeof Comment> }>
>;
const pipeFollow = Query.q(() =>
  pipe(Query.entities(Comment), Query.follow(Comment.issue)),
);
type _pipeFollow = Expect<
  Equal<Row<typeof pipeFollow>, { readonly id: Eid<typeof Issue> }>
>;

const idsThenSelect = Query.from(Comment).ids().select({ text: Comment.text });
type _idsThenSelect = Expect<Equal<Row<typeof idsThenSelect>, { readonly text: string }>>;
const selectThenIds = Query.from(Comment).select({ text: Comment.text }).ids();
type _selectThenIds = Expect<Equal<Row<typeof selectThenIds>, { readonly id: Eid<typeof Comment> }>>;

// ── optional fields only are `| undefined` ─────────────────────────────────

const Note = Entity("note", {
  body: Field(Schema.String),
  subtitle: Field(stored(Schema.optional(Schema.String), "string")),
  nickname: string({ optional: true }),
  author: Ref(User),
});
type NoteRow = EntityRow<typeof Note>;
type _noteBody = Expect<Equal<NoteRow["body"], string>>;
type _noteSub = Expect<Equal<NoteRow["subtitle"], string | undefined>>;
type _noteNick = Expect<Equal<NoteRow["nickname"], string | undefined>>;
type _noteAuthor = Expect<Equal<NoteRow["author"], { readonly id: Eid<typeof User> }>>;

// ── .orderBy keys are typechecked like .where ──────────────────────────────

Query.from(Comment).orderBy(Comment.at, "asc");
Query.from(Comment).orderBy("at", "asc");
// @ts-expect-error unknown field is not an orderBy key
Query.from(Comment).orderBy("nope", "asc");
Query.from(Comment).select(commentShape).orderBy("text", "asc");
// @ts-expect-error a column that was not selected is not an orderBy string key
Query.from(Comment).select(commentShape).orderBy("at", "asc");

// ── cross-entity stages / shapes / sort keys are type errors (#176) ────────

Query.from(Issue).where(Query.is(Issue.title, "Ship"));
Query.from(Issue).select({ title: Issue.title });
Query.from(Issue).orderBy(Issue.title);
Query.from(Issue).orderBy("title", "asc");

// @ts-expect-error User.name is not a field of Issue
Query.from(Issue).where(Query.is(User.name, "Ada"));

// @ts-expect-error Issue.title is not a field of User
Query.from(User).select({ title: Issue.title });

// @ts-expect-error User.name is not a field of Issue
Query.from(Issue).orderBy(User.name);

pipe(Query.entities(Issue), Query.is(Issue.title, "Ship"), Query.select({ title: Issue.title }));
pipe(Query.entities(User), Query.select({ name: User.name }));
pipe(Query.entities(Issue), Query.orderBy(Issue.title));
pipe(Query.entities(Issue), Query.select({ title: Issue.title }), Query.orderBy("title"));

// @ts-expect-error User.name is not a field of Issue
pipe(Query.entities(Issue), Query.is(User.name, "Ada"), Query.select({ title: Issue.title }));

// @ts-expect-error Issue.title is not a field of User
pipe(Query.entities(User), Query.select({ title: Issue.title }));

// @ts-expect-error User.name is not a field of Issue
pipe(Query.entities(Issue), Query.orderBy(User.name));

// @ts-expect-error "title" is not a key of the select-less id row
pipe(Query.entities(Issue), Query.orderBy("title"));

const afterFollow = Query.q(() =>
  pipe(Query.entities(Comment), Query.follow(Comment.issue)),
);
type _followNs = Expect<
  Equal<Row<typeof afterFollow>, { readonly id: Eid<typeof Issue> }>
>;
pipe(Query.entities(Comment), Query.follow(Comment.issue), Query.select({ title: Issue.title }));
// @ts-expect-error Comment.text is not a field of Issue after follow
pipe(Query.entities(Comment), Query.follow(Comment.issue), Query.select({ text: Comment.text }));

// @ts-expect-error User.friends is a self-ref on User, not a backlink to Issue
pipe(Query.entities(Issue), Query.backlink(User.friends));

// ── #189: Query.q cursor stages, Q.value, fluent aggregate select ───────────

const topByDone = Query.q(function* () {
  const issue = yield* Query.entities(Issue);
  const done = yield* Q.fact(issue, Issue.done);
  return { done: done.v, n: Q.count(issue) };
})
  .orderBy((r) => r.n, "desc")
  .limit(10);
type _topByDone = Expect<
  Equal<Row<typeof topByDone>, { readonly done: boolean; readonly n: number }>
>;
const _topRun = db.query(topByDone);
type _topOut = Expect<
  Equal<typeof _topRun, Promise<readonly { readonly done: boolean; readonly n: number }[]>>
>;

const openCount = Query.q(function* () {
  const issue = yield* Query.entities(Issue);
  yield* Query.is(Issue.done, false)(issue);
  return Q.value(Q.count(issue));
});

const uniqueTitles = Query.q(function* () {
  const issue = yield* Query.entities(Issue);
  const t = yield* Q.fact(issue, Issue.title);
  return Q.distinct({ title: t.v });
});
type _distinctRow = Expect<
  Equal<Row<typeof uniqueTitles>, { readonly title: string }>
>;
const _distinctRun = db.query(uniqueTitles);
type _distinctOut = Expect<
  Equal<typeof _distinctRun, Promise<readonly { readonly title: string }[]>>
>;
const _openRun = db.query(openCount);
type _openVal = Expect<Equal<typeof _openRun, Promise<number>>>;
type _openRow = Expect<Equal<Row<typeof openCount>, number>>;

const fluentAgg = Query.from(Issue).select(
  { title: Issue.title },
  { n: Q.count(Q.focus) },
);
type _fluentAggRow = Row<typeof fluentAgg>;
type _fluentAggTitle = Expect<Equal<_fluentAggRow["title"], string>>;
type _fluentAggN = Expect<Equal<_fluentAggRow["n"], number>>;
Query.from(Issue)
  .select({ title: Issue.title }, { n: Q.count(Q.focus) })
  .orderBy((r) => r.n, "desc")
  .limit(10);
Query.from(Issue)
  .select({ title: Issue.title }, { n: Q.count(Q.focus) })
  .orderBy(Issue.title, "desc");
pipe(
  Query.entities(Issue),
  Query.select({ title: Issue.title }, { n: Q.count(Q.focus) }),
  Query.orderBy("title", "desc"),
);
Query.from(Issue).select({ title: Issue.title }, (e) => ({ n: Q.count(e) }));

const paged = Query.from(Issue)
  .select({ title: Issue.title })
  .orderBy("title")
  .after(null);
const _logicPage = db.query(paged.logic());
type _logicPageOut = Expect<
  Equal<typeof _logicPage, Promise<readonly { readonly title: string }[]>>
>;
const taken = Query.from(Issue).select({ title: Issue.title }).one();
const _logicOne = db.query(taken.logic());
type _logicOneOut = Expect<
  Equal<typeof _logicOne, Promise<readonly { readonly title: string }[]>>
>;
const _logicVal = db.query(openCount.logic());
type _logicValOut = Expect<Equal<typeof _logicVal, Promise<number>>>;

declare const issueVar: Var<Eid<typeof Issue>>;
Q.pull(issueVar, { title: Issue.title });
Q.fact(issueVar, Issue.title);
// @ts-expect-error User.name is not a field of the Issue-branded var
Q.pull(issueVar, { name: User.name });
// @ts-expect-error User.name is not a field of the Issue-branded var
Q.fact(issueVar, User.name);
