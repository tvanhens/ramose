import type {
  ClientRef,
  Eid,
  EntityId,
  EntityRow,
  Equal,
  Expect,
  Row,
} from "../../src/db/internal.ts";
import { Entity, Field, Instant, Long, Q, Query, Ref, Trait, stored, string } from "../../src/db/internal.ts";
import type { Var } from "../../src/db/query/kernel.ts";
import * as Schema from "effect/Schema";
import { pipe } from "effect/Function";

import { User } from "./fixture.ts";

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

const Taggable = Trait("taggable", {
  tags: Field.many(string()),
});
const TaggedIssue = Entity("taggedIssue", { title: string() }, { traits: [Taggable] });
const TagLink = Entity("tagLink", { target: Ref(Taggable) });

const urgent = Query.from(Taggable)
  .where(Query.is(Taggable.tags, "urgent"))
  .select({ id: Taggable.id, tags: Taggable.tags });
export type _traitRoot = Expect<
  Equal<
    Row<typeof urgent>,
    { readonly id: Eid<typeof Taggable>; readonly tags: readonly string[] }
  >
>;
export type _traitRef = Expect<
  Equal<EntityRow<typeof TagLink>["target"], { readonly id: Eid<typeof Taggable> }>
>;
declare const taggedIssueId: Eid<typeof TaggedIssue>;
Query.from(TagLink).where({ target: taggedIssueId });

declare const issueId: Eid<typeof Issue>;
const commentsQuery = Query.from(Comment)
  .where({ issue: issueId })
  .orderBy(Comment.at, "asc");
type HeaderRow = Row<typeof commentsQuery>;
export type _headerEntity = Expect<Equal<HeaderRow, EntityRow<typeof Comment>>>;
export type _headerId = Expect<Equal<HeaderRow["id"], Eid<typeof Comment>>>;
export type _headerText = Expect<Equal<HeaderRow["text"], string>>;
export type _headerAt = Expect<Equal<HeaderRow["at"], Date>>;
export type _headerIssue = Expect<
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
export type _selectRow = Expect<
  Equal<Row<typeof commentTitles>, { readonly id: Eid<typeof Comment>; readonly text: string }>
>;

Query.from(Comment).where({ text: "ok" });
Query.from(Comment).where({ issue: issueId, text: "ok" });

declare const issueHandle: EntityId<typeof Issue>;
declare const issueRef: ClientRef<typeof Issue>;
declare const userHandle: EntityId<typeof User>;
declare const commentHandle: EntityId<typeof Comment>;

Query.from(Comment).where({ issue: issueHandle });
Query.from(Comment).where({ issue: issueRef });
Query.from(Comment).where({ issue: { id: issueHandle } });
Query.from(Comment).where({ issue: issueHandle, text: "ok" });
Query.from(Comment).where({ id: commentHandle });
Query.from(Comment).where(Query.is(Comment.issue, issueHandle));
Query.from(Comment).where(Query.byId(commentHandle));
Query.from(TagLink).where({ target: taggedIssueId });

// @ts-expect-error
Query.from(Comment).where({ issue: userHandle });

// @ts-expect-error
Query.from(Comment).where({ issue: issueId.toString() });

// @ts-expect-error
Query.from(Comment).where({ id: userHandle });

// @ts-expect-error
Query.from(Comment).where(Query.is(Comment.issue, userHandle));

// @ts-expect-error
Query.from(Comment).where(Query.byId(userHandle));

Query.from(Comment).where(Query.is(Comment.id, commentHandle));

// @ts-expect-error
Query.from(Comment).where(Query.is(Comment.id, userHandle));

Query.from(Comment).where(Query.byId(1));

declare const taggedIssueHandle: EntityId<typeof TaggedIssue>;
Query.from(TaggedIssue).where(Query.byId(taggedIssueHandle));
Query.from(Taggable).where(Query.byId(taggedIssueHandle));

// @ts-expect-error
Query.from(Comment).where({ nope: true });

// @ts-expect-error
Query.from(Comment).where({ text: 42 });

const onlyIds = Query.from(Comment).ids();
export type _ids = Expect<Equal<Row<typeof onlyIds>, { readonly id: Eid<typeof Comment> }>>;

const pipeIds = Query.q(() => pipe(Query.entities(Comment), Query.ids()));
export type _pipeIds = Expect<
  Equal<Row<typeof pipeIds>, { readonly id: Eid<typeof Comment> }>
>;
const pipeFollow = Query.q(() =>
  pipe(Query.entities(Comment), Query.follow(Comment.issue)),
);
export type _pipeFollow = Expect<
  Equal<Row<typeof pipeFollow>, { readonly id: Eid<typeof Issue> }>
>;

const idsThenSelect = Query.from(Comment).ids().select({ text: Comment.text });
export type _idsThenSelect = Expect<Equal<Row<typeof idsThenSelect>, { readonly text: string }>>;
const selectThenIds = Query.from(Comment).select({ text: Comment.text }).ids();
export type _selectThenIds = Expect<Equal<Row<typeof selectThenIds>, { readonly id: Eid<typeof Comment> }>>;

