import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AnyComposer } from "../db/Composer.ts";
import type { QueryObject } from "../db/query/index.ts";
import { queryObservationKey } from "../client/database.ts";
import type {
  Client,
  ClientDatabase,
  ClientValue,
  EntityFocused,
  EntityResult,
  MutationNamespace,
  Receipt,
  Subscription,
  SyncState,
} from "../client/index.ts";
import { PENDING, type QueryState } from "./query-state.ts";
import { IDLE, type ReceiptView } from "./receipt-state.ts";
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
 *
 * A React context holds one client for a whole tree and cannot carry that
 * client's catalog into each consumer's types, so this answers the runtime
 * namespace by default. Name the catalog's namespace —
 * `useDb<DatabaseMutations<typeof AppSchema>>()` — or hold the typed client's
 * own `open()` at module scope, to read `db.mutate` with the catalog's exact
 * operations.
 */
export const useDb = <Mutations = MutationNamespace>(): ClientDatabase<
  Mutations
> => useClient().open() as ClientDatabase<Mutations>;

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
export function useQuery<N extends AnyComposer, Row, Out>(
  query: EntityFocused<N, Row, Out>,
  database?: ClientDatabase,
): QueryState<EntityResult<N, Row, Out>>;
export function useQuery<Row, Out>(
  query: QueryObject<Row, Out>,
  database?: ClientDatabase,
): QueryState<ClientValue<Out>>;
export function useQuery<Row, Out>(
  query: QueryObject<Row, Out>,
  database?: ClientDatabase,
): QueryState<ClientValue<Out>> {
  const provided = useContext(ClientContext);
  const db = database ?? provided?.open();
  if (db === undefined) {
    throw new Error(
      "ramose/react: useQuery needs a <RamoseProvider> or an explicit database",
    );
  }
  const key = queryObservationKey(query);
  const store = queryStore<ClientValue<Out>>(db, key, () => db.observe(query));
  return useSyncExternalStore(store.subscribe, store.getSnapshot, pendingOnServer);
}

const stopNothing = (): void => undefined;
const observeNothing = (): (() => void) => stopNothing;
const readIdle = (): ReceiptView => IDLE;

/**
 * Observe one invocation and re-render as it settles.
 *
 * ```tsx
 * const [receipt, setReceipt] = useState<Receipt | null>(null);
 * const state = useReceipt(receipt);
 * return (
 *   <>
 *     <button onClick={() => setReceipt(db.mutate.createIssue({ title }))}>
 *       {state.status === "pending" || state.status === "queued"
 *         ? "Saving…"
 *         : "Save"}
 *     </button>
 *     {state.status === "rejected" ? <Refused code={state.error.code} /> : null}
 *   </>
 * );
 * ```
 *
 * A receipt is already the external store this hook needs — it carries its own
 * `subscribe` and `getSnapshot`, both frozen onto it when the invocation was
 * created — so there is nothing to intern. Two receipts are two invocations,
 * never the same one under a different name, and a receipt is reachable only
 * from the code that holds it: the query cache exists because a query *value*
 * is rebuilt on every render and must select an existing observation, and
 * neither half of that applies here.
 *
 * `null` and `undefined` read as `idle`, so a component may call this hook
 * unconditionally on the render before its user acts. Hold the receipt in state
 * rather than rebuilding it: calling a mutation while rendering would invoke
 * once per render.
 *
 * Nothing is cancelled by unmounting. A queued invocation is durable and
 * proceeds without an observer; a later component given the same receipt reads
 * whatever state it reached in the meantime, terminal states included.
 */
export const useReceipt = (receipt?: Receipt | null): ReceiptView =>
  useSyncExternalStore<ReceiptView>(
    receipt?.subscribe ?? observeNothing,
    receipt?.getSnapshot ?? readIdle,
    receipt?.getSnapshot ?? readIdle,
  );

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
