import {
  isSchemaDefinition,
  type AnySchemaDefinition,
} from "../db/Schema.ts";
import {
  DEFAULT_REPLICA_DATABASE_NAME,
  IndexedDbReplicaStorage,
} from "../internal/replication/indexeddb.ts";
import type { ReplicationIdentity } from "../internal/replication/protocol.ts";
import {
  replicaDatabaseKey,
  replicaDatabaseScopeOf,
  replicaScopeKey,
  replicaScopeOf,
  type ReplicaDatabaseScope,
} from "../internal/replication/replica-lifecycle.ts";
import type { ReplicaNotice } from "../internal/replication/notices.ts";
import { observeActivation } from "./activation.ts";
import {
  platformLocks,
  replicaLeaderKey,
  SyncLeadership,
} from "../internal/replication/leadership.ts";
import type { MutationEndpoint } from "../internal/replication/submission.ts";
import { replicationActivationAddress } from "../internal/replication/transport.ts";
import { completeSchema } from "../internal/authorization/read-tables.ts";
import { compositionFromSchema } from "../db/composition.ts";
import type { CompositionIndex } from "../internal/core/composition.ts";
import { installClientCatalog, type ClientCatalog } from "./catalog.ts";
import {
  installClientOperations,
  selfOperationsFor,
  type ClientOperations,
} from "./operations.ts";
import type { MutationContext } from "./mutation.ts";
import type {
  DatabaseMutations,
  MutationNamespace,
} from "./mutation-schema.ts";
import { SubmissionLoop } from "./submission.ts";
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
import {
  fencedReceiver,
  GraphRegistry,
  mostRecentlyConfirmed,
  receiverStableKey,
} from "./graph.ts";
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

export type ClientOptions<S extends AnySchemaDefinition = AnySchemaDefinition> = {
  readonly url: string;
  readonly root: string;
  readonly catalog: S;
  readonly auth: AuthProvider;
  readonly storageName?: string;
};

export type Client<Mutations = MutationNamespace> = {
  readonly open: () => ClientDatabase<Mutations>;
  readonly sync: Subscription<SyncState>;
  readonly close: () => Promise<void>;
  readonly clearLocalData: () => Promise<void>;
};

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const settled = (status: SyncStatus): boolean =>
  status !== "idle" && status !== "connecting";

const SCOPE_CONFIRMATION_TIMEOUT_MS = 10_000;

class RamoseClient implements Client {
  private readonly syncStore = new Store<SyncState>(syncState("idle"));
  readonly sync = this.syncStore.subscription;

