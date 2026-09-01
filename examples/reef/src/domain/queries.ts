// docs:reef-queries
import type { ClientDatabase } from "ramose/client";
import { Comment, Issue, Label, Person, Workspace } from "./schema.ts";

export const workspaces = (db: ClientDatabase) =>
  db.query.from(Workspace).orderBy(Workspace.slug, "asc");

export const people = (db: ClientDatabase) =>
  db.query.from(Person).orderBy(Person.sub, "asc");

export const boardIssues = (db: ClientDatabase, workspace: string) =>
  db.query.from(Issue)
    .where({ workspaceSlug: workspace })
    .orderBy(Issue.rank, "asc");

export const boardLabels = (db: ClientDatabase, workspace: string) =>
  db.query.from(Label)
    .where({ workspaceSlug: workspace })
    .orderBy(Label.name, "asc");

export const issueComments = (db: ClientDatabase, issue: string) =>
  db.query.from(Comment).where({ issue: issue as never }).orderBy(Comment.at, "asc");

// enddocs:reef-queries
