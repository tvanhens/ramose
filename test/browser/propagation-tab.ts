import * as EffectSchema from "effect/Schema";
import { Catalog } from "../../packages/ramose/src/Catalog.ts";
import {
  Entity,
  Field,
  Graph,
  Schema,
  string,
  type CodeDefinition,
} from "../../packages/ramose/src/db/internal.ts";
import { compileReadAuthorization } from "../../packages/ramose/src/internal/authorization/index.ts";
import {
  createClient,
  type Client,
  type ClientDatabase,
} from "../../packages/ramose/src/client/index.ts";
import { installClientCatalog } from "../../packages/ramose/src/client/catalog.ts";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type { ReplicationIdentity } from "../../packages/ramose/src/internal/replication/protocol.ts";
import type { OutboxDraft } from "../../packages/ramose/src/internal/replication/outbox.ts";
import type { OperationVersion } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { invocationId } from "../../packages/ramose/src/db/refs.ts";
import {
  replicaDatabaseScopeOf,
  replicaScopeOf,
  type ReplicaDatabaseScope,
  type ReplicaLease,
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import {
  platformLocks,
  replicaLeaderKey,
  SyncLeadership,
} from "../../packages/ramose/src/internal/replication/leadership.ts";
import { SubmissionLoop } from "../../packages/ramose/src/client/submission.ts";
import {
  replicaRoutePathKey,
  replicaRouteScope,
  rootReplicaRouteSlot,
  stableReplicaRouteSlot,
} from "../../packages/ramose/src/internal/replication/route-slot.ts";
import {
  replicationActivationAddress,
  replicationCacheSelector,
  replicationCredentialFingerprint,
} from "../../packages/ramose/src/internal/replication/transport.ts";
import { changeFrame, snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";
import type { Receipt, ReceiptState } from "../../packages/ramose/src/client/receipt.ts";
import { serveTab } from "./tab-harness.ts";

export const OFFLINE = "http://127.0.0.1:1";
export const ROOT = "app";
export const TOKEN = "bearer-a";
export const CACHE_KEY = "account-a";

export const opaque = (character: string): string => character.repeat(43);

export const Note = Entity("note", {
  title: Field.unique(string(), "strict"),
  rank: string(),
}, {
  operations: (Operation) => ({
    rename: Operation({
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({}),
      optimistic: ({ input, self, tx }) => {
        if (self !== undefined) tx.set(self, Note.title, input.title);
      },
      run() {
        return {};
      },
    }),
  }),
});

const Child = { key: "child", schema: Schema({}) } satisfies CodeDefinition;

export const Workspace = Entity("workspace", {
  slug: Field.unique(string(), "strict"),
}, { traits: [Graph(Child)] });

const Notes = Schema({ note: Note, workspace: Workspace });

export const NotesCatalog = Catalog("propagation-notes", {
  schema: Notes,
  policy: compileReadAuthorization({ schema: Notes, rules: [] }),
});

export const CHILD_PATH = ["acme-workspace"] as const;

export const CHILD_LINEAGE = [opaque("1")];

export type SeededNote = {
  readonly entity: string;
  readonly title: string;
  readonly rank: string;
};

export const PRINCIPAL = opaque("p");

export const identityFor = async (
  database: string,
  graphLineage: readonly string[] = [],
  principal: string = PRINCIPAL,
): Promise<ReplicationIdentity> => ({
  version: 1,
  server: opaque("s"),
  principal,
  database,
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: (await installClientCatalog(NotesCatalog))
    .readCompatibilityHash,
  graphLineage,
  authenticator: opaque("a"),
});

type NoteDatom = {
  readonly entity: string;
  readonly field: string;
  readonly value: { readonly type: "string"; readonly value: string };
  readonly op: "add";
};

const fact = (entity: string, field: string, value: string): NoteDatom => ({
  entity,
  field,
  value: { type: "string", value },
  op: "add",
});

export const noteDatoms = (
  notes: readonly SeededNote[],
): readonly NoteDatom[] =>
  notes.flatMap((note) => [
    fact(note.entity, ":ramose/type", ":note"),
    fact(note.entity, ":note/title", note.title),
    fact(note.entity, ":note/rank", note.rank),
  ]);

/** The graph row whose name is the one path segment of the child database. */
export const workspaceDatoms = (entity: string): readonly NoteDatom[] => [
  fact(entity, ":ramose/type", ":workspace"),
  fact(entity, ":workspace/slug", "acme"),
  fact(entity, ":graph/catalog", "child"),
  fact(entity, ":graph/name", CHILD_PATH[0]),
];

export const REVISION = opaque("r");

export type SeededDatabase = {
  readonly identity: ReplicationIdentity;
  readonly datoms: readonly NoteDatom[];
  readonly graphPath?: readonly string[];
  /** Write the durable route observation a confirming session writes. */
  readonly observeRoute?: boolean;
  /** Whether a bearer binding is written, as a confirming session writes one. */
  readonly bind?: boolean;
};

export const childRouteSlot = (): Promise<string> =>
  stableReplicaRouteSlot(CHILD_LINEAGE);

const routeSlotOf = (entry: SeededDatabase): Promise<string> =>
  (entry.graphPath ?? []).length === 0
    ? rootReplicaRouteSlot()
    : stableReplicaRouteSlot(entry.identity.graphLineage);

/** Write the route observation a session writes once it confirms a child. */
export const observeChildRoute = async (
  name: string,
  identity: ReplicationIdentity,
): Promise<void> => {
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const address = replicationActivationAddress({
      server: OFFLINE, root: ROOT, graphPath: CHILD_PATH,
    });
    const slot = await childRouteSlot();
    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint(TOKEN, address, slot),
      identity,
      route: {
        scope: await replicaRouteScope(address),
        pathKey: await replicaRoutePathKey(CHILD_PATH),
        slot,
        graphPath: CHILD_PATH,
      },
    });
  } finally {
    storage.close();
  }
};

