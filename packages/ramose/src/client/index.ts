
/**
 * The catalog-authoring surface, re-exported.
 *
 * An application that authors its catalog and runs the offline client needs
 * `Catalog` and `Policy` in the same bundle as `createClient`. Both resolved
 * only from `ramose` before, which carries the whole deploy engine — so the
 * choice was a re-export here or a two-package split for every consumer.
 *
 * A re-export, because it costs nothing a browser must not load: a build of
 * `client + Catalog + Policy` reaches Effect and the portable authorization
 * kernel and stops there, with no `alchemy`, no `cloudflare:workers`, no
 * `jose` and no `better-auth`. `test/client/bundle.test.ts` measures exactly
 * that with a real bundler, because a bundler is the only thing that knows
 * what a module graph actually drags in.
 */
export { Catalog, type CatalogDefinition, type CatalogProps } from "../Catalog.ts";
export * as Policy from "../Policy.ts";

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
export {
  EntityWithdrawnError,
  type EntityHandle,
  type EntityLocal,
} from "./entity.ts";
export type {
  MutationMethod,
  MutationNamespace,
} from "./mutation.ts";
export {
  MutationRejectedError,
  type Receipt,
  type ReceiptState,
} from "./receipt.ts";
export type {
  ClientQuery,
  ClientValue,
  ComposesGraph,
  EntityFocused,
  EntityResult,
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
