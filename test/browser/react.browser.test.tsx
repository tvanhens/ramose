/**
 * `ramose/react` in a real browser, with real React (#479 slice 1).
 *
 * Nothing here is simulated: real Chromium, real IndexedDB, the real
 * replication session, real `react-dom` mounting into a real document, and the
 * adapter reached only through `RamoseProvider` / `useQuery` / `useSyncState`,
 * exactly as an application reaches it.
 *
 * Two lanes, matching `client.browser.test.ts`:
 *
 * 1. **Offline.** A replica installed and bound by a previous "session", read
 *    back through the hooks against an origin that refuses every connection.
 * 2. **Live.** One activation against the recorded real-Worker frame fixture
 *    (`test/browser/frames/PROVENANCE.md`), so a committed value arrives
 *    through the real session and re-renders a component that was already
 *    mounted.
 */

import { act, memo, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect } from "vitest";
import { compileReadAuthorization } from "../../packages/ramose/src/internal/authorization/index.ts";
import { Catalog } from "../../packages/ramose/src/Catalog.ts";
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
} from "../../packages/ramose/src/client/index.ts";
import { installClientCatalog } from "../../packages/ramose/src/client/catalog.ts";
import {
  RamoseProvider,
  useDb,
  useQuery,
  useSyncState,
  type QueryState,
} from "../../packages/ramose/src/react/index.ts";
import { heldStoreCount } from "../../packages/ramose/src/react/store.ts";
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

// React's own test contract: `act` refuses to flush work outside one.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ── the application's catalog ───────────────────────────────────────────────

const Note = Entity("note", {
  title: Field.unique(string(), "strict"),
  rank: string(),
});
const Notes = Schema({ note: Note });
const NotesCatalog = Catalog("react-notes", {
  schema: Notes,
  policy: compileReadAuthorization({ schema: Notes, rules: [] }),
});

/** An origin that refuses every connection, so every read has to be local. */
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

/**
 * Install and bind one replica exactly as a prior authenticated session would
 * have left it, then let go of the storage handle.
 */
const seed = async (name: string, notes: readonly SeededNote[]): Promise<void> => {
  const installed = await installClientCatalog(NotesCatalog);
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
};

const offlineClient = (name: string): Client =>
  createClient({
    url: OFFLINE,
    root: ROOT,
    catalog: NotesCatalog,
    auth: () => ({ token: TOKEN, cacheKey: CACHE_KEY }),
    storageName: name,
  });

// ── React harness ──────────────────────────────────────────────────────────

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

/**
 * Let the browser and React settle until `accept` holds.
 *
 * Every wait is inside `act`, so a state update the client publishes from a
 * storage or network continuation is flushed before the next check — this is
 * React's real scheduler, not a nudge past it.
 */
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

/** The query every component below asks, built inline on each render. */
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
      {/* Keyed on the row's own unique field. `row.id` is a *local* eid that is
          not portable across replicas or sessions, so it is never a React key,
          a route parameter, or anything persisted. */}
      {state.data.map((row) => <li key={row.title}>{row.title}</li>)}
    </ul>
  );
};

const text = (container: HTMLElement): string => container.textContent ?? "";

// ── offline lane ───────────────────────────────────────────────────────────

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
    // Restored from storage, never confirmed by the current session — real
    // data, and the component is told so.
    expect(seen.at(-1)!.status).toBe("stale");
    expect(seen[0]!.status).toBe("pending");
    // One observation, and one store over it.
    expect(heldStoreCount(db)).toBe(1);
    // Every render was handed a stable value: React re-rendered because the
    // state changed, not because `getSnapshot` allocated a new equal object.
    expect(new Set(seen).size).toBeLessThanOrEqual(2);

    await unmount(root);
    // Unmounting removed this component's observation and nothing else.
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
    // Two components asking the same question read one interned observation,
    // through one store, and are handed the very same narrowed value.
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
    // Strict Mode renders twice and subscribes, unsubscribes and subscribes
    // again. One observation, one store: the double pass must not install a
    // second of either.
    expect(heldStoreCount(db)).toBe(1);
    // And it must not flap: once data has been rendered, nothing goes back.
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

    // The component comes back — a route change, a suspended boundary, a
    // conditional render. It must resume from what the observation was showing
    // rather than render an empty frame the user already saw filled.
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
    // The surviving consumer is still attached to a live observation, and the
    // client is still synchronizing for the rest of this session.
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
    // A query is what activates a database, so the status has something to
    // report at all.
    const root = await mount(
      browser.root,
      <RamoseProvider client={client}>
        <Titles seen={[]} />
        <Status />
      </RamoseProvider>,
    );
    await until(() => statuses.at(-1) === "offline", "the offline status");

    // The client publishes a frozen singleton per status, so an unchanged
    // status is the same object and React never re-renders for it.
    expect(statuses).toEqual([...new Set(statuses)]);
    expect(new Set(states).size).toBe(new Set(statuses).size);
    // Every status this activation passed through, in order, and no repeats:
    // the component rendered once per transition and never for a re-published
    // equal state.
    expect(statuses.at(-1)).toBe("offline");
    expect(statuses.length).toBeLessThanOrEqual(3);
    await unmount(root);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});

// ── live lane, over the recorded real-Worker frames ────────────────────────

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
const ConformanceSchema = Schema({
  conformanceUser: ConformanceUser,
  conformanceIssue: ConformanceIssue,
});
const ConformanceCatalog = Catalog("local-conformance", {
  schema: ConformanceSchema,
  policy: compileReadAuthorization({ schema: ConformanceSchema, rules: [] }),
});

const recordedClient = (name: string): Client =>
  createClient({
    url: globalThis.location.origin,
    // The recorded fixture is served at `/db/optimistic-fence/replicate`.
    root: "optimistic-fence",
    catalog: ConformanceCatalog,
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
    // Mounted before anything is stored: the first value this component ever
    // renders arrives as a committed replica over the real session.
    expect(seen[0]!.status).toBe("pending");
    await until(() => seen.at(-1)!.status === "ready", "the committed value");
    // Confirmed by the response that delivered it, so it is `ready`, not
    // `stale`, and it really carries rows.
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
  const installed = await installClientCatalog(ConformanceCatalog);
  // The same principal, the same read view, the same database — a replica this
  // client is entitled to restore and render immediately, which the recorded
  // session then confirms. That confirmation is the stale flip.
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
    // What the parent was rendering each time the memoized child re-rendered.
    let parentStatus = "";
    const childRenderedUnder: string[] = [];
    const Rows = memo(({ rows }: { readonly rows: readonly unknown[] }): ReactNode => {
      childRenderedUnder.push(parentStatus);
      return <span>{rows.length}</span>;
    });
    const seen: string[] = [];
    const Board = (): ReactNode => {
      // A question neither the restored replica nor the recording answers with
      // rows, so its answer is deep-equal across the confirmation and the
      // client hands back the same `data`.
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
    // Not vacuous: the restored replica really was rendered before the session
    // confirmed it.
    expect(seen).toContain("stale");
    expect(seen.indexOf("stale")).toBeLessThan(seen.lastIndexOf("ready"));
    // The parent re-rendered for the status change. The child rendered once,
    // under `stale`, and not again when the session confirmed the same answer:
    // the client reused `data` across the flip and the adapter passed the very
    // same value through, so `memo` held.
    expect(childRenderedUnder).toEqual(["stale"]);
    await unmount(root);
    expect(heldStoreCount(db)).toBe(0);
  } finally {
    await client.close();
    await deleteDatabase(name);
  }
});