/** Install the snapshots and bearer bindings every tab opens against. */
export const seedDatabases = async (
  name: string,
  entries: readonly SeededDatabase[],
): Promise<void> => {
  const installed = await installClientCatalog(NotesCatalog);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    for (const entry of entries) {
      const identity = entry.identity;
      const graphPath = entry.graphPath ?? [];
      const snapshot = opaque("q");
      await storage.startSnapshot({
        type: "SnapshotStart", protocol: 1, identity, snapshot, revision: REVISION,
      });
      await storage.stageSnapshotChunk(snapshotChunk({
        type: "SnapshotChunk", protocol: 1, identity, snapshot, index: 0,
        datoms: entry.datoms,
      }));
      (await storage.commitSnapshot({
        type: "SnapshotCommit", protocol: 1, identity, snapshot, revision: REVISION,
        chunks: 1,
      }, installed.attributes))?.release();
      const address = replicationActivationAddress({
        server: OFFLINE, root: ROOT, graphPath,
      });
      if (entry.bind === false) continue;
      const routeSlot = await routeSlotOf(entry);
      await storage.bindAuthenticated({
        fingerprint: await replicationCredentialFingerprint(TOKEN, address, routeSlot),
        identity,
        ...(graphPath.length === 0
          ? {
            candidateKey: {
              selector: await replicationCacheSelector(CACHE_KEY, address),
              routeSlot,
            },
          }
          : {}),
        ...(graphPath.length > 0 && entry.observeRoute === true
          ? {
            route: {
              scope: await replicaRouteScope(address),
              pathKey: await replicaRoutePathKey(graphPath),
              slot: routeSlot,
              graphPath,
            },
          }
          : {}),
      });
    }
  } finally {
    storage.close();
  }
};

export const seed = (
  name: string,
  identity: ReplicationIdentity,
  notes: readonly SeededNote[],
): Promise<void> =>
  seedDatabases(name, [{ identity, datoms: noteDatoms(notes) }]);

type StartInput = {
  readonly storageName: string;
  readonly database: string;
};

type CommitInput = {
  readonly storageName: string;
  readonly database: string;
  readonly note: SeededNote;
  readonly from: string;
  readonly revision: string;
  /** A second change installed straight after, with no round trip between. */
  readonly then?: {
    readonly note: SeededNote;
    readonly revision: string;
  };
};

type HoldInput = StartInput & {
  readonly principal?: string;
  /** Confirm the one graph path below the root, at this lineage. */
  readonly lineage?: readonly string[];
};

type EnqueueInput = {
  readonly storageName: string;
  readonly database: string;
  readonly title: string;
  readonly child?: string;
  readonly count?: number;
};

type QueryReport = {
  readonly status: string;
  readonly titles: readonly string[];
  readonly pending: readonly boolean[];
};

type LoopReport = {
  readonly leadership: string;
  readonly passes: number;
  readonly planned: readonly string[];
  readonly overlapped: boolean;
  /** The graph path each unresolved receiver was durably recorded at. */
  readonly resolved: readonly string[];
  readonly retired: readonly string[];
};