const Note = Entity("note", {
  body: Field(Schema.String),
  subtitle: Field(stored(Schema.optional(Schema.String), "string")),
  nickname: string({ optional: true }),
  author: Ref(User),
});
type NoteRow = EntityRow<typeof Note>;
export type _noteBody = Expect<Equal<NoteRow["body"], string>>;
export type _noteSub = Expect<Equal<NoteRow["subtitle"], string | undefined>>;
export type _noteNick = Expect<Equal<NoteRow["nickname"], string | undefined>>;
export type _noteAuthor = Expect<Equal<NoteRow["author"], { readonly id: Eid<typeof User> }>>;

Query.from(Comment).orderBy(Comment.at, "asc");
Query.from(Comment).orderBy("at", "asc");
// @ts-expect-error
Query.from(Comment).orderBy("nope", "asc");
Query.from(Comment).select(commentShape).orderBy("text", "asc");
// @ts-expect-error
Query.from(Comment).select(commentShape).orderBy("at", "asc");

Query.from(Issue).where(Query.is(Issue.title, "Ship"));
Query.from(Issue).select({ title: Issue.title });
Query.from(Issue).orderBy(Issue.title);
Query.from(Issue).orderBy("title", "asc");

// @ts-expect-error
Query.from(Issue).where(Query.is(User.name, "Ada"));

// @ts-expect-error
Query.from(User).select({ title: Issue.title });

// @ts-expect-error
Query.from(Issue).orderBy(User.name);

pipe(Query.entities(Issue), Query.is(Issue.title, "Ship"), Query.select({ title: Issue.title }));
pipe(Query.entities(User), Query.select({ name: User.name }));
pipe(Query.entities(Issue), Query.orderBy(Issue.title));
pipe(Query.entities(Issue), Query.select({ title: Issue.title }), Query.orderBy("title"));

// @ts-expect-error
pipe(Query.entities(Issue), Query.is(User.name, "Ada"), Query.select({ title: Issue.title }));

// @ts-expect-error
pipe(Query.entities(User), Query.select({ title: Issue.title }));

// @ts-expect-error
pipe(Query.entities(Issue), Query.orderBy(User.name));

// @ts-expect-error
pipe(Query.entities(Issue), Query.orderBy("title"));

const afterFollow = Query.q(() =>
  pipe(Query.entities(Comment), Query.follow(Comment.issue)),
);
export type _followNs = Expect<
  Equal<Row<typeof afterFollow>, { readonly id: Eid<typeof Issue> }>
>;
pipe(Query.entities(Comment), Query.follow(Comment.issue), Query.select({ title: Issue.title }));
// @ts-expect-error
pipe(Query.entities(Comment), Query.follow(Comment.issue), Query.select({ text: Comment.text }));

// @ts-expect-error
pipe(Query.entities(Issue), Query.backlink(User.friends));

const topByDone = Query.q(function* () {
  const issue = yield* Query.entities(Issue);
  const done = yield* Q.fact(issue, Issue.done);
  return { done: done.v, n: Q.count(issue) };
})
  .orderBy((r) => r.n, "desc")
  .limit(10);
export type _topByDone = Expect<
  Equal<Row<typeof topByDone>, { readonly done: boolean; readonly n: number }>
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
export type _distinctRow = Expect<
  Equal<Row<typeof uniqueTitles>, { readonly title: string }>
>;
export type _openRow = Expect<Equal<Row<typeof openCount>, number>>;

const fluentAgg = Query.from(Issue).select(
  { title: Issue.title },
  { n: Q.count(Q.focus) },
);
type _fluentAggRow = Row<typeof fluentAgg>;
export type _fluentAggTitle = Expect<Equal<_fluentAggRow["title"], string>>;
export type _fluentAggN = Expect<Equal<_fluentAggRow["n"], number>>;
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
const taken = Query.from(Issue).select({ title: Issue.title }).one();
void paged.logic();
void taken.logic();
void openCount.logic();

declare const issueVar: Var<Eid<typeof Issue>>;
Q.pull(issueVar, { title: Issue.title });
Q.fact(issueVar, Issue.title);
// @ts-expect-error
Q.pull(issueVar, { name: User.name });
// @ts-expect-error
Q.fact(issueVar, User.name);

Query.from(Issue).where(Query.any(Query.gt(Issue.rank, 3), Query.startsWith(Issue.title, "ship")));
Query.from(Issue).where(Query.not(Query.any(Query.includes(Issue.title, "flake"))));
Query.from(Issue).where(Query.gte(Issue.rank, 1), Query.lt(Issue.rank, 10));
Query.from(Issue).where(Query.lte(Issue.rank, 3));
Query.from(Comment).where(Query.startsWith(Comment.text, "on", { ignoreCase: true }));

// @ts-expect-error
Query.from(Issue).where(Query.any(Query.is(User.name, "Ada")));

// @ts-expect-error
Query.from(Issue).where(Query.gt(User.age, 3));

// @ts-expect-error
Query.from(Issue).where(Query.not(Query.is(User.name, "Ada")));

// @ts-expect-error
Query.startsWith(Issue.rank, "x");

// @ts-expect-error
Query.includes(Issue.rank, "x");

declare const pagedCursor: import("../../src/db/query/query.ts").Cursor;
const pagedComments = Query.from(Comment).orderBy(Comment.at, "asc").limit(2);
const _encoded: string = Query.encodeCursor(pagedComments, pagedCursor);
const _decoded = Query.decodeCursor(pagedComments, _encoded);
export type _cursorRound = Expect<
  Equal<typeof _decoded, import("../../src/db/query/query.ts").Cursor>
>;
