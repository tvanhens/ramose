/**
 * `ramose/client` — the framework-neutral offline-first client.
 *
 * One canonical server origin, one configured public root route, one installed
 * catalog, one refreshable credential:
 *
 * ```typescript
 * import { createClient } from "ramose/client";
 * import { AppCatalog, Issue } from "./catalog.ts";
 *
 * const client = createClient({
 *   url: "https://data.example.com",
 *   root: "app",
 *   catalog: AppCatalog,
 *   auth: () => ({ token: session.accessToken, cacheKey: session.user.id }),
 * });
 *
 * const db = client.open();
 * const issues = db.observe(
 *   db.query.from(Issue).where({ status: "open" }).orderBy(Issue.rank),
 * );
 *
 * const stop = issues.subscribe(() => render(issues.getSnapshot()));
 * ```
 *
 * Everything before the first `observe` is inert: constructing the client and
 * opening the root handle perform no query, storage, authorization, or network
 * work. Observing a query activates that database, and from then on every read
 * is local — the server never receives a query, and committed and optimistic
 * changes rerun the observers they affect.
 *
 * The subscription pair is exactly what `useSyncExternalStore` wants, and it is
 * the whole framework contract: `subscribe(onChange)` and `getSnapshot()`,
 * with a snapshot identity that changes if and only if the value changed.
 *
 * Replication scopes, revisions, coverage, transport frames, checkpoints, and
 * physical database names are not on this surface and never will be.
 */

export { createClient } from "./client.ts";
export type {
  AuthCredential,
  AuthProvider,
  Client,
  ClientOptions,
} from "./client.ts";
export type {
  ClientDatabase,
  QuerySnapshot,
  QuerySubscription,
} from "./database.ts";
export type {
  ClientQuery,
  ComposesGraph,
  GraphFocus,
  GraphFocusDb,
} from "./graph.ts";
export type { Subscription } from "./subscription.ts";
export type { SyncState, SyncStatus } from "./sync.ts";
export {
  ClientClosedError,
  ClientConfigurationError,
  ClientLocalDataError,
  GraphPathError,
  GraphReceiverError,
  type ClientLocalDataFailure,
  type GraphPathFailure,
  type GraphReceiverFailure,
} from "./errors.ts";
