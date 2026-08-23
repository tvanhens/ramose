/**
 * Compile-time fixtures for `Query.from`. `bun run typecheck` compiles this file.
 *
 * Pins the #208 ratification: header example, object-literal `where`,
 * hoisted `params({ issueId: Issue.id })`, and foreign-set tokens.
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
import { Entity, Field, Instant, Long, Query, Ref, params } from "../../src/db/internal.ts";
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
type _issueIdParam = Expect<
  Equal<(typeof p)["issueId"], Param<Eid<typeof Issue>, { readonly issueId: Eid<typeof Issue> }, false>>
>;

// ── header example ─────────────────────────────────────────────────────────

const commentsQuery = Query.from(Comment)
  .where({ issue: p.issueId })
  .orderBy(Comment.at, "asc");

type CommentDefaultRow = {
  readonly id: Eid<typeof Comment>;
  readonly text: string | undefined;
  readonly at: Date | undefined;
  readonly issue: { readonly id: number } | undefined;
};
type _headerRow = Expect<Equal<Row<typeof commentsQuery>, CommentDefaultRow>>;
type _headerEntity = Expect<Equal<Row<typeof commentsQuery>, EntityRow<typeof Comment>>>;

const commentShape = {
  id: Comment.id,
  text: Comment.text,
  at: Comment.at,
} as const;
const commentTitles = Query.from(Comment)
  .where({ issue: p.issueId })
  .select(commentShape)
  .orderBy(Comment.at, "asc");
type _selectRow = Expect<
  Equal<
    Row<typeof commentTitles>,
    { readonly id: Eid<typeof Comment>; readonly text: string; readonly at: Date }
  >
>;

const _bound = db.query(commentsQuery, { issueId: 1 as Eid<typeof Issue> });
type _boundOk = Expect<Equal<typeof _bound, Promise<readonly CommentDefaultRow[]>>>;

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
