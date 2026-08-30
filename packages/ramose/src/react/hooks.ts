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
 *
 * A terminal client — one that was closed, cleared, or fenced — throws here, as
 * it does everywhere else. That is deliberate rather than softened into an
 * empty render: those states are terminal for the *instance*, an application
 * recovers by constructing a new client, and a tree that keeps rendering
 * against the old one is asking a question that no longer has an answer. Swap
 * the client on the provider (or unmount the tree) as part of closing it.
 */
export const useDb = (): ClientDatabase => useClient().open();

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
  const provided = useContext(ClientContext);
  const db = database ?? provided?.open();
  if (db === undefined) {
    throw new Error(
      "ramose/react: useQuery needs a <RamoseProvider> or an explicit database",
    );
  }
  const key = queryObservationKey(query);
  const store = queryStore<Out>(db, key, () => db.observe(query));
  return useSyncExternalStore(store.subscribe, store.getSnapshot, pendingOnServer);
};

export const useSyncState = (source?: Client | ClientDatabase): SyncState => {
  const provided = useContext(ClientContext);
  const sync: Subscription<SyncState> | undefined = (source ?? provided)?.sync;
  if (sync === undefined) {
    throw new Error(
      "ramose/react: useSyncState needs a <RamoseProvider> or an explicit client",
    );
  }
  return useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot);
};
