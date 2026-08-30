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
