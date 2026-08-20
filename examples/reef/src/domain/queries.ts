/**
 * Every read the app asks, as hoisted navigational query values — stable
 * dependencies for `useLive`, runnable one-shot (`db.q`), live (`db.live`)
 * against the session overlay, or in the past (`db.asOf(t).q`) on the
 * peer. The pull shapes are also fed to
 * `Ramose.Policy.compile({ pulls })` so a read-masked attribute pulled as
 * required is a deploy-time error, not a silently dropped row.
 */

import type { Db } from "ramose/db";
import * as Ramose from "ramose/db";
import { Comment, Issue, Label, Reef, User } from "./schema.ts";

export type ReefDb = Db<typeof Reef>;

// ── shapes ───────────────────────────────────────────────────────────────────

export const personShape = { id: User.id, name: User.name } as const;
export const labelShape = {
  id: Label.id,
  name: Label.name,
  color: Label.color,
} as const;

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

/**
 * What the detail panel `db.pull`s on top of its live board row (the row
 * already carries status/priority/assignee/labels/creator).
 */
export const issueExtraShape = {
  title: Issue.title,
  description: Issue.description.optional,
  // Read-masked for member/viewer (policy.ts): must be `.optional`, so for
  // them the row survives and the field is simply absent.
  privateNote: Issue.privateNote.optional,
} as const;

export const commentShape = {
  id: Comment.id,
  body: Comment.body,
  at: Comment.at,
  author: Comment.author.select(personShape),
} as const;

/** Everything `compile({ pulls })` should vet. */
export const allShapes: readonly unknown[] = [
  boardShape,
  issueExtraShape,
  commentShape,
  personShape,
  labelShape,
];

// ── queries ──────────────────────────────────────────────────────────────────

export const boardQuery = Ramose.query(Issue)
  .orderBy(Issue.rank, "asc")
  .select(boardShape);

export const peopleQuery = Ramose.query(User)
  .orderBy(User.name, "asc")
  .select({ id: User.id, name: User.name, email: User.email });

export const labelsQuery = Ramose.query(Label)
  .orderBy(Label.name, "asc")
  .select(labelShape);

const CommentP = Ramose.params({ issueId: Issue.id });
export const commentsQuery = Ramose.query(Comment, CommentP)
  .where(Comment.issue.is(CommentP.issueId))
  .orderBy(Comment.at, "asc")
  .select(commentShape);

/** Over `db.history` this also returns issues that no longer exist. */
export const everyIssueEverQuery = Ramose.query(Issue).select({
  id: Issue.id,
  title: Issue.title,
});

/** One row of {@link boardQuery} — inferred from the query, never restated. */
export type BoardRow = Ramose.Row<typeof boardQuery>;

export type Person = BoardRow["creator"];
export type LabelRow = Ramose.Row<typeof labelsQuery>;
export type CommentRow = Ramose.Row<typeof commentsQuery>;
