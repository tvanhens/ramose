/**
 * `ramose/query` — the query language, flat.
 *
 * ```typescript
 * import { pipe } from "effect/Function";
 * import { Q, Query, entities, is, none, select, orderBy, limit } from "ramose/query";
 *
 * export const inbox = Query.q(
 *   { me: Ramose.EidOf(User), since: Schema.Number },
 *   (p) => pipe(
 *     entities(Issue),
 *     is(Issue.done, false),
 *     none(Comment.issue, is(Comment.author, p.me)),
 *     updatedSince(p.since),
 *     select({ id: Issue.id, title: Issue.title }),
 *     orderBy("title"), limit(50),
 *   ),
 * );
 * ```
 *
 * Everything here is also reachable as `Ramose.Q` / `Ramose.Query` from
 * `ramose/db`; this subpath exists so everyday query modules can import the
 * combinators bare.
 */

export * from "./db/query/surface.ts";
export { Q } from "./db/query/index.ts";
export * as Query from "./db/query/surface.ts";
