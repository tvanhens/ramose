import * as EffectSchema from "effect/Schema";
import {
  Entity,
  Field,
  Schema,
  string,
} from "../../packages/ramose/src/db/internal.ts";
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
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import {
  platformLocks,
  replicaLeaderKey,
  SyncLeadership,
} from "../../packages/ramose/src/internal/replication/leadership.ts";
import { SubmissionLoop } from "../../packages/ramose/src/client/submission.ts";
import { rootReplicaRouteSlot } from "../../packages/ramose/src/internal/replication/route-slot.ts";
import {
  replicationActivationAddress,
  replicationCacheSelector,
  replicationCredentialFingerprint,
} from "../../packages/ramose/src/internal/replication/transport.ts";
import { changeFrame, snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";
import type { Receipt, ReceiptState } from "../../packages/ramose/src/client/receipt.ts";
import { serveTab } from "./tab-harness.ts";

const OFFLINE = "http://127.0.0.1:1";
const ROOT = "app";
const TOKEN = "bearer-a";
const CACHE_KEY = "account-a";

export const opaque = (character: string): string => character.repeat(43);

const Note = Entity("note", {
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

const NotesSchema = Schema("propagation-notes", { note: Note });
NotesSchema.applyPolicy(() => {});

type SeededNote = {
  readonly entity: string;
  readonly title: string;
  readonly rank: string;
};

const PRINCIPAL = opaque("p");

export const identityFor = async (
  database: string,
): Promise<ReplicationIdentity> => ({
  version: 1,
  server: opaque("s"),
  principal: PRINCIPAL,
  database,
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: (await installClientCatalog(NotesSchema))
    .readCompatibilityHash,
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

export const REVISION = opaque("r");

const rootAddress = (): ReturnType<typeof replicationActivationAddress> =>
  replicationActivationAddress({ server: OFFLINE, root: ROOT });

export const seed = async (
  name: string,
  identity: ReplicationIdentity,
  notes: readonly SeededNote[],
): Promise<void> => {
  const installed = await installClientCatalog(NotesSchema);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const snapshot = opaque("q");
    await storage.startSnapshot({
      type: "SnapshotStart", protocol: 4, identity, snapshot, revision: REVISION,
    });
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk", protocol: 4, identity, snapshot, index: 0,
      datoms: noteDatoms(notes),
    }));
    (await storage.commitSnapshot({
      type: "SnapshotCommit", protocol: 4, identity, snapshot, revision: REVISION,
      ordinal: 1,
      settled: 0,
      chunks: 1,
    }, installed.attributes))?.release();
    const address = rootAddress();
    const routeSlot = await rootReplicaRouteSlot();
    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint(TOKEN, address, routeSlot),
      identity,
      candidateKey: {
        selector: await replicationCacheSelector(CACHE_KEY, address),
        routeSlot,
      },
    });
  } finally {
    storage.close();
  }
};

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
  readonly then?: {
    readonly note: SeededNote;
    readonly revision: string;
  };
};

type EnqueueInput = {
  readonly storageName: string;
  readonly database: string;
  readonly title: string;
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
};

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
    catalog: NotesSchema,
    auth: () => ({ token: TOKEN, cacheKey: CACHE_KEY }),
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

const openStorage = async (name: string): Promise<IndexedDbReplicaStorage> => {
  storage ??= await IndexedDbReplicaStorage.open(name);
  return storage;
};

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

const loopReport = (): LoopReport => ({
  leadership: leadership?.status() ?? "absent",
  passes,
  planned: [...planned],
  overlapped,
});

export const serve = (id: string): void =>
  serveTab(id, {
    withoutBroadcasts: (): boolean => {
      Reflect.deleteProperty(globalThis, "BroadcastChannel");
      return (globalThis as { readonly BroadcastChannel?: unknown })
        .BroadcastChannel === undefined;
    },

    start: async ({ storageName }: StartInput): Promise<QueryReport> => {
      database = open(storageName);
      return observeNotes(database);
    },

    report: (): QueryReport => report(),

    published: (): readonly QueryReport[] => published,

    sync: (): string => client?.sync.getSnapshot().status ?? "absent",

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

    commit: async (
      { storageName, database: id, note, from, revision, then }: CommitInput,
    ): Promise<string> => {
      const opened = await openStorage(storageName);
      const identity = await identityFor(id);
      const install = async (
        base: string,
        at: string,
        seeded: SeededNote,
      ): Promise<string> => {
        const installed = await opened.applyChange(changeFrame({
          type: "Change", protocol: 4, identity, from: base, revision: at,
          ordinal: 2,
          settled: 0,
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

    enqueue: async (
      { storageName, database: id, title, count }: EnqueueInput,
    ): Promise<number> => {
      const opened = await openStorage(storageName);
      const identity = await identityFor(id);
      const receiver = replicaDatabaseScopeOf(identity);
      const queued = Array.from({ length: count ?? 1 }, () =>
        opened.outbox().enqueue(draft(receiver, title), {
          scope: replicaScopeOf(identity),
        }));
      await Promise.all(queued);
      return queued.length;
    },

    lead: async (
      { storageName, database: id }: StartInput,
    ): Promise<LoopReport> => {
      const opened = await openStorage(storageName);
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
        resolve: () => {},
        retire: () => {},
        revalidate: () => Promise.resolve(),
        reconcile: () => Promise.resolve(),
        live: () => true,
      });
      opened.notices((notice) => {
        if (notice.kind === "layer") loop?.request(scope);
      });
      return loopReport();
    },

    loop: (): LoopReport => loopReport(),

    settle: async (): Promise<LoopReport> => {
      await loop?.settled();
      return loopReport();
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
