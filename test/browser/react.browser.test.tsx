import {
  act,
  memo,
  StrictMode,
  Suspense,
  useState,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect } from "vitest";
import * as EffectSchema from "effect/Schema";
import {
  Entity,
  Field,
  Ref,
  Schema,
  string,
} from "../../packages/ramose/src/db/internal.ts";
import {
  createClient,
  type Client,
  type ClientDatabase,
  type Receipt,
} from "../../packages/ramose/src/client/index.ts";
import { installClientCatalog } from "../../packages/ramose/src/client/catalog.ts";
import {
  RamoseProvider,
  useDb,
  useQuery,
  useReceipt,
  useSuspenseQuery,
  useSyncState,
  type QueryState,
  type ReceiptView,
} from "../../packages/ramose/src/react/index.ts";
import {
  heldStoreCount,
  UNCLAIMED_LIMIT,
} from "../../packages/ramose/src/react/store.ts";
import { suspendedQueryCount } from "../../packages/ramose/src/react/suspense.ts";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type {
  ReplicationIdentity,
  SnapshotDatom,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import { rootReplicaRouteSlot } from "../../packages/ramose/src/internal/replication/route-slot.ts";
import {
  replicationActivationAddress,
  replicationCacheSelector,
  replicationCredentialFingerprint,
} from "../../packages/ramose/src/internal/replication/transport.ts";
import recorded from "./frames/optimistic-fence.client.json";
import { browserTest } from "./fixtures.ts";
import { snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const Note = Entity("note", {
  title: Field.unique(string(), "strict"),
  rank: string(),
}, {
  operations: (Operation) => ({
    createNote: Operation({
      self: false,
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});
const Notes = Schema("react-notes", { note: Note });
Notes.applyPolicy(() => {});

const OFFLINE = "http://127.0.0.1:1";
const ROOT = "app";
const TOKEN = "bearer-a";
const CACHE_KEY = "account-a";

const opaque = (character: string): string => character.repeat(43);

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

type SeededNote = { readonly entity: string; readonly title: string; readonly rank: string };

const seed = async (
  name: string,
  notes: readonly SeededNote[],
): Promise<ReplicationIdentity> => {
  const installed = await installClientCatalog(Notes);
  const identity: ReplicationIdentity = {
    version: 1,
    server: opaque("s"),
    principal: opaque("p"),
    database: opaque("d"),
    catalog: opaque("c"),
    readView: opaque("v"),
    readCompatibilityHash: installed.readCompatibilityHash,
    graphLineage: [],
    authenticator: opaque("a"),
  };
  const datoms: readonly SnapshotDatom[] = notes.flatMap((note) => [
    { entity: note.entity, field: ":ramose/type", value: { type: "string", value: ":note" }, op: "add" },
    { entity: note.entity, field: ":note/title", value: { type: "string", value: note.title }, op: "add" },
    { entity: note.entity, field: ":note/rank", value: { type: "string", value: note.rank }, op: "add" },
  ] as const);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const snapshot = opaque("q");
    const revision = opaque("r");
    await storage.startSnapshot({ type: "SnapshotStart", protocol: 1, identity, snapshot, revision });
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity, snapshot, index: 0, datoms,
    }));
    const committed = await storage.commitSnapshot({
      type: "SnapshotCommit", protocol: 1, identity, snapshot, revision, chunks: 1,
    }, installed.attributes);
    expect(committed).toBeDefined();
    committed!.release();
    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint(
        TOKEN,
        replicationActivationAddress({ server: OFFLINE, root: ROOT, graphPath: [] }),
        await rootReplicaRouteSlot(),
      ),
      identity,
      candidateKey: {
        selector: await replicationCacheSelector(
          CACHE_KEY,
          replicationActivationAddress({ server: OFFLINE, root: ROOT, graphPath: [] }),
        ),
        routeSlot: await rootReplicaRouteSlot(),
      },
    });
  } finally {
    storage.close();
  }
  return identity;
};

const offlineClient = (name: string): Client =>
  createClient({
    url: OFFLINE,
    root: ROOT,
    catalog: Notes,
    auth: () => ({ token: TOKEN, cacheKey: CACHE_KEY }),
    storageName: name,
  });

const mount = async (container: HTMLElement, node: ReactNode): Promise<Root> => {
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return root;
};

