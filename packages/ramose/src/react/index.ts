/**
 * `ramose/react` — the React adapter for the offline-first client.
 *
 * ```tsx
 * import { createClient } from "ramose/client";
 * import { RamoseProvider, useQuery, useSyncState } from "ramose/react";
 *
 * const client = createClient({ url, root, catalog: AppCatalog, auth });
 *
 * const App = () => (
 *   <RamoseProvider client={client}>
 *     <Board />
 *   </RamoseProvider>
 * );
 *
 * const Board = () => {
 *   const db = useDb();
 *   const issues = useQuery(db.query.from(Issue).where({ status: "open" }));
 *   const sync = useSyncState();
 *   if (issues.status === "pending") return <Spinner />;
 *   if (issues.status === "error") return <Failed error={issues.error} />;
 *   return <List rows={issues.data} offline={sync.status === "offline"} />;
 * };
 * ```
 *
 * This is an adapter and only an adapter. It introduces no React-specific
 * database or synchronization semantics: `ramose/client` owns transport,
 * authorization, the outbox, reconciliation and every state transition, and
 * publishes them through one `{ subscribe, getSnapshot }` pair per observable
 * thing. What is added here is the join to React's external-store contract —
 * a stable `subscribe`/`getSnapshot` identity per query, and the narrowing of
 * the client's flat snapshot into a {@link QueryState} union a component can
 * switch on.
 *
 * **Rendering is safe.** Building a query value, opening the root handle, and
 * observing all perform no query, storage, authorization or network work
 * synchronously, and retain nothing until React subscribes — so a render React
 * throws away (Strict Mode's second pass, an interrupted concurrent render)
 * leaves no observation behind.
 *
 * **Unmounting releases only this component's observation.** Databases the
 * client activated stay synchronized for the rest of the client session, and
 * every durable thing — the committed replica, the outbox, receipts, optimistic
 * layers — is untouched.
 *
 * **Rows carry no portable identity yet.** The `id` on a query row is a local
 * eid that is not stable across replicas or sessions. Do not use it as a React
 * `key`, a route parameter, or anything persisted; the opaque entity identity
 * that replaces it arrives with the mutation surface.
 *
 * **Not here yet.** `useReceipt` and the Suspense-compatible option wait on the
 * public receipt and mutation surfaces; they belong to this issue's second
 * delivery slice, not to a React-only invention of them.
 */

export {
  RamoseProvider,
  useDb,
  useQuery,
  useSyncState,
  type RamoseProviderProps,
} from "./hooks.ts";
export { toQueryState, type QueryState } from "./query-state.ts";
