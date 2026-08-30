import type { Db } from "ramose/db";
import * as Ramose from "ramose/db";
import { Comment, Issue, Label, Reef, User } from "./schema.ts";

const { Query } = Ramose;

export type ReefDb = Db<typeof Reef>;

export const personShape = { id: User.id, name: User.name } as const;
export const labelShape = {
  id: Label.id,
  name: Label.name,
  color: Label.color,
} as const;

// docs:board-shape
export const boardShape = {
  id: Issue.id,
  title: Issue.title,
  status: Issue.status,
  priority: Issue.priority,
  rank: Issue.rank,
  createdAt: Issue.createdAt,
  creator: Issue.creator.select(personShape),
  assignee: Issue.assignee.select(personShape).optional,
  labels: Issue.labels.select(labelShape),
} as const;
// enddocs:board-shape

// docs:issue-extra-shape
export const issueExtraShape = {
  title: Issue.title,
  description: Issue.description.optional,

  privateNote: Issue.privateNote.optional,
} as const;
// enddocs:issue-extra-shape

export const commentShape = {
  id: Comment.id,
  body: Comment.body,
  at: Comment.at,
  author: Comment.author.select(personShape),
} as const;

export const allShapes: readonly unknown[] = [
  boardShape,
  issueExtraShape,
  commentShape,
  personShape,
  labelShape,
];

// docs:board-query
export const boardQuery = Query.from(Issue)
  .select(boardShape)
  .orderBy(Issue.rank, "asc");
// enddocs:board-query

export const peopleQuery = Query.from(User)
  .select({ id: User.id, name: User.name, email: User.email })
  .orderBy(User.name, "asc");

export const labelsQuery = Query.from(Label)
  .select(labelShape)
  .orderBy(Label.name, "asc");

// docs:comments-query
export const commentsQuery = (issueId: Ramose.Eid<typeof Issue>) =>
  Query.from(Comment)
    .where({ issue: issueId })
    .select(commentShape)
    .orderBy(Comment.at, "asc");
// enddocs:comments-query

// docs:every-issue-ever-query
export const everyIssueEverQuery = Query.from(Issue).select({
  id: Issue.id,
  title: Issue.title,
});
// enddocs:every-issue-ever-query

// docs:board-row-type
export type BoardRow = Ramose.Row<typeof boardQuery>;
// enddocs:board-row-type

export type Person = BoardRow["creator"];
export type LabelRow = Ramose.Row<typeof labelsQuery>;
export type CommentRow = Ramose.Row<ReturnType<typeof commentsQuery>>;