const unmount = async (root: Root): Promise<void> => {
  await act(async () => {
    root.unmount();
  });
};

const until = async (accept: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!accept()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
};

type Row = { readonly title: string };
type Rows = QueryState<readonly Row[]>;

const useTitles = (): Rows =>
  useQuery(
    useDb().query.from(Note).orderBy(Note.rank).select({ title: Note.title }),
  ) as Rows;

const Titles = ({ seen }: { readonly seen: Rows[] }): ReactNode => {
  const state = useTitles();
  seen.push(state);
  if (state.status === "pending") return <p>pending</p>;
  if (state.status === "error") return <p>error</p>;
  return (
    <ul>
      {state.data.map((row) => <li key={row.title}>{row.title}</li>)}
    </ul>
  );
};

const text = (container: HTMLElement): string => container.textContent ?? "";

browserTest("renders a restored offline replica and releases it on unmount", async ({ browser }) => {
  const name = `ramose-react-offline-${browser.uniqueId}`;
  await seed(name, [
    { entity: opaque("e"), title: "second", rank: "b" },
    { entity: opaque("f"), title: "first", rank: "a" },
  ]);
  const client = offlineClient(name);
  const db = client.open();
  try {
    const seen: Rows[] = [];
    const root = await mount(
      browser.root,
      <RamoseProvider client={client}><Titles seen={seen} /></RamoseProvider>,
    );

    await until(() => text(browser.root) !== "pending", "the restored replica");
    expect(text(browser.root)).toBe("firstsecond");

    expect(seen.at(-1)!.status).toBe("stale");
    expect(seen[0]!.status).toBe("pending");

    expect(heldStoreCount(db)).toBe(1);

    expect(new Set(seen).size).toBeLessThanOrEqual(2);

    await unmount(root);

    expect(heldStoreCount(db)).toBe(0);
    expect(client.sync.getSnapshot().status).not.toBe("closed");
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("shares one store, one observation and one snapshot across components", async ({ browser }) => {
  const name = `ramose-react-shared-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "shared", rank: "a" }]);
  const client = offlineClient(name);
  const db = client.open();
  try {
    const left: Rows[] = [];
    const right: Rows[] = [];
    const root = await mount(
      browser.root,
      <RamoseProvider client={client}>
        <Titles seen={left} />
        <Titles seen={right} />
      </RamoseProvider>,
    );
    await until(() => text(browser.root) === "sharedshared", "both components");

    expect(heldStoreCount(db)).toBe(1);
    expect(left.at(-1)).toBe(right.at(-1));

    await unmount(root);
    expect(heldStoreCount(db)).toBe(0);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("Strict Mode neither duplicates the observation nor flashes pending", async ({ browser }) => {
  const name = `ramose-react-strict-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "strict", rank: "a" }]);
  const client = offlineClient(name);
  const db = client.open();
  try {
    const seen: Rows[] = [];
    const root = await mount(
      browser.root,
      <StrictMode>
        <RamoseProvider client={client}><Titles seen={seen} /></RamoseProvider>
      </StrictMode>,
    );
    await until(() => text(browser.root) !== "pending", "the restored replica");
    expect(text(browser.root)).toBe("strict");

    expect(heldStoreCount(db)).toBe(1);

    const settled = seen.findIndex((state) => state.status !== "pending");
    expect(settled).toBeGreaterThanOrEqual(0);
    expect(seen.slice(settled).every((state) => state.status === "stale")).toBe(true);

    await unmount(root);
    expect(heldStoreCount(db)).toBe(0);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("a remount resumes what it was showing instead of flashing pending", async ({ browser }) => {
  const name = `ramose-react-remount-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "kept", rank: "a" }]);
  const client = offlineClient(name);
  const db = client.open();
  try {
    const first: Rows[] = [];
    const root = await mount(
      browser.root,
      <RamoseProvider client={client}><Titles seen={first} /></RamoseProvider>,
    );
    await until(() => text(browser.root) === "kept", "the first mount");
    await unmount(root);
    expect(heldStoreCount(db)).toBe(0);

    const second: Rows[] = [];
    const again = await mount(
      browser.root,
      <RamoseProvider client={client}><Titles seen={second} /></RamoseProvider>,
    );
    expect(second[0]!.status).toBe("stale");
    expect(second.every((state) => state.status !== "pending")).toBe(true);
    expect(text(browser.root)).toBe("kept");
    await unmount(again);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("unmounting one consumer leaves the other observing", async ({ browser }) => {
  const name = `ramose-react-partial-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "kept", rank: "a" }]);
  const client = offlineClient(name);
  const db = client.open();
  try {
    const kept: Rows[] = [];
    const left = await mount(
      browser.root,
      <RamoseProvider client={client}><Titles seen={kept} /></RamoseProvider>,
    );
    const other = document.createElement("div");
    document.body.appendChild(other);
    const right = await mount(
      other,
      <RamoseProvider client={client}><Titles seen={[]} /></RamoseProvider>,
    );
    await until(() => text(browser.root) === "kept" && text(other) === "kept", "both trees");

    await unmount(right);
    other.remove();

    expect(heldStoreCount(db)).toBe(1);
    expect(text(browser.root)).toBe("kept");
    expect(client.sync.getSnapshot().status).not.toBe("closed");

    await unmount(left);
    expect(heldStoreCount(db)).toBe(0);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("reads an explicitly passed database, with no provider in the tree", async ({ browser }) => {
  const name = `ramose-react-explicit-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "explicit", rank: "a" }]);
  const client = offlineClient(name);
  const db = client.open();
  try {
    const Direct = ({ database }: { readonly database: ClientDatabase }): ReactNode => {
      const state = useQuery(
        database.query.from(Note).orderBy(Note.rank).select({ title: Note.title }),
        database,
      ) as Rows;
      const sync = useSyncState(client);
      return <p>{state.status === "stale" || state.status === "ready"
        ? state.data.map((row) => row.title).join()
        : state.status}:{sync.status}</p>;
    };
    const root = await mount(browser.root, <Direct database={db} />);
    await until(() => text(browser.root).startsWith("explicit"), "the explicit database");
    await unmount(root);
    expect(heldStoreCount(db)).toBe(0);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("useSyncState re-renders on a status change and on nothing else", async ({ browser }) => {
  const name = `ramose-react-sync-${browser.uniqueId}`;
  await seed(name, [{ entity: opaque("e"), title: "watched", rank: "a" }]);
  const client = offlineClient(name);
  try {
    const statuses: string[] = [];
    const states: unknown[] = [];
    const Status = (): ReactNode => {
      const sync = useSyncState();
      statuses.push(sync.status);
      states.push(sync);
      return <span>{sync.status}</span>;
    };

    const root = await mount(
      browser.root,
      <RamoseProvider client={client}>
        <Titles seen={[]} />
        <Status />
      </RamoseProvider>,
    );
    await until(() => statuses.at(-1) === "offline", "the offline status");

    expect(statuses).toEqual([...new Set(statuses)]);
    expect(new Set(states).size).toBe(new Set(statuses).size);

    expect(statuses.at(-1)).toBe("offline");
    expect(statuses.length).toBeLessThanOrEqual(3);
    await unmount(root);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

const ConformanceUser = Entity("conformanceUser", {
  sub: Field.unique(string(), "strict"),
  access: string({ default: () => "enabled" }),
});
const ConformanceIssue = Entity("conformanceIssue", {
  key: Field.unique(string(), "strict"),
  title: string(),
  owner: Ref(ConformanceUser),
  org: string(),
  parent: Field(Ref.self, { optional: true }),
  audit: string({ optional: true }),
});
const ConformanceSchema = Schema("local-conformance", {
  conformanceUser: ConformanceUser,
  conformanceIssue: ConformanceIssue,
});
ConformanceSchema.applyPolicy(() => {});

const recordedClient = (name: string): Client =>
  createClient({
    url: globalThis.location.origin,

    root: "optimistic-fence",
    catalog: ConformanceSchema,
    auth: () => ({ token: "session-credential", cacheKey: "recorded" }),
    storageName: name,
  });

browserTest("a committed value arriving over the session re-renders a mounted component", async ({ browser }) => {
  const name = `ramose-react-live-${browser.uniqueId}`;
  const client = recordedClient(name);
  const db = client.open();
  try {
    const seen: QueryState<readonly { readonly title: string }[]>[] = [];
    const Issues = (): ReactNode => {
      const state = useQuery(
        useDb().query.from(ConformanceIssue).select({ title: ConformanceIssue.title }),
      ) as QueryState<readonly { readonly title: string }[]>;
      seen.push(state);
      return <span>{state.status === "ready" ? String(state.data.length) : state.status}</span>;
    };
    const root = await mount(
      browser.root,
      <RamoseProvider client={client}><Issues /></RamoseProvider>,
    );

    expect(seen[0]!.status).toBe("pending");
    await until(() => seen.at(-1)!.status === "ready", "the committed value");

    const ready = seen.at(-1)!;
    expect(ready.status).toBe("ready");
    expect((ready as { data: readonly unknown[] }).data.length).toBeGreaterThan(0);
    expect(text(browser.root)).not.toBe("pending");
    await unmount(root);
    expect(heldStoreCount(db)).toBe(0);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest("a stale→ready confirmation does not re-render a child memoized on data", async ({ browser }) => {
  const name = `ramose-react-memo-${browser.uniqueId}`;
  const installed = await installClientCatalog(ConformanceSchema);

  const identity = recorded.identity as unknown as ReplicationIdentity;
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const snapshot = opaque("q");
    const revision = opaque("r");
    const entity = opaque("z");
    await storage.startSnapshot({ type: "SnapshotStart", protocol: 1, identity, snapshot, revision });
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity, snapshot, index: 0,
      datoms: [
        { entity, field: ":ramose/type", value: { type: "string", value: ":conformanceIssue" }, op: "add" },
        { entity, field: ":conformanceIssue/title", value: { type: "string", value: "restored" }, op: "add" },
      ],
    }));
    (await storage.commitSnapshot({
      type: "SnapshotCommit", protocol: 1, identity, snapshot, revision, chunks: 1,
    }, installed.attributes))!.release();
    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint(
        "session-credential",
        replicationActivationAddress({
          server: globalThis.location.origin, root: "optimistic-fence", graphPath: [],
        }),
        await rootReplicaRouteSlot(),
      ),
      identity,
    });
  } finally {
    storage.close();
  }

  const client = recordedClient(name);
  const db = client.open();
  try {

    let parentStatus = "";
    const childRenderedUnder: string[] = [];
    const Rows = memo(({ rows }: { readonly rows: readonly unknown[] }): ReactNode => {
      childRenderedUnder.push(parentStatus);
      return <span>{rows.length}</span>;
    });
    const seen: string[] = [];
    const Board = (): ReactNode => {

      const state = useQuery(
        useDb().query.from(ConformanceIssue)
          .where({ key: "no-such-issue" })
          .select({ title: ConformanceIssue.title }),
      ) as QueryState<readonly unknown[]>;
      seen.push(state.status);
      parentStatus = state.status;
      if (state.status === "pending" || state.status === "error") return <span>{state.status}</span>;
      return <Rows rows={state.data} />;
    };
    const root = await mount(
      browser.root,
      <RamoseProvider client={client}><Board /></RamoseProvider>,
    );
    await until(() => seen.at(-1) === "ready", "the session's confirmation");

    expect(seen).toContain("stale");
    expect(seen.indexOf("stale")).toBeLessThan(seen.lastIndexOf("ready"));

    expect(childRenderedUnder).toEqual(["stale"]);
    await unmount(root);
    expect(heldStoreCount(db)).toBe(0);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

type Seen = ReceiptView[];

const distinct = (seen: Seen): readonly string[] =>
  seen.map((state) => state.status)
    .filter((status, index, all) => status !== all[index - 1]);

const Invocation = (
  { receipt, seen }: {
    readonly receipt?: Receipt | null;
    readonly seen: Seen;
  },
): ReactNode => {
  const state = useReceipt(receipt);
  seen.push(state);
  return <span>{state.status}</span>;
};

const Composer = (
  { db, seen, created }: {
    readonly db: ClientDatabase;
    readonly seen: Seen;
    readonly created: Receipt[];
  },
): ReactNode => {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const state = useReceipt(receipt);
  seen.push(state);
  return (
    <button
      onClick={() => {
        const started = db.mutate.createNote({ title: "Written offline" });
        created.push(started);
        setReceipt(started);
      }}
    >
      {state.status}
    </button>
  );
};

const press = async (container: HTMLElement): Promise<void> => {
  const button = container.querySelector("button");
  expect(button).not.toBeNull();
  await act(() => {
    button!.click();
  });
};

const settle = async (
  client: Client,
  identity: ReplicationIdentity,
  state: unknown,
): Promise<void> => {
  await act(async () => {
    await (client as unknown as {
      submissions: () => {
        settle: (progress: readonly unknown[]) => Promise<void>;
      };
    }).submissions().settle([{
      partition: "react",
      receiver: {
        server: identity.server,
        principal: identity.principal,
        database: identity.database,
      },
      state,
    }]);
  });
};

browserTest(
  "a receipt renders idle, pending, queued and then committed",
  async ({ browser }) => {
    const name = `ramose-react-receipt-${browser.uniqueId}`;
    const identity = await seed(name, [
      { entity: opaque("e"), title: "seeded", rank: "a" },
    ]);
    const client = offlineClient(name);
    try {
      const db = client.open();
      const seen: Seen = [];
      const created: Receipt[] = [];
      const root = await mount(
        browser.root,
        <Composer db={db} seen={seen} created={created} />,
      );
      expect(text(browser.root)).toBe("idle");

      await press(browser.root);
      expect(text(browser.root)).toBe("pending");

      await until(() => text(browser.root) === "queued", "the durable outbox row");

      const receipt = created[0]!;
      await settle(client, identity, {
        _tag: "Committed",
        invocation: receipt.invocation,
      });

      expect(text(browser.root)).toBe("committed");
      expect(distinct(seen)).toEqual(["idle", "pending", "queued", "committed"]);
      expect(receipt.getSnapshot().status).toBe("committed");

      await unmount(root);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest("a refused invocation renders rejected with its code", async ({ browser }) => {
  const name = `ramose-react-rejected-${browser.uniqueId}`;
  const identity = await seed(name, [
    { entity: opaque("e"), title: "seeded", rank: "a" },
  ]);
  const client = offlineClient(name);
  try {
    const db = client.open();
    const seen: Seen = [];
    const created: Receipt[] = [];
    const root = await mount(
      browser.root,
      <Composer db={db} seen={seen} created={created} />,
    );
    await press(browser.root);
    await until(() => text(browser.root) === "queued", "the durable outbox row");

    await settle(client, identity, {
      _tag: "Rejected",
      invocation: created[0]!.invocation,
      code: "operation_rejected",
    });

    expect(text(browser.root)).toBe("rejected");
    const last = seen.at(-1)!;
    expect(last.status).toBe("rejected");
    expect((last as { readonly error: { readonly code: string } }).error.code)
      .toBe("operation_rejected");
    expect(distinct(seen)).toEqual(["idle", "pending", "queued", "rejected"]);

    await unmount(root);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

browserTest(
  "an invocation that never reached the outbox renders failed",
  async ({ browser }) => {
    const name = `ramose-react-failed-${browser.uniqueId}`;
    const client = createClient({
      url: OFFLINE,
      root: ROOT,
      catalog: Notes,
      auth: () => {
        throw new Error("refresh token expired");
      },
      storageName: name,
    });
    try {
      const db = client.open();
      const seen: Seen = [];
      const created: Receipt[] = [];
      const root = await mount(
        browser.root,
        <Composer db={db} seen={seen} created={created} />,
      );
      await press(browser.root);
      expect(text(browser.root)).toBe("pending");

      await until(() => text(browser.root) === "failed", "the pre-queue failure");
      expect(distinct(seen)).toEqual(["idle", "pending", "failed"]);
      expect((seen.at(-1) as { readonly error: Error }).error)
        .toBeInstanceOf(Error);

      await unmount(root);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "Strict Mode does not duplicate an invocation or lose its transitions",
  async ({ browser }) => {
    const name = `ramose-react-receipt-strict-${browser.uniqueId}`;
    const identity = await seed(name, [
      { entity: opaque("e"), title: "seeded", rank: "a" },
    ]);
    const client = offlineClient(name);
    try {
      const db = client.open();
      const seen: Seen = [];
      const created: Receipt[] = [];
      const root = await mount(
        browser.root,
        <StrictMode>
          <Composer db={db} seen={seen} created={created} />
        </StrictMode>,
      );
      await press(browser.root);
      expect(created).toHaveLength(1);
      await until(() => text(browser.root) === "queued", "the durable outbox row");

      await settle(client, identity, {
        _tag: "Committed",
        invocation: created[0]!.invocation,
      });

      expect(distinct(seen)).toEqual(["idle", "pending", "queued", "committed"]);
      expect(text(browser.root)).toBe("committed");
      await unmount(root);

      const resumed: Seen = [];
      const again = await mount(
        browser.root,
        <StrictMode>
          <Invocation receipt={created[0]!} seen={resumed} />
        </StrictMode>,
      );
      expect(distinct(resumed)).toEqual(["committed"]);
      await unmount(again);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "two components mounting together into a warm observation share one store",
  async ({ browser }) => {
    const name = `ramose-react-warm-${browser.uniqueId}`;
    await seed(name, [{ entity: opaque("e"), title: "warm", rank: "a" }]);
    const client = offlineClient(name);
    const db = client.open();
    try {
      const warming: Rows[] = [];
      const warm = await mount(
        browser.root,
        <RamoseProvider client={client}><Titles seen={warming} /></RamoseProvider>,
      );
      await until(() => text(browser.root) === "warm", "the first observation");
      await unmount(warm);
      expect(heldStoreCount(db)).toBe(0);

      const left: Rows[] = [];
      const right: Rows[] = [];
      const root = await mount(
        browser.root,
        <RamoseProvider client={client}>
          <Titles seen={left} />
          <Titles seen={right} />
        </RamoseProvider>,
      );

      expect(left[0]!.status).not.toBe("pending");
      expect(left[0]).toBe(right[0]);
      expect(heldStoreCount(db)).toBe(1);
      expect(text(browser.root)).toBe("warmwarm");

      await unmount(root);
      expect(heldStoreCount(db)).toBe(0);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

const SuspendedTitles = (
  { seen, where }: {
    readonly seen: Rows[];
    readonly where?: string | undefined;
  },
): ReactNode => {
  const all = useDb().query.from(Note).orderBy(Note.rank);
  const state = useSuspenseQuery(
    (where === undefined ? all : all.where({ rank: where }))
      .select({ title: Note.title }),
  ) as Rows;
  seen.push(state);
  if (state.status === "pending") return <p>nothing-cached</p>;
  if (state.status === "error") return <p>error</p>;
  return (
    <ul>
      {state.data.map((row) => <li key={row.title}>{row.title}</li>)}
    </ul>
  );
};

const Waiting = (
  { client, seen, where }: {
    readonly client: Client;
    readonly seen: Rows[];
    readonly where?: string | undefined;
  },
): ReactNode => (
  <RamoseProvider client={client}>
    <Suspense fallback={<p>loading</p>}>
      <SuspendedTitles seen={seen} where={where} />
    </Suspense>
  </RamoseProvider>
);

browserTest(
  "useSuspenseQuery waits for the first local answer and then renders it",
  async ({ browser }) => {
    const name = `ramose-react-suspense-${browser.uniqueId}`;
    await seed(name, [
      { entity: opaque("e"), title: "second", rank: "b" },
      { entity: opaque("f"), title: "first", rank: "a" },
    ]);
    const client = offlineClient(name);
    const db = client.open();
    try {
      const seen: Rows[] = [];
      const root = await mount(browser.root, <Waiting client={client} seen={seen} />);

      expect(text(browser.root)).toBe("loading");
      expect(seen).toHaveLength(0);

      await until(() => text(browser.root) !== "loading", "the restored replica");

      expect(text(browser.root)).toBe("firstsecond");
      expect(seen.at(-1)!.status).toBe("stale");
      expect(heldStoreCount(db)).toBe(1);
      expect(suspendedQueryCount(db)).toBe(0);

      await unmount(root);
      expect(heldStoreCount(db)).toBe(0);
      expect(suspendedQueryCount(db)).toBe(0);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an offline replica that already answered renders stale without suspending",
  async ({ browser }) => {
    const name = `ramose-react-suspense-warm-${browser.uniqueId}`;
    await seed(name, [{ entity: opaque("e"), title: "cached", rank: "a" }]);
    const client = offlineClient(name);
    const db = client.open();
    try {
      const warming: Rows[] = [];
      const warm = await mount(browser.root, <Waiting client={client} seen={warming} />);
      await until(() => text(browser.root) === "cached", "the restored replica");
      await unmount(warm);
      await until(
        () => client.sync.getSnapshot().status === "offline",
        "an unreachable server",
      );

      const seen: Rows[] = [];
      const again = await mount(browser.root, <Waiting client={client} seen={seen} />);

      expect(text(browser.root)).toBe("cached");
      expect(seen[0]!.status).toBe("stale");
      expect(seen.every((state) => state.status === "stale")).toBe(true);
      expect(suspendedQueryCount(db)).toBe(0);

      await unmount(again);
      expect(heldStoreCount(db)).toBe(0);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an offline scope with nothing cached renders pending rather than waiting forever",
  async ({ browser }) => {
    const name = `ramose-react-suspense-cold-${browser.uniqueId}`;
    const client = offlineClient(name);
    const db = client.open();
    try {
      const seen: Rows[] = [];
      const root = await mount(browser.root, <Waiting client={client} seen={seen} />);
      expect(text(browser.root)).toBe("loading");

      await until(() => text(browser.root) === "nothing-cached", "the offline answer");

      expect(client.sync.getSnapshot().status).toBe("offline");
      expect(seen.at(-1)!.status).toBe("pending");
      expect(suspendedQueryCount(db)).toBe(0);

      await unmount(root);
      expect(heldStoreCount(db)).toBe(0);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "unmounting while suspended leaves nothing growing",
  async ({ browser }) => {
    const name = `ramose-react-suspense-abandon-${browser.uniqueId}`;
    const client = offlineClient(name);
    const db = client.open();
    try {
      for (let index = 0; index < UNCLAIMED_LIMIT + 8; index++) {
        const root = await mount(
          browser.root,
          <Waiting client={client} seen={[]} where={`gone-${index}`} />,
        );
        if (index === 0) expect(text(browser.root)).toBe("loading");
        await unmount(root);
      }
      await until(
        () => client.sync.getSnapshot().status === "offline",
        "an unreachable server",
      );
      await until(
        () => suspendedQueryCount(db) <= UNCLAIMED_LIMIT,
        "the abandoned waits to settle",
      );

      expect(heldStoreCount(db)).toBeLessThanOrEqual(UNCLAIMED_LIMIT);
      expect(suspendedQueryCount(db)).toBeLessThanOrEqual(UNCLAIMED_LIMIT);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a replica warmed by useQuery alone answers a first suspense mount with no pending frame",
  async ({ browser }) => {
    const name = `ramose-react-suspense-warmed-${browser.uniqueId}`;
    await seed(name, [
      { entity: opaque("e"), title: "second", rank: "b" },
      { entity: opaque("f"), title: "first", rank: "a" },
    ]);
    const client = offlineClient(name);
    const db = client.open();
    const other = document.createElement("div");
    document.body.appendChild(other);
    try {
      const warm = await mount(
        browser.root,
        <RamoseProvider client={client}><Titles seen={[]} /></RamoseProvider>,
      );
      await until(() => text(browser.root) === "firstsecond", "the restored replica");
      await until(
        () => client.sync.getSnapshot().status === "offline",
        "an unreachable server",
      );

      const seen: Rows[] = [];
      const first = await mount(
        other,
        <Waiting client={client} seen={seen} where="a" />,
      );
      await until(() => text(other) !== "loading", "the first suspense mount");

      expect(seen.map((state) => state.status)).not.toContain("pending");
      expect(text(other)).toBe("first");

      await unmount(first);
      other.remove();
      await unmount(warm);
      expect(heldStoreCount(db)).toBe(0);
    } finally {
      other.remove();
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an abandoned wait over a store a mounted component already claimed releases it",
  async ({ browser }) => {
    const name = `ramose-react-suspense-claimed-${browser.uniqueId}`;
    const client = offlineClient(name);
    const db = client.open();
    const other = document.createElement("div");
    document.body.appendChild(other);
    try {
      const mounted = await mount(
        browser.root,
        <RamoseProvider client={client}><Titles seen={[]} /></RamoseProvider>,
      );
      expect(text(browser.root)).toBe("pending");
      expect(heldStoreCount(db)).toBe(1);

      const waiting = await mount(other, <Waiting client={client} seen={[]} />);
      expect(text(other)).toBe("loading");

      await unmount(waiting);
      other.remove();

      await until(
        () => client.sync.getSnapshot().status === "offline",
        "an unreachable server",
      );
      await until(() => suspendedQueryCount(db) === 0, "the abandoned wait");

      expect(heldStoreCount(db)).toBe(1);

      await unmount(mounted);
      expect(heldStoreCount(db)).toBe(0);
    } finally {
      other.remove();
      await client.close();
      await deleteDatabase(name);
    }
  },
);

const NEVER: Promise<void> = new Promise<void>(() => undefined);

const Blocked = (): ReactNode => {
  throw NEVER;
};

const Typed = ({ term }: { readonly term: string }): ReactNode => {
  useQuery(
    useDb().query.from(Note).where({ title: term }).select({ title: Note.title }),
  );
  return <p>{term}</p>;
};

browserTest(
  "abandoned renders under a suspended sibling do not grow the store cache",
  async ({ browser }) => {
    const name = `ramose-react-abandoned-${browser.uniqueId}`;
    await seed(name, [{ entity: opaque("e"), title: "typed", rank: "a" }]);
    const client = offlineClient(name);
    const db = client.open();
    try {
      let type: (term: string) => void = () => undefined;
      const Search = (): ReactNode => {
        const [term, setTerm] = useState("");
        type = setTerm;
        return (
          <Suspense fallback={<p>loading</p>}>
            <Typed term={term} />
            <Blocked />
          </Suspense>
        );
      };
      const root = await mount(
        browser.root,
        <RamoseProvider client={client}><Search /></RamoseProvider>,
      );
      expect(text(browser.root)).toBe("loading");

      for (let keystroke = 0; keystroke < UNCLAIMED_LIMIT + 8; keystroke++) {
        await act(async () => {
          type(`typed-${keystroke}`);
        });
      }

      expect(text(browser.root)).toBe("loading");
      expect(heldStoreCount(db)).toBeLessThanOrEqual(UNCLAIMED_LIMIT);

      await unmount(root);
      expect(heldStoreCount(db)).toBeLessThanOrEqual(UNCLAIMED_LIMIT);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "Strict Mode suspends once and resumes into one observation",
  async ({ browser }) => {
    const name = `ramose-react-suspense-strict-${browser.uniqueId}`;
    await seed(name, [{ entity: opaque("e"), title: "strict", rank: "a" }]);
    const client = offlineClient(name);
    const db = client.open();
    try {
      const seen: Rows[] = [];
      const root = await mount(
        browser.root,
        <StrictMode><Waiting client={client} seen={seen} /></StrictMode>,
      );
      expect(text(browser.root)).toBe("loading");

      await until(() => text(browser.root) === "strict", "the restored replica");

      expect(seen.every((state) => state.status === "stale")).toBe(true);
      expect(heldStoreCount(db)).toBe(1);
      expect(suspendedQueryCount(db)).toBe(0);

      await unmount(root);
      expect(heldStoreCount(db)).toBe(0);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a committed value arriving over the session resolves a suspended component",
  async ({ browser }) => {
    const name = `ramose-react-suspense-live-${browser.uniqueId}`;
    const client = recordedClient(name);
    const db = client.open();
    try {
      const seen: QueryState<readonly unknown[]>[] = [];
      const Issues = (): ReactNode => {
        const state = useSuspenseQuery(
          useDb().query.from(ConformanceIssue).select({ title: ConformanceIssue.title }),
        ) as QueryState<readonly unknown[]>;
        seen.push(state);
        return (
          <span>
            {state.status === "ready" ? String(state.data.length) : state.status}
          </span>
        );
      };
      const root = await mount(
        browser.root,
        <RamoseProvider client={client}>
          <Suspense fallback={<p>loading</p>}><Issues /></Suspense>
        </RamoseProvider>,
      );
      expect(text(browser.root)).toBe("loading");

      await until(() => seen.at(-1)?.status === "ready", "the committed value");

      const statuses = seen.map((state) => state.status);
      expect(statuses).not.toContain("pending");
      // The observation is handed to React's own subscription, so it is never
      // retired and resumed between the wait ending and the render resuming.
      expect(statuses).not.toContain("stale");
      expect(text(browser.root)).not.toBe("loading");
      expect((seen.at(-1) as { readonly data: readonly unknown[] }).data.length)
        .toBeGreaterThan(0);

      await unmount(root);
      expect(heldStoreCount(db)).toBe(0);
      expect(suspendedQueryCount(db)).toBe(0);
    } finally {
      await client.close();
      await deleteDatabase(name);
    }
  },
);
