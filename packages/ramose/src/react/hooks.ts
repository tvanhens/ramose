/**
 * The hooks themselves — `useSyncExternalStore` over the client's own
 * subscriptions, and nothing more.
 *
 * There is no cache, no fetcher, no retry, no revalidation and no reconciler in
 * here. The client already owns every one of those, and a second copy living in
 * React would be a second answer to the same question.
 */

import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { QueryObject } from "../db/query/index.ts";
import { queryObservationKey } from "../client/database.ts";
import type {
  Client,
  ClientDatabase,
  Subscription,
  SyncState,
} from "../client/index.ts";
import { PENDING, type QueryState } from "./query-state.ts";
import { queryStore } from "./store.ts";

const ClientContext = createContext<Client | undefined>(undefined);

export type RamoseProviderProps = {
  /** The client every hook under this provider reads. */
  readonly client: Client;
  readonly children?: ReactNode;
};

/**
 * Bind one client to a React tree.
 *
 * The client is the application's, constructed wherever it wants one —
 * typically once at module scope, since construction is inert. This provider
 * neither creates nor closes it: a component that owned a client's lifetime
 * would tie a network session to a render tree, and an unmount would take the
 * whole application's synchronization down with it.
 *
 * This is a client-component boundary: the hooks below read browser storage and
 * subscribe to a live session, so the provider and everything using it run on
 * the client. Nothing here has a server rendering path to protect.
 */
export const RamoseProvider = (props: RamoseProviderProps): ReactElement =>
  createElement(ClientContext.Provider, { value: props.client }, props.children);

/** The client bound by the nearest {@link RamoseProvider}. */
const useClient = (): Client => {
  const client = useContext(ClientContext);
  if (client === undefined) {
    throw new Error("ramose/react: no <RamoseProvider client={...}> in this tree");
  }
  return client;
};

/**
 * The configured root database of the nearest provider's client.
 *
 * `open()` is interned and inert, so calling it while rendering costs one map
 * read and activates nothing.
 */
export const useDb = (): ClientDatabase => useClient().open();

/** `getServerSnapshot` for a query: there is no server-rendered answer. */
const pendingOnServer = (): QueryState<never> => PENDING;

/**
 * Observe one query and re-render when its answer changes.
 *
 * ```tsx
 * const issues = useQuery(db.query.from(Issue).where({ status: "open" }));
 * if (issues.status === "pending") return <Spinner />;
 * if (issues.status === "error") return <Failed error={issues.error} />;
 * return <List rows={issues.data} stale={issues.status === "stale"} />;
 * ```
 *
 * The query value is the portable one, built inline: it is inert, and its
 * *canonical identity* rather than its object identity is what selects the
 * observation, so rebuilding an equal query on every render observes the same
 * thing. Two components asking the same question share one observation, one
 * store, and one snapshot object.
 *
 * `database` defaults to the nearest provider's root. Pass it explicitly to
 * read a handle this tree does not provide.
 *
 * Server rendering: the server snapshot is always `pending`. Query answers are
 * local browser state, so there is nothing to serialize and nothing to hydrate;
 * the first client render after hydration reads the real one.
 */
export const useQuery = <Row, Out>(
  query: QueryObject<Row, Out>,
  database?: ClientDatabase,
): QueryState<Out> => {
  // Unconditional, so the hook order never depends on which form was used.
  const provided = useContext(ClientContext);
  const db = database ?? provided?.open();
  if (db === undefined) {
    throw new Error(
      "ramose/react: useQuery needs a <RamoseProvider> or an explicit database",
    );
  }
  // Lowered once per render, exactly as `observe()` would have. The canonical
  // key is what makes the store cache hit, so the observation, the subscription
  // and the narrowed snapshot are all built only the first time.
  const key = queryObservationKey(query);
  const store = queryStore<Out>(db, key, () => db.observe(query));
  return useSyncExternalStore(store.subscribe, store.getSnapshot, pendingOnServer);
};

/**
 * The synchronization state of one client, or of one database.
 *
 * ```tsx
 * const sync = useSyncState();
 * if (sync.status === "offline") return <OfflineBadge />;
 * ```
 *
 * The client publishes a frozen singleton per status, so this re-renders on a
 * status change and on nothing else — an equal status is the same object, and
 * React stops there.
 *
 * `authentication-required` and `closed` are terminal for the client instance:
 * there is nothing to retry, and an application recovers by constructing a new
 * client. `update-required` has two halves — a server-rotated authorized view
 * publishes nothing at all, while a build that cannot replay its own durable
 * optimistic layers keeps its committed rows readable with the pending work
 * left out — so a component may report it without also hiding what
 * {@link useQuery} is still answering.
 */
export const useSyncState = (source?: Client | ClientDatabase): SyncState => {
  const provided = useContext(ClientContext);
  const sync: Subscription<SyncState> | undefined = (source ?? provided)?.sync;
  if (sync === undefined) {
    throw new Error(
      "ramose/react: useSyncState needs a <RamoseProvider> or an explicit client",
    );
  }
  // The client's own pair, unwrapped: `getSnapshot` reads a published value, so
  // it is as valid on a server render as anywhere else.
  return useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot);
};
