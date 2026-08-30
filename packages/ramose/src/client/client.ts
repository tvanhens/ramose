/**
 * `createClient` — one server origin, one configured root route, one installed
 * catalog, one refreshable credential.
 *
 * Constructing a client is synchronous and inert: nothing is opened, fetched,
 * read, or hashed until the first query is observed. That is what makes it safe
 * to build one at module scope and to construct handles during rendering.
 */

import { isCatalogDefinition, type CatalogDefinition } from "../Catalog.ts";
import { IndexedDbReplicaStorage } from "../internal/replication/indexeddb.ts";
import type { ReplicationIdentity } from "../internal/replication/protocol.ts";
import { replicaScopeOf } from "../internal/replication/replica-lifecycle.ts";
import { replicationActivationAddress } from "../internal/replication/transport.ts";
import { installClientCatalog, type ClientCatalog } from "./catalog.ts";
import {
  ClientClosedError,
  ClientConfigurationError,
  ClientLocalDataError,
} from "./errors.ts";
import {
  ClientDatabaseHandle,
  type ClientDatabase,
  type DatabaseContext,
} from "./database.ts";
import { GraphRegistry } from "./graph.ts";
import { Store, type Subscription } from "./subscription.ts";
import { aggregateSyncStatus, syncState, type SyncState, type SyncStatus } from "./sync.ts";

/**
 * One credential and the account it belongs to, produced atomically.
 *
 * `token` is the bearer the server authenticates. `cacheKey` is an
 * application/auth-provider account selector that is stable across ordinary
 * bearer renewal; it is hashed with the server origin and root and never
 * transmitted or persisted raw. It nominates a cache candidate and grants no
 * authority: only an exact prior bearer binding, or the current authenticated
 * response, can make a stored replica observable.
 */
export type AuthCredential = {
  readonly token: string;
  readonly cacheKey: string;
};

/** Called once per activation. May be synchronous or asynchronous. */
export type AuthProvider = () => AuthCredential | Promise<AuthCredential>;

export type ClientOptions = {
  /** The canonical server origin, e.g. `https://data.example.com`. */
  readonly url: string;
  /**
   * The configured public root route `/db/:root/*` uses.
   *
   * Immutable client configuration, never a stable database identity, and never
   * accepted by `open()`. There is no server-default-root discovery.
   */
  readonly root: string;
  /** The installed client catalog — the same authored value the server deploys. */
  readonly catalog: CatalogDefinition;
  readonly auth: AuthProvider;
  /**
   * The browser storage this client's replicas live in. Defaults to the shared
   * store, which is what lets one application's clients reuse one replica.
   * Sharing it safely across tabs is #478's barrier, not a client option.
   */
  readonly storageName?: string;
};

export interface Client {
  /**
   * The configured root database, as one interned handle.
   *
   * Argument-free by contract: the root route is configuration, so there is
   * nothing to select. Every call returns the same handle, and the call itself
   * activates nothing.
   */
  readonly open: () => ClientDatabase;
  /** This client's synchronization state, aggregated over its databases. */
  readonly sync: Subscription<SyncState>;
  /**
   * Release every network scope and in-process observer, deterministically.
   *
   * Durable work is never discarded: queued invocations, receipts, client refs,
   * committed replicas, and optimistic layers all survive. Clearing a principal
   * is {@link Client.clearLocalData}, not this.
   */
  readonly close: () => Promise<void>;
  /**
   * Delete every trace of this client's server/principal scope from local
   * storage: replicas, selectors, outbox, receipts, client refs and mappings,
   * optimistic layers, and observation markers — atomically, and only for a
   * scope an authenticated response has confirmed.
   *
   * Other principals and other application storage are untouched. Affected
   * sessions are generation-fenced and closed first, so nothing repopulates
   * what was just deleted.
   *
   * The clearing client is terminal afterwards: it cannot repopulate storage,
   * and the application constructs a new one.
   *
   * When no response has confirmed a scope *yet*, this waits for the root's
   * first activation to settle — offline that resolves through an exact prior
   * bearer binding, and otherwise through the server's own answer.
   *
   * @throws ClientLocalDataError with `no-confirmed-scope` when no authenticated
   * response has ever confirmed a scope this client could name.
   */
  readonly clearLocalData: () => Promise<void>;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** A status that will not change without new input, so a caller may wait on it. */
const settled = (status: SyncStatus): boolean =>
  status !== "idle" && status !== "connecting";

/**
 * How long `clearLocalData()` waits for an activation to name its scope.
 *
 * A server that accepts the connection and then sends nothing would otherwise
 * hang the one destructive entry point indefinitely, while every other one
 * fails fast. The deadline does not invent a scope: it gives up waiting, and
 * the ordinary typed `no-confirmed-scope` failure is what the caller sees.
 */
const SCOPE_CONFIRMATION_TIMEOUT_MS = 10_000;

class RamoseClient implements Client {
  private readonly syncStore = new Store<SyncState>(syncState("idle"));
  readonly sync = this.syncStore.subscription;

