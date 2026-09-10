import type { MutationRef } from "ramose/db";
// docs:reef-queries
import type { ClientDatabase } from "ramose/client";
import { Comment, Issue, Label, Person, Workspace } from "./schema.ts";

export const workspaces = (db: ClientDatabase) =>
  db.query.from(Workspace).orderBy(Workspace.slug, "asc");

export const people = (db: ClientDatabase) =>
  db.query.from(Person).orderBy(Person.sub, "asc");

export const boardIssues = (db: ClientDatabase, workspace: MutationRef<typeof Workspace>) =>
  db.query.from(Issue)
    .where({ workspace })
    .orderBy(Issue.rank, "asc");

export const boardLabels = (db: ClientDatabase, workspace: MutationRef<typeof Workspace>) =>
  db.query.from(Label)
    .where({ workspace })
    .orderBy(Label.name, "asc");

export const issueComments = (db: ClientDatabase, issue: MutationRef<typeof Issue>) =>
  db.query.from(Comment).where({ issue }).orderBy(Comment.at, "asc");

// enddocs:reef-queries