let token: string | undefined = TOKEN;
let presented = 0;
let held: ReplicaLease | undefined;
let published: QueryReport[] = [];
let client: Client | undefined;
let database: ClientDatabase | undefined;
let notes: ReturnType<ClientDatabase["observe"]> | undefined;
let releaseNotes: (() => void) | undefined;
let storage: IndexedDbReplicaStorage | undefined;
let receipt: Receipt | undefined;
let releaseReceipt: (() => void) | undefined;
let receiptState: ReceiptState = { status: "pending" };
let leadership: SyncLeadership | undefined;
let loop: SubmissionLoop | undefined;
let passes = 0;
let planned: string[] = [];
let resolved: string[] = [];
let retired: string[] = [];
let inPass = false;
let overlapped = false;

type NoteHandle = {
  readonly data: { readonly title: string };
  readonly local: { readonly pending: boolean };
  readonly mutate: Record<string, (input: unknown) => Receipt>;
};

const rows = (): readonly NoteHandle[] => {
  const data = notes?.getSnapshot().data;
  return Array.isArray(data) ? data as readonly NoteHandle[] : [];
};

const report = (): QueryReport => ({
  status: notes?.getSnapshot().status ?? "absent",
  titles: rows().map((row) => row.data.title),
  pending: rows().map((row) => row.local.pending),
});

const open = (storageName: string): ClientDatabase => {
  client = createClient({
    url: OFFLINE,
    root: ROOT,
    catalog: NotesCatalog,
    auth: () => {
      presented++;
      if (token === undefined) throw new Error("the application has no session");
      return { token, cacheKey: CACHE_KEY };
    },
    storageName,
  });
  database = client.open();
  return database;
};

const observeNotes = (target: ClientDatabase): QueryReport => {
  const observed = target.observe(target.query.from(Note).orderBy(Note.rank));
  notes = observed;
  published = [report()];
  releaseNotes = observed.subscribe(() => published.push(report()));
  return report();
};

const heldStorage = async (name: string): Promise<IndexedDbReplicaStorage> => {
  storage ??= await IndexedDbReplicaStorage.open(name);
  return storage;
};

/** The tag of the failure a durable write was refused with, or `landed`. */
const outcome = async (run: () => Promise<void>): Promise<string> => {
  try {
    await run();
    return "landed";
  } catch (error) {
    const tag = (error as { readonly _tag?: unknown } | undefined)?._tag;
    return typeof tag === "string" ? tag : String(error);
  }
};

const rootAddress = (): ReturnType<typeof replicationActivationAddress> =>
  replicationActivationAddress({ server: OFFLINE, root: ROOT, graphPath: [] });

const draft = (
  receiver: ReplicaDatabaseScope,
  title: string,
): OutboxDraft => ({
  invocation: invocationId(),
  receiver,
  operation: {
    catalog: "propagation-notes" as never,
    owner: { kind: "entity", name: "note" },
    localName: "rename",
  },
  operationVersion: "b".repeat(64) as OperationVersion,
  target: { type: "none" },
  input: { title },
  allocations: [],
  inputRefs: [],
  enqueuedAt: Date.now(),
});