  private root: ClientDatabaseHandle | undefined;
  private graph: GraphRegistry | undefined;
  private catalogBuild: Promise<ClientCatalog> | undefined;
  private storageHandle: Promise<IndexedDbReplicaStorage> | undefined;
  private confirmed: ReplicationIdentity | undefined;
  private terminal: "closed" | "cleared" | "fenced" | undefined;
  /**
   * Set while this client's own clear is running, so the session its clear
   * closes is attributed to the clear rather than reported as a stranger's.
   */
  private clearing = false;

  constructor(
    private readonly options: ClientOptions,
    private readonly server: string,
  ) {}

  open(): ClientDatabase {
    this.assertLive("open");
    return this.rootHandle();
  }

  private rootHandle(): ClientDatabaseHandle {
    if (this.root !== undefined) return this.root;
    const root = new ClientDatabaseHandle({
      ...this.databaseContext(),
      graphPath: [],
    });
    this.root = root;
    return root;
  }

  /** Everything every database of this client shares, root or resolved child. */
  private databaseContext(): Omit<DatabaseContext, "graphPath"> {
    return {
      server: this.server,
      root: this.options.root,
      graph: () => this.graphRegistry(),
      catalog: () => this.catalog(),
      storage: () => this.storage(),
      credential: () => this.credential(),
      assertLive: (operation) => this.assertLive(operation),
      live: () => this.terminal === undefined,
      onSyncChange: () => this.refreshSync(),
      onConfirmed: (identity) => {
        this.confirmed = identity;
      },
      onFenced: () => {
        void this.terminate(this.clearing ? "cleared" : "fenced");
      },
    };
  }

  /**
   * The resolved child databases, interned by stable graph identity.
   *
   * Built lazily, so a client whose application never constructs a graph handle
   * carries nothing for one.
   */
  private graphRegistry(): GraphRegistry {
    this.graph ??= new GraphRegistry(({ graphPath, graphLineage, onConfirmed }) =>
      new ClientDatabaseHandle({
        ...this.databaseContext(),
        graphPath,
        graphLineage,
        onConfirmed: (identity) => {
          onConfirmed(identity);
          // Every database of one client shares one server/principal scope, so
          // a child's confirmation names the scope a clear would act on just as
          // the root's does.
          this.confirmed ??= identity;
        },
      })
    );
    return this.graph;
  }

  private assertLive(operation: string): void {
    if (this.terminal !== undefined) {
      throw new ClientClosedError({ operation, reason: this.terminal });
    }
  }

  private catalog(): Promise<ClientCatalog> {
    this.catalogBuild ??= installClientCatalog(this.options.catalog);
    return this.catalogBuild;
  }

  private storage(): Promise<IndexedDbReplicaStorage> {
    this.storageHandle ??= this.options.storageName === undefined
      ? IndexedDbReplicaStorage.open()
      : IndexedDbReplicaStorage.open(this.options.storageName);
    return this.storageHandle;
  }

  /** Resolve one atomic `{ token, cacheKey }` pair, refusing a partial one. */
  private async credential(): Promise<AuthCredential> {
    const credential = await this.options.auth();
    if (
      credential === null || typeof credential !== "object" ||
      !nonEmpty(credential.token) || !nonEmpty(credential.cacheKey)
    ) {
      throw new ClientConfigurationError({
        message: "auth() must return { token, cacheKey } as non-empty strings",
      });
    }
    return { token: credential.token, cacheKey: credential.cacheKey };
  }

