// docs:reef-queries
import type { ClientDatabase } from "ramose/client";
import { Comment, Issue, Label, Person, Workspace } from "./schema.ts";

export const workspaces = (db: ClientDatabase) =>
  db.query.from(Workspace).orderBy(Workspace.slug, "asc");

export const people = (db: ClientDatabase) =>
  db.query.from(Person).orderBy(Person.sub, "asc");

export const boardIssues = (db: ClientDatabase) =>
  db.query.from(Issue).orderBy(Issue.rank, "asc");

export const boardLabels = (db: ClientDatabase) =>
  db.query.from(Label).orderBy(Label.name, "asc");

export const issueComments = (db: ClientDatabase, issue: string) =>
  db.query.from(Comment).where({ issue: issue as never }).orderBy(Comment.at, "asc");

export const workspaceDb = (
  rootDb: ClientDatabase,
  slug: string,
): ClientDatabase =>
  rootDb.query.from(Workspace).where({ slug }).one().db();
// enddocs:reef-queries
