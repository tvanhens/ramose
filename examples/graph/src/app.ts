// docs:graph-client
import { createClient, type Client, type ClientDatabase } from "ramose/client";
import { AppSchema, Board, Issue, Organization, ROOT_DATABASE } from "./catalogs.ts";

export type Session = {
  readonly token: string;
  readonly cacheKey: string;
};

export type AppOptions = {
  readonly url: string;
  readonly session: () => Session | Promise<Session>;
  readonly storageName?: string;
};

export const openApp = (options: AppOptions): Client =>
  createClient({
    url: options.url,
    root: ROOT_DATABASE,
    catalog: AppSchema,
    auth: options.session,
    ...(options.storageName === undefined
      ? {}
      : { storageName: options.storageName }),
  });

export const organizations = (db: ClientDatabase) =>
  db.query.from(Organization)
    .select({ slug: Organization.slug, name: Organization.name })
    .orderBy(Organization.slug, "asc");

export const boards = (db: ClientDatabase) =>
  db.query.from(Board)
    .select({ slug: Board.slug, name: Board.name })
    .orderBy(Board.slug, "asc");

export const issues = (db: ClientDatabase) =>
  db.query.from(Issue).orderBy(Issue.title, "asc");

export const openIssues = (db: ClientDatabase) =>
  db.query.from(Issue).where({ status: "open" }).orderBy(Issue.title, "asc");

export const boardDb = (
  rootDb: ClientDatabase,
  organizationSlug: string,
  boardSlug: string,
): ClientDatabase =>
  rootDb.query.from(Organization).where({ slug: organizationSlug }).one().db()
    .query.from(Board).where({ slug: boardSlug }).one().db();

export const organizationDb = (
  rootDb: ClientDatabase,
  organizationSlug: string,
): ClientDatabase =>
  rootDb.query.from(Organization).where({ slug: organizationSlug }).one().db();
// enddocs:graph-client