  private refreshSync(): void {
    if (this.terminal !== undefined) {
      this.syncStore.publish(syncState("closed"));
      return;
    }
    // Every activated database of this client, root and resolved children
    // alike: a client is only as synchronized as its least synchronized one.
    const statuses = [
      ...(this.root === undefined ? [] : [this.root.syncStatus()]),
      ...(this.graph?.statuses() ?? []),
    ];
    this.syncStore.publish(syncState(aggregateSyncStatus(statuses)));
  }

  async close(): Promise<void> {
    await this.terminate("closed");
  }

  async clearLocalData(): Promise<void> {
    this.assertLive("clearLocalData");
    if (this.confirmed === undefined) await this.confirmScope();
    const identity = this.confirmed;
    if (identity === undefined) {
      throw new ClientLocalDataError({ reason: "no-confirmed-scope" });
    }
    const storage = await this.storage();
    this.clearing = true;
    try {
      await storage.clearScope(replicaScopeOf(identity));
    } catch (cause) {
      this.clearing = false;
      // The clear is atomic: a failure leaves the scope exactly as it was, so
      // this client stays usable and the call may be retried.
      throw new ClientLocalDataError({ reason: "storage", cause });
    }
    await this.terminate("cleared");
  }

  /**
   * Give the root one chance to obtain a confirmed identity.
   *
   * Offline this succeeds only through an exact prior bearer binding, which is
   * the same rule that governs reading: a scope no authenticated response ever
   * produced is not one this client may delete.
   */
  private async confirmScope(): Promise<void> {
    const root = this.rootHandle();
    void root.activate();
    if (settled(root.sync.getSnapshot().status)) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        stop();
        resolve();
      }, SCOPE_CONFIRMATION_TIMEOUT_MS);
      const release = root.sync.subscribe(() => {
        if (!settled(root.sync.getSnapshot().status)) return;
        stop();
        resolve();
      });
      const stop = (): void => {
        clearTimeout(timer);
        release();
      };
      if (settled(root.sync.getSnapshot().status)) {
        stop();
        resolve();
      }
    });
  }

  private async terminate(
    reason: "closed" | "cleared" | "fenced",
  ): Promise<void> {
    if (this.terminal !== undefined) return;
    this.terminal = reason;
    // Children first: closing the root releases the paths hanging off it, and a
    // path released before its database would leave that database's session
    // open with nothing holding it.
    await this.graph?.close();
    await this.root?.close();
    // Closing the storage handle releases every pin, retention and enrolment it
    // still holds. A cleared scope is terminal for the handle as well, so a
    // fresh client is the only way back to that scope.
    await this.storageHandle?.then(
      (storage) => storage.close(),
      () => undefined,
    );
    this.syncStore.publish(syncState("closed"));
  }
}

/**
 * Bind one server, one configured root route, one installed catalog, and one
 * refreshable credential provider.
 *
 * @throws ClientConfigurationError when any of them cannot be bound. None of
 * these become valid later, so they fail here rather than at the first query.
 */
export const createClient = (options: ClientOptions): Client => {
  if (!nonEmpty(options?.root)) {
    throw new ClientConfigurationError({
      message: "createClient needs a configured root route",
    });
  }
  if (!isCatalogDefinition(options.catalog)) {
    throw new ClientConfigurationError({
      message: "createClient needs an installed Ramose catalog",
    });
  }
  if (typeof options.auth !== "function") {
    throw new ClientConfigurationError({
      message: "createClient needs an auth() provider returning { token, cacheKey }",
    });
  }
  let server: string;
  try {
    // Canonicalized here so a malformed origin or a path-shaped root is a
    // construction-time error rather than a failure inside the first
    // activation, where an application would read it as being offline.
    server = replicationActivationAddress({
      server: options.url,
      root: options.root,
      graphPath: [],
    }).origin;
  } catch (cause) {
    throw new ClientConfigurationError({
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return new RamoseClient(options, server);
};