  private root: ClientDatabaseHandle | undefined;
  private graph: GraphRegistry | undefined;
  private catalogBuild: Promise<ClientCatalog> | undefined;
  private storageHandle: Promise<IndexedDbReplicaStorage> | undefined;
  private confirmed: ReplicationIdentity | undefined;
  private operations: ClientOperations | undefined;
  private compositionIndex: CompositionIndex | undefined;
  private submissionLoop: SubmissionLoop | undefined;
  private leadership: SyncLeadership | undefined;
  private leaderName: string | undefined;
  private releaseInvalidation: (() => void) | undefined;
  private releaseNotices: (() => void) | undefined;
  private releaseActivation: (() => void) | undefined;
  private readonly receivers = new Map<string, ClientDatabaseHandle | undefined>();
  private terminal: "closed" | "cleared" | "fenced" | undefined;
  private termination: Promise<void> | undefined;
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
        this.confirm(identity);
        this.elect(identity);
      },
      onFenced: () => {
        void this.terminate(this.clearing ? "cleared" : "fenced");
      },
      mutations: this.mutationContext(),
    };
  }

  private handles(): readonly ClientDatabaseHandle[] {
    return [
      ...(this.root === undefined ? [] : [this.root]),
      ...(this.graph?.handles() ?? []),
    ];
  }

  private handleByKey(key: string | undefined): readonly ClientDatabaseHandle[] {
    if (key === undefined) return this.handles();
    return this.handles().filter((handle) => {
      const scope = handle.confirmedScope();
      return scope !== undefined && replicaDatabaseKey(scope) === key;
    });
  }

  private receive(notice: ReplicaNotice): void {
    const identity = this.confirmed;
    if (this.terminal !== undefined || identity === undefined) return;
    const scope = replicaScopeOf(identity);
    if (replicaScopeKey(scope) !== notice.scope) return;
    switch (notice.kind) {
      case "replica":
        for (const handle of this.handleByKey(notice.database)) {
          void handle.refreshCommitted();
        }
        return;
      case "reset":
        for (const handle of this.handleByKey(notice.database)) {
          void handle.revalidate().then(() => handle.refreshCommitted());
        }
        return;
      case "layer":
        for (const handle of this.handleByKey(notice.database)) {
          void handle.refreshOptimistic();
        }
        this.submissions().request(scope);
        return;
      case "receipt":
      case "fence":
        for (const handle of this.handleByKey(notice.database)) {
          void handle.refreshOptimistic();
        }
        void this.submissions().settleFromDurable();
        return;
      case "selector":
        for (const handle of this.handles()) {
          handle.reactivateUnconfirmed();
          handle.reactivateRefused();
        }
        this.submissions().request(scope);
        return;
    }
  }

  private wake(): void {
    if (this.terminal !== undefined) return;
    const revalidated = this.revalidate();
    for (const handle of this.handles()) {
      void handle.refreshOptimistic();
      handle.reactivateUnconfirmed();
      handle.reactivateRefused();
      handle.reactivateOffline();
    }
    void revalidated.then(() => {
      if (this.terminal !== undefined) return;
      for (const handle of this.handles()) void handle.refreshCommitted();
      void this.submissions().settleFromDurable();
      const identity = this.confirmed;
      if (identity !== undefined) this.submissions().request(replicaScopeOf(identity));
    });
  }

  private async revalidate(): Promise<void> {
    await Promise.all(this.handles().map((handle) => handle.revalidate()));
  }

  private confirm(identity: ReplicationIdentity, held = true): void {
    const previous = this.confirmed;
    if (held || previous === undefined) this.confirmed = identity;
    if (
      previous === undefined ||
      replicaScopeKey(replicaScopeOf(previous)) ===
        replicaScopeKey(replicaScopeOf(identity))
    ) return;
    void this.revalidate();
  }

  private composition(): CompositionIndex {
    this.compositionIndex ??= compositionFromSchema(
      completeSchema(this.options.catalog),
    );
    return this.compositionIndex;
  }
  private clientOperations(): ClientOperations {
    this.operations ??= installClientOperations(
      this.options.catalog,
      completeSchema(this.options.catalog),
    );
    return this.operations;
  }

  private mutationContext(): MutationContext {
    return {
      databaseOperations: () => this.clientOperations().database,
      selfOperations: (focus) =>
        selfOperationsFor(this.clientOperations(), this.composition(), focus),
      catalog: () => this.catalog(),
      storage: () => this.storage(),
      assertLive: (operation) => this.assertLive(operation),
      submit: (receiver) => this.submissions().request(receiver),
      applied: (receiver) => this.observeLayers(replicaDatabaseKey(receiver)),
      track: (receiver, driver) => this.submissions().track(receiver, driver),
      untrack: (driver) =>
        this.submissions().untrack(driver.receipt.invocation),
    };
  }

  private observeLayers(database: string): void {
    if (this.terminal !== undefined) return;
    for (const handle of this.handleByKey(database)) {
      void handle.refreshOptimistic();
    }
  }

  private closeSubmissions(): void {
    this.submissionLoop?.close();
  }

  private elect(identity: ReplicationIdentity): void {
    if (this.terminal !== undefined) return;
    const scope = replicaScopeOf(identity);
    const name = replicaLeaderKey(
      replicaDatabaseScopeOf(identity),
      this.storageName(),
    );
    if (this.leaderName === name) return;
    this.leaderName = name;
    const stood = this.leadership;
    if (stood !== undefined) void stood.release();
    const leadership = SyncLeadership.begin({
      name,
      locks: platformLocks(),
      claim: async () => (await this.storage()).claimLeadership(name, scope),
      onLeading: () => {
        if (this.terminal === undefined) this.submissions().request(scope);
      },
    });
    this.leadership = leadership;
    this.releaseInvalidation?.();
    this.releaseInvalidation = undefined;
    void this.storage().then(
      (storage) => {
        const release = storage.onInvalidated(() => void leadership.release());
        if (this.leadership === leadership) this.releaseInvalidation = release;
        else release();
      },
      () => undefined,
    );
  }

  private submissions(): SubmissionLoop {
    this.submissionLoop ??= new SubmissionLoop({
      storage: () => this.storage(),
      leadership: () => this.leadership,
      credential: () => this.credential(),
      endpoint: (receiver, credential) => this.endpointFor(receiver, credential),
      resolve: (receiver) => this.resolveReceiver(receiver),
      retire: (receiver) => this.retireReceiver(receiver),
      revalidate: () => this.revalidate(),
      reconcile: async (receiver, progress) => {
        await this.databaseFor(receiver)?.reconcileSubmissions(progress);
      },
      live: () => this.terminal === undefined,
    });
    return this.submissionLoop;
  }

  private resolveReceiver(receiver: ReplicaDatabaseScope): void {
    const key = replicaDatabaseKey(receiver);
    if (this.terminal !== undefined) return;
    if (this.receivers.has(key)) {
      this.receivers.get(key)?.reactivateOffline();
      return;
    }
    if (this.databaseFor(receiver) !== undefined) return;
    this.receivers.set(key, undefined);
    void this.storage().then(
      async (storage) => {
        const record = await storage.graphReceiver(receiver);
        if (record === undefined || this.terminal !== undefined) {
          this.receivers.delete(key);
          return;
        }
        const handle = this.graphRegistry()
          .acquire(receiverStableKey(receiver), record.graphPath, this);
        this.receivers.set(key, handle);
        handle.activateGraph();
      },
      () => {
        this.receivers.delete(key);
      },
    );
  }

  private retireReceiver(receiver: ReplicaDatabaseScope): void {
    const key = replicaDatabaseKey(receiver);
    if (!this.receivers.delete(key)) return;
    this.graph?.retire(receiverStableKey(receiver), this);
  }

  private databaseFor(
    receiver: ReplicaDatabaseScope,
  ): ClientDatabaseHandle | undefined {
    return mostRecentlyConfirmed(
      this.handles(),
      replicaDatabaseKey(receiver),
    );
  }

  private endpointFor(
    receiver: ReplicaDatabaseScope,
    credential: AuthCredential,
  ): MutationEndpoint | undefined {
    const handle = this.databaseFor(receiver);
    if (handle === undefined) return undefined;
    if (!handle.authenticatedBy(credential)) return undefined;
    const fenced = fencedReceiver(handle.syncStatus());
    if (fenced !== undefined) return undefined;
    return {
      origin: this.server,
      database: this.options.root,
      graphPath: handle.graphPath(),
      credential: credential.token,
    };
  }

  private graphRegistry(): GraphRegistry {
    this.graph ??= new GraphRegistry(
      ({ graphPath, graphLineage, onConfirmed }) =>
        new ClientDatabaseHandle({
          ...this.databaseContext(),
          graphPath,
          graphLineage,
          onConfirmed: (identity) => {
            onConfirmed(identity);
            this.confirm(identity, false);
          },
        }),
      () => this.refreshSync(),
    );
    return this.graph;
  }

  private assertLive(operation: string): void {
    if (this.terminal !== undefined) {
      throw new ClientClosedError({ operation, reason: this.terminal });
    }
  }

  private catalog(): Promise<ClientCatalog> {
    this.catalogBuild ??= installClientCatalog(
      this.options.catalog,
      this.clientOperations().installed,
    );
    return this.catalogBuild;
  }

  private storageName(): string {
    return this.options.storageName ?? DEFAULT_REPLICA_DATABASE_NAME;
  }

  private storage(): Promise<IndexedDbReplicaStorage> {
    this.storageHandle ??= IndexedDbReplicaStorage.open(this.storageName())
      .then((storage) => {
        if (this.terminal !== undefined) return storage;
        this.releaseNotices = storage.notices((notice) => this.receive(notice));
        this.releaseActivation ??= observeActivation(() => this.wake());
        return storage;
      });
    return this.storageHandle;
  }

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
    const errands = new Set(this.receivers.values());
    const statuses = [
      ...(this.root === undefined ? [] : [this.root.syncStatus()]),
      ...(this.graph?.handles() ?? [])
        .filter((handle) => !errands.has(handle))
        .map((handle) => handle.syncStatus()),
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
      throw new ClientLocalDataError({ reason: "storage", cause });
    }
    await this.terminate("cleared");
  }

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
    this.termination ??= this.shutdown(reason);
    await this.termination;
  }

  private async shutdown(
    reason: "closed" | "cleared" | "fenced",
  ): Promise<void> {
    this.terminal = reason;
    this.releaseActivation?.();
    this.releaseActivation = undefined;
    this.releaseNotices?.();
    this.releaseNotices = undefined;
    this.releaseInvalidation?.();
    this.releaseInvalidation = undefined;
    this.closeSubmissions();
    await this.submissionLoop?.settled();
    await this.leadership?.release();
    await this.graph?.close();
    await this.root?.close();
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
export const createClient = <const S extends AnySchemaDefinition>(
  options: ClientOptions<S>,
): Client<DatabaseMutations<S>> => {
  if (!nonEmpty(options?.root)) {
    throw new ClientConfigurationError({
      message: "createClient needs a configured root route",
    });
  }
  if (!isSchemaDefinition(options.catalog)) {
    throw new ClientConfigurationError({
      message: "createClient needs a named Ramose schema",
    });
  }
  if (typeof options.auth !== "function") {
    throw new ClientConfigurationError({
      message: "createClient needs an auth() provider returning { token, cacheKey }",
    });
  }
  let server: string;
  try {
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
  return new RamoseClient(options, server) as unknown as Client<DatabaseMutations<S>>;
};
