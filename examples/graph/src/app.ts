// docs:graph-client
import { createClient, type Client, type ClientDatabase } from "ramose/client";
import { AppCatalog, Board, Issue, Organization, ROOT_DATABASE } from "./catalogs.ts";

/**
 * One bearer and the account it belongs to.
 *
 * `token` is what the peer authenticates. `cacheKey` selects which account's
 * local replica this credential may nominate; it never leaves the device and
 * grants nothing on its own.
 */
export type Session = {
  readonly token: string;
  readonly cacheKey: string;
};

export type AppOptions = {
  /** The peer's origin. Same-origin in the browser; a URL in a test harness. */
  readonly url: string;
  /** Where a fresh bearer comes from. Called once per activation. */
  readonly session: () => Session | Promise<Session>;
  /** The IndexedDB namespace. One per signed-in browser profile. */
  readonly storageName?: string;
};

export const openApp = (options: AppOptions): Client =>
  createClient({
    url: options.url,
    root: ROOT_DATABASE,
    catalog: AppCatalog,
    auth: options.session,
    ...(options.storageName === undefined
      ? {}
      : { storageName: options.storageName }),
  });

/**
 * Every query this application asks, built from the database that answers it.
 *
 * `db.query.from` is the portable query language with one addition: a chain
 * that still has one entity focus publishes live entity handles rather than
 * plain rows, so a rendered row carries `.local` and `.mutate`. A `select(…)`
 * projects that focus away, which is exactly right for the two navigation
 * queries below — a name and a slug are data, not an entity to act on.
 */
export const organizations = (db: ClientDatabase) =>
  db.query.from(Organization)
    .select({ slug: Organization.slug, name: Organization.name })
    .orderBy(Organization.slug, "asc");

export const boards = (db: ClientDatabase) =>
  db.query.from(Board)
    .select({ slug: Board.slug, name: Board.name })
    .orderBy(Board.slug, "asc");

/** One board's issues, as live handles. */
export const issues = (db: ClientDatabase) =>
  db.query.from(Issue).orderBy(Issue.title, "asc");

/** The open ones, which is what a board actually renders. */
export const openIssues = (db: ClientDatabase) =>
  db.query.from(Issue).where({ status: "open" }).orderBy(Issue.title, "asc");

/**
 * Walk root → organization → board.
 *
 * Each `.one().db()` is a child database reached through the deployed `Graph`
 * the parent entity composes. The path names travel to the peer on every
 * activation, which authorizes each segment; nothing here is a client-side
 * authorization claim.
 */
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
