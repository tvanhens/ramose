/**
 * `ramose/query` — the query language, flat.
 *
 * ```typescript
 * import { Query } from "ramose/query";
 *
 * const p = Ramose.params({ me: User.id, since: Schema.Number });
 * export const inbox = Query.from(Issue)
 *   .where({ done: false })
 *   .where(Query.none(Comment.issue, Query.is(Comment.author, p.me)))
 *   .select({ id: Issue.id, title: Issue.title })
 *   .orderBy(Issue.title)
 *   .limit(50);
 * ```
 *
 * Everything here is also reachable as `Ramose.Q` / `Ramose.Query` from
 * `ramose/db`; this subpath exists so everyday query modules can import the
 * combinators bare. `Query.q` + `pipe` remain the generator/kernel spelling.
 */

export * from "./db/query/surface.ts";
export { Q } from "./db/query/index.ts";
export * as Query from "./db/query/surface.ts";