/** The tab entry point: `openTab` loads this module and calls it. */
export const serve = (id: string): void =>
  serveTab(id, {
    /**
     * Leave this realm without `BroadcastChannel`, which is the runtime a
     * browser too old for it gives every consumer here.
     */
    withoutBroadcasts: (): boolean => {
      Reflect.deleteProperty(globalThis, "BroadcastChannel");
      return (globalThis as { readonly BroadcastChannel?: unknown })
        .BroadcastChannel === undefined;
    },

    start: async ({ storageName }: StartInput): Promise<QueryReport> => {
      database = open(storageName);
      return observeNotes(database);
    },

    /** Observe the notes of the graph child one path segment down. */
    startChild: async ({ storageName }: StartInput): Promise<QueryReport> => {
      const root = open(storageName);
      return observeNotes(
        root.query.from(Workspace).where({ slug: "acme" }).one().db(),
      );
    },

    report: (): QueryReport => report(),

    /** Every value this tab's observers have published, in order. */
    published: (): readonly QueryReport[] => published,

    /** How many times this client has asked the application for a credential. */
    presented: (): number => presented,

    sync: (): string => client?.sync.getSnapshot().status ?? "absent",

    /** Present the bearer of another account the way a sign-in does. */
    signIn: ({ bearer }: { readonly bearer: string }): string => {
      token = bearer;
      return token;
    },

    /** Leave the application with no credential to activate with. */
    signOut: (): boolean => {
      token = undefined;
      return true;
    },

    /** Clear this principal's local data through the public API. */
    clearLocal: async (): Promise<string> => {
      await client!.clearLocalData();
      return client!.sync.getSnapshot().status;
    },

    /**
     * Take the admission a session takes when it opens, before it has an
     * authenticated identity to name a scope with.
     */
    admit: async ({ storageName }: StartInput): Promise<number> => {
      held = await (await heldStorage(storageName)).lease();
      return held.admittedAt();
    },

    /**
     * Confirm an authenticated identity under the admission held above, on
     * the root route or on the one graph path below it.
     */
    bindHeld: async (
      { storageName, database: id, principal, lineage }: HoldInput,
    ): Promise<string> => {
      const store = await heldStorage(storageName);
      const child = lineage !== undefined;
      const identity = await identityFor(id, lineage ?? [], principal ?? PRINCIPAL);
      const address = child
        ? replicationActivationAddress({
          server: OFFLINE,
          root: ROOT,
          graphPath: CHILD_PATH,
        })
        : rootAddress();
      const routeSlot = child
        ? await stableReplicaRouteSlot(lineage!)
        : await rootReplicaRouteSlot();
      const [fingerprint, selector, scope, pathKey] = await Promise.all([
        replicationCredentialFingerprint(token ?? TOKEN, address, routeSlot),
        replicationCacheSelector(CACHE_KEY, address),
        replicaRouteScope(address),
        replicaRoutePathKey(child ? CHILD_PATH : []),
      ]);
      return outcome(() =>
        store.bindAuthenticated({
          fingerprint,
          identity,
          candidateKey: { selector, routeSlot },
          route: {
            scope,
            pathKey,
            slot: routeSlot,
            ...(child ? { graphPath: CHILD_PATH } : {}),
          },
        }, { lease: held })
      );
    },

    /** Install a fresh snapshot under the admission held above. */
    installHeld: async (
      { storageName, database: id, note }: HoldInput & {
        readonly note: SeededNote;
      },
    ): Promise<string> => {
      const store = await heldStorage(storageName);
      const identity = await identityFor(id);
      const snapshot = opaque("h");
      const revision = opaque("i");
      return outcome(async () => {
        await store.startSnapshot({
          type: "SnapshotStart", protocol: 1, identity, snapshot, revision,
        }, { lease: held });
        await store.stageSnapshotChunk(snapshotChunk({
          type: "SnapshotChunk", protocol: 1, identity, snapshot, index: 0,
          datoms: noteDatoms([note]),
        }), { lease: held });
        (await store.commitSnapshot({
          type: "SnapshotCommit", protocol: 1, identity, snapshot, revision, chunks: 1,
        }, (await installClientCatalog(NotesCatalog)).attributes, {
          lease: held,
        }))?.release();
      });
    },

    /** Evict one graph child database, which no public API exposes. */
    evict: async (
      { storageName, database: id }: StartInput,
    ): Promise<string> => {
      const store = await heldStorage(storageName);
      const identity = await identityFor(id, CHILD_LINEAGE);
      return outcome(async () => {
        await store.evictDatabase(replicaDatabaseScopeOf(identity));
      });
    },

    /** The graph path this receiver database was last confirmed at. */
    receiverPath: async (
      { storageName, database: id }: StartInput,
    ): Promise<readonly string[]> => {
      const store = await heldStorage(storageName);
      const identity = await identityFor(id, CHILD_LINEAGE);
      const record = await store.graphReceiver(replicaDatabaseScopeOf(identity));
      return record?.graphPath ?? [];
    },

    /** How much of one database a restore found, or `-1` when it found none. */
    restoreOnce: async (
      { storageName, database: id, lineage }: StartInput & {
        readonly lineage?: readonly string[];
      },
    ): Promise<number> => {
      const store = await heldStorage(storageName);
      const installed = await installClientCatalog(NotesCatalog);
      const restored = await store.restore(
        await identityFor(id, lineage ?? []),
        installed.attributes,
        installed.readCompatibilityHash,
      ).catch(() => undefined);
      if (restored === undefined) return -1;
      const found = restored.handles.size;
      restored.release();
      return found;
    },

    /**
     * Restore one database until it is gone, reporting how much of it each
     * attempt found.
     */
    probeRestores: async (
      { storageName, database: id, lineage }: StartInput & {
        readonly lineage?: readonly string[];
      },
    ): Promise<readonly number[]> => {
      const store = await heldStorage(storageName);
      const installed = await installClientCatalog(NotesCatalog);
      const identity = await identityFor(id, lineage ?? []);
      const found: number[] = [];
      const deadline = performance.now() + 4_000;
      for (;;) {
        const restored = await store.restore(
          identity,
          installed.attributes,
          installed.readCompatibilityHash,
        ).catch(() => undefined);
        if (restored === undefined) return found;
        found.push(restored.handles.size);
        restored.release();
        if (performance.now() > deadline) return found;
      }
    },

    /** Rename through the public API, which enqueues durably in any tab. */
    rename: async (
      { from, to }: { readonly from: string; readonly to: string },
    ): Promise<string> => {
      const target = rows().find((row) => row.data.title === from);
      if (target === undefined) throw new Error(`no note titled ${from}`);
      const issued = target.mutate.rename!({ title: to });
      receipt = issued;
      receiptState = issued.getSnapshot();
      releaseReceipt = issued.subscribe(() => {
        receiptState = issued.getSnapshot();
      });
      await issued.queued;
      return issued.invocation;
    },

    receipt: (): string => receiptState.status,

    /** Install a durable change the way a leader's own stream installs one. */
    commit: async (
      { storageName, database: id, note, from, revision, then }: CommitInput,
    ): Promise<string> => {
      const opened = await heldStorage(storageName);
      const identity = await identityFor(id);
      const install = async (
        base: string,
        at: string,
        seeded: SeededNote,
      ): Promise<string> => {
        const installed = await opened.applyChange(changeFrame({
          type: "Change", protocol: 1, identity, from: base, revision: at,
          datoms: noteDatoms([seeded]),
        }));
        const landed = installed?.revision ?? "";
        installed?.release();
        return landed;
      };
      const first = await install(from, revision, note);
      return then === undefined
        ? first
        : await install(revision, then.revision, then.note);
    },

    /** Queue work for a receiver database without submitting it. */
    enqueue: async (
      { storageName, database: id, title, child, count }: EnqueueInput,
    ): Promise<number> => {
      const opened = await heldStorage(storageName);
      const identity = await identityFor(id);
      const receiver = child === undefined
        ? replicaDatabaseScopeOf(identity)
        : { ...replicaDatabaseScopeOf(identity), database: child };
      const queued = Array.from({ length: count ?? 1 }, () =>
        opened.outbox().enqueue(draft(receiver, title), {
          scope: replicaScopeOf(identity),
        }));
      await Promise.all(queued);
      return queued.length;
    },

    /**
     * Stand for the scope's leadership and run the submission passes a leader
     * runs, recording what each pass planned for.
     */
    lead: async (
      { storageName, database: id }: StartInput,
    ): Promise<LoopReport> => {
      const opened = await heldStorage(storageName);
      const identity = await identityFor(id);
      const scope = replicaScopeOf(identity);
      const key = replicaLeaderKey(replicaDatabaseScopeOf(identity), storageName);
      const standing = SyncLeadership.begin({
        name: key,
        locks: platformLocks(),
        claim: () => opened.claimLeadership(key, scope),
        onLeading: () => loop?.request(scope),
      });
      leadership = standing;
      loop = new SubmissionLoop({
        storage: () => Promise.resolve(opened),
        leadership: () => standing,
        credential: async () => {
          overlapped ||= inPass;
          inPass = true;
          passes++;
          await Promise.resolve();
          inPass = false;
          return { token: TOKEN, cacheKey: CACHE_KEY };
        },
        endpoint: (receiver) => {
          planned.push(receiver.database);
          return undefined;
        },
        resolve: (receiver) => {
          void opened.graphReceiver(receiver).then((record) => {
            if (record !== undefined) resolved.push(record.graphPath.join("/"));
          });
        },
        retire: (receiver) => {
          retired.push(receiver.database);
        },
        revalidate: () => Promise.resolve(),
        reconcile: () => Promise.resolve(),
        live: () => true,
      });
      opened.notices((notice) => {
        if (notice.kind === "layer") loop?.request(scope);
      });
      return {
        leadership: standing.status(),
        passes,
        planned: [...planned],
        overlapped,
        resolved: [...resolved],
        retired: [...retired],
      };
    },

    loop: (): LoopReport => ({
      leadership: leadership?.status() ?? "absent",
      passes,
      planned: [...planned],
      overlapped,
      resolved: [...resolved],
      retired: [...retired],
    }),

    settle: async (): Promise<LoopReport> => {
      await loop?.settled();
      return {
        leadership: leadership?.status() ?? "absent",
        passes,
        planned: [...planned],
        overlapped,
        resolved: [...resolved],
        retired: [...retired],
      };
    },

    close: async (): Promise<QueryReport> => {
      const snapshot = report();
      releaseNotes?.();
      releaseReceipt?.();
      loop?.close();
      await leadership?.release();
      await client?.close();
      storage?.close();
      client = undefined;
      database = undefined;
      notes = undefined;
      storage = undefined;
      receipt = undefined;
      return snapshot;
    },
  });
