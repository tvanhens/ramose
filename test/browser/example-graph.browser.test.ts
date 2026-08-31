import { expect } from "vitest";
import type { Client, ClientDatabase, Receipt } from "../../packages/ramose/src/client/index.ts";
import {
  boardDb,
  boards,
  issues,
  openApp,
  openIssues,
  organizationDb,
  organizations,
} from "../../examples/graph/src/app.ts";
import { browserTest } from "./fixtures.ts";
import { PARTITION_PATH, TOKEN_PATH } from "./example-stack.ts";

type Row = Record<string, unknown>;

const until = async <A>(
  probe: () => A | Promise<A>,
  ready: (value: A) => boolean,
  label: string,
  budget = 30_000,
): Promise<A> => {
  const deadline = performance.now() + budget;
  for (;;) {
    const value = await probe();
    if (ready(value)) return value;
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const steady = async <A>(
  probe: () => A | Promise<A>,
  holds: (value: A) => boolean,
  label: string,
  attempts = 10,
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const value = await probe();
    if (!holds(value)) {
      throw new Error(`${label} changed to ${JSON.stringify(value)}`);
    }
  }
};

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

const principal = (uniqueId: string): string =>
  `user_${uniqueId.replaceAll("-", "").slice(0, 20)}`;

const partition = async (subject: string, offline: boolean): Promise<void> => {
  const response = await fetch(
    `${PARTITION_PATH}?sub=${encodeURIComponent(subject)}&offline=${offline ? "1" : "0"}`,
  );
  expect(response.status).toBe(204);
};

class Wallet {
  minted = 0;
  private held: { readonly token: string; readonly cacheKey: string } | undefined;
  private expiresAt = 0;

  constructor(private readonly subject: string) {}

  rotate(): void {
    this.held = undefined;
  }

  readonly session = async (): Promise<{ token: string; cacheKey: string }> => {
    if (this.held !== undefined && Date.now() < this.expiresAt) return this.held;
    const answered = await fetch(
      `${TOKEN_PATH}?sub=${encodeURIComponent(this.subject)}`,
    );
    const body = await answered.json() as {
      readonly token: string;
      readonly account: string;
      readonly expiresIn: number;
    };
    this.minted += 1;
    this.expiresAt = Date.now() + Math.max(body.expiresIn - 15, 5) * 1_000;
    this.held = { token: body.token, cacheKey: body.account };
    return this.held;
  };
}

const app = (
  storageName: string,
  wallet: Wallet,
): { readonly client: Client } => ({
  client: openApp({
    url: location.origin,
    storageName,
    session: wallet.session,
  }),
});

const rows = (db: ClientDatabase, query: Parameters<ClientDatabase["observe"]>[0]) => {
  const subscription = db.observe(query as never);
  const release = subscription.subscribe(() => undefined);
  return {
    read: (): readonly Row[] =>
      (subscription.getSnapshot().data ?? []) as readonly Row[],
    release,
  };
};

const named = (values: readonly Row[]): readonly string[] =>
  values.map((row) => String(row["name"] ?? row["slug"]));

const titles = (values: readonly Row[]): readonly string[] =>
  values.map((row) =>
    String((row as unknown as { readonly data: { readonly title: string } }).data.title)
  );

const look = (): void => {
  window.dispatchEvent(new Event("focus"));
};

const awake = async (
  db: ClientDatabase,
  ready: (status: string) => boolean,
  label: string,
  budget = 30_000,
): Promise<void> => {
  const deadline = performance.now() + budget;
  for (;;) {
    const status = db.sync.getSnapshot().status;
    if (ready(status)) return;
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${label}: ${status}`);
    }
    look();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const settled = async (receipt: Receipt): Promise<void> => {
  await receipt.queued;
  await receipt.committed;
};

const visible = async (
  db: ClientDatabase,
  query: Parameters<ClientDatabase["observe"]>[0],
  name: string,
  label: string,
): Promise<void> => {
  const view = rows(db, query);
  try {
    await until(
      () => named(view.read()),
      (values) => values.includes(name),
      label,
    );
  } finally {
    view.release();
  }
};

const workspace = async (
  root: ClientDatabase,
  organizationSlug: string,
  boardSlug: string,
): Promise<ClientDatabase> => {
  await settled(root.mutate.createOrganization({
    slug: organizationSlug,
    name: organizationSlug,
  }));
  await visible(root, organizations(root), organizationSlug, "the created organization");
  const organization = organizationDb(root, organizationSlug);
  await settled(organization.mutate.createBoard({
    slug: boardSlug,
    name: boardSlug,
  }));
  await visible(organization, boards(organization), boardSlug, "the created board");
  const board = boardDb(root, organizationSlug, boardSlug);
  rows(board, issues(board));
  await until(
    () => board.sync.getSnapshot().status,
    (status) => status === "live",
    "the board activation",
  );
  return board;
};

browserTest(
  "the example creates, queries and mutates a nested graph, then reopens it offline",
  { timeout: 120_000 },
  async ({ browser }) => {
    const subject = principal(browser.uniqueId);
    const wallet = new Wallet(subject);
    const storageName = `ramose-example-${browser.uniqueId}`;
    const slug = `org-${browser.uniqueId.slice(0, 8)}`;
    const board = `board-${browser.uniqueId.slice(0, 8)}`;
    const first = app(storageName, wallet);
    try {
      const root = first.client.open();
      const board1 = await workspace(root, slug, board);

      await settled(board1.mutate.createIssue({ title: "Ship the example" }));

      const seen = rows(root, organizations(root));
      await until(
        () => named(seen.read()),
        (values) => values.includes(slug),
        "the organization the example just created",
      );
      seen.release();

      const boardRows = rows(organizationDb(root, slug), boards(organizationDb(root, slug)));
      await until(
        () => named(boardRows.read()),
        (values) => values.includes(board),
        "the board the example just created",
      );
      boardRows.release();

      const issueRows = rows(board1, issues(board1));
      const created = await until(
        () => issueRows.read(),
        (values) => values.length === 1,
        "the issue the example just created",
      );
      const handle = created[0] as unknown as {
        readonly id: string;
        readonly data: { readonly title: string; readonly status: string };
        readonly local: { readonly pending: boolean };
        readonly mutate: { readonly close: () => Receipt };
      };
      expect(handle.data).toMatchObject({
        title: "Ship the example",
        status: "open",
      });
      expect(handle.id).toMatch(/^[A-Za-z0-9_-]{54}[AEIMQUYcgkosw048]$/);
      expect(handle.local.pending).toBe(false);

      await settled(handle.mutate.close());
      await until(
        () => issueRows.read().map((row) =>
          (row as unknown as { readonly data: { readonly status: string } }).data.status
        ),
        (values) => values.includes("closed"),
        "the closed issue",
      );
      issueRows.release();
      await first.client.close();

      await partition(subject, true);
      const second = app(storageName, wallet);
      try {
        const reopened = second.client.open();
        const again = rows(reopened, organizations(reopened));
        await until(
          () => named(again.read()),
          (values) => values.includes(slug),
          "the organization restored from durable local state while offline",
        );
        expect(["stale", "offline"]).toContain(
          reopened.sync.getSnapshot().status,
        );

        again.release();
      } finally {
        await partition(subject, false);
        await second.client.close();
      }
    } finally {
      await deleteDatabase(storageName);
    }
  },
);

browserTest(
  "an offline creation converges after reconnect with no rollback flash",
  { timeout: 120_000 },
  async ({ browser }) => {
    const subject = principal(browser.uniqueId);
    const wallet = new Wallet(subject);
    const storageName = `ramose-example-${browser.uniqueId}`;
    const slug = `org-${browser.uniqueId.slice(0, 8)}`;
    const board = `board-${browser.uniqueId.slice(0, 8)}`;
    const session = app(storageName, wallet);
    try {
      const root = session.client.open();
      const boardHandle = await workspace(root, slug, board);
      await settled(boardHandle.mutate.createIssue({ title: "Committed online" }));

      const open = rows(boardHandle, openIssues(boardHandle));
      await until(
        () => open.read().length,
        (count) => count === 1,
        "the online issue",
      );

      await partition(subject, true);
      const receipt = boardHandle.mutate.createIssue({ title: "Written offline" });
      await receipt.queued;

      const offline = await until(
        () => open.read(),
        (values) => values.length === 2,
        "the optimistic row",
      );
      const optimistic = offline
        .map((row) => row as unknown as {
          readonly id: string;
          readonly data: { readonly title: string };
          readonly local: { readonly pending: boolean; readonly created: boolean };
        })
        .find((row) => row.data.title === "Written offline")!;
      expect(optimistic.id.startsWith("cr1_")).toBe(true);
      expect(optimistic.local).toEqual({ pending: true, created: true });

      await steady(
        () => open.read().length,
        (count) => count === 2,
        "the offline row count",
      );

      await partition(subject, false);
      await receipt.committed;

      const converged = await until(
        () =>
          open.read().map((row) =>
            (row as unknown as { readonly id: string; readonly local: { readonly pending: boolean } })
          ),
        (values) =>
          values.length === 2 &&
          values.every((row) => !row.id.startsWith("cr1_") && !row.local.pending),
        "the converged committed rows",
      );
      expect(converged.map((row) => row.id).every((id) =>
        /^[A-Za-z0-9_-]{54}[AEIMQUYcgkosw048]$/.test(id)
      )).toBe(true);
      open.release();
    } finally {
      await partition(subject, false);
      await session.client.close();
      await deleteDatabase(storageName);
    }
  },
);

browserTest(
  "a client whose activation failed while offline returns to live when the connection returns",
  { timeout: 120_000 },
  async ({ browser }) => {
    const subject = principal(browser.uniqueId);
    const wallet = new Wallet(subject);
    const storageName = `ramose-example-${browser.uniqueId}`;
    const slug = `org-${browser.uniqueId.slice(0, 8)}`;
    const board = `board-${browser.uniqueId.slice(0, 8)}`;
    const first = app(storageName, wallet);
    try {
      const root = first.client.open();
      const board1 = await workspace(root, slug, board);
      await settled(board1.mutate.createIssue({ title: "Before the outage" }));
      await first.client.close();

      await partition(subject, true);
      const second = app(storageName, wallet);
      try {
        const reopened = second.client.open();
        const restored = rows(reopened, organizations(reopened));
        await until(
          () => named(restored.read()),
          (values) => values.includes(slug),
          "the organization restored from durable local state while offline",
        );
        await awake(
          reopened,
          (status) => status === "offline",
          "the activation to fail against the cut wire",
        );
        const board2 = boardDb(reopened, slug, board);
        const view = rows(board2, issues(board2));

        await partition(subject, false);
        await awake(reopened, (status) => status === "live", "the root returning to live");
        await awake(board2, (status) => status === "live", "the board returning to live");

        await settled(board2.mutate.createIssue({ title: "After the outage" }));
        const converged = await until(
          () => view.read(),
          (values) =>
            titles(values).includes("After the outage") &&
            values.every((row) =>
              !(row as unknown as { readonly local: { readonly pending: boolean } })
                .local.pending
            ),
          "the write the recovered client round-tripped",
        );
        expect(titles(converged).slice().sort()).toEqual([
          "After the outage",
          "Before the outage",
        ]);
        view.release();
        restored.release();
      } finally {
        await partition(subject, false);
        await second.client.close();
      }
    } finally {
      await partition(subject, false);
      await deleteDatabase(storageName);
    }
  },
);

browserTest(
  "a live client resumes its own session after the connection is cut and comes back",
  { timeout: 120_000 },
  async ({ browser }) => {
    const subject = principal(browser.uniqueId);
    const wallet = new Wallet(subject);
    const storageName = `ramose-example-${browser.uniqueId}`;
    const slug = `org-${browser.uniqueId.slice(0, 8)}`;
    const board = `board-${browser.uniqueId.slice(0, 8)}`;
    const session = app(storageName, wallet);
    try {
      const root = session.client.open();
      const boardHandle = await workspace(root, slug, board);
      await settled(boardHandle.mutate.createIssue({ title: "Held across the cut" }));
      const view = rows(boardHandle, issues(boardHandle));
      const observed = boardHandle.observe(issues(boardHandle));
      const releaseObserved = observed.subscribe(() => undefined);
      await until(
        () => titles(view.read()),
        (values) => values.includes("Held across the cut"),
        "the committed issue",
      );
      const minted = wallet.minted;
      const published: string[] = [];
      const record = boardHandle.sync.subscribe(() => {
        published.push(boardHandle.sync.getSnapshot().status);
      });
      let sampling = true;
      let unconfirmed = 0;
      const sampler = (async () => {
        const deadline = performance.now() + 60_000;
        while (sampling && performance.now() < deadline) {
          const snapshot = observed.getSnapshot();
          if (snapshot.status === "ready" && snapshot.stale) unconfirmed += 1;
          await new Promise((resolve) => setTimeout(resolve));
        }
      })();

      await partition(subject, true);
      await awake(
        boardHandle,
        (status) => status === "offline",
        "the cut wire ending the session",
      );
      await steady(
        () => titles(view.read()),
        (values) => values.includes("Held across the cut"),
        "the committed issue while offline",
      );

      await partition(subject, false);
      await awake(root, (status) => status === "live", "the root resuming");
      await awake(boardHandle, (status) => status === "live", "the board resuming");

      record();
      sampling = false;
      await sampler;
      releaseObserved();
      expect(titles(view.read())).toContain("Held across the cut");
      expect(wallet.minted).toBe(minted);
      expect(published).toContain("stale");
      expect(published).toContain("live");
      expect(published).not.toContain("connecting");
      expect(unconfirmed).toBeGreaterThan(0);
      await settled(boardHandle.mutate.createIssue({ title: "Written after resuming" }));
      await until(
        () => titles(view.read()),
        (values) => values.includes("Written after resuming"),
        "a write the resumed session committed",
      );
      view.release();
    } finally {
      await partition(subject, false);
      await session.client.close();
      await deleteDatabase(storageName);
    }
  },
);

browserTest(
  "a rotated bearer renders nothing offline and renders on the server's confirmation",
  { timeout: 120_000 },
  async ({ browser }) => {
    const subject = principal(browser.uniqueId);
    const wallet = new Wallet(subject);
    const storageName = `ramose-example-${browser.uniqueId}`;
    const slug = `org-${browser.uniqueId.slice(0, 8)}`;
    const board = `board-${browser.uniqueId.slice(0, 8)}`;
    const first = app(storageName, wallet);
    try {
      const root = first.client.open();
      await workspace(root, slug, board);
      await first.client.close();
      expect(wallet.minted).toBe(1);

      wallet.rotate();
      await partition(subject, true);
      const second = app(storageName, wallet);
      try {
        const reopened = second.client.open();
        const view = rows(reopened, organizations(reopened));
        await awake(
          reopened,
          (status) => status === "offline",
          "the rotated activation to fail against the cut wire",
        );
        await steady(
          () => view.read().length,
          (count) => count === 0,
          "the nominated replica while nothing has confirmed it",
        );
        expect(wallet.minted).toBe(2);

        await partition(subject, false);
        await awake(
          reopened,
          (status) => status === "live",
          "the rotated bearer's activation confirming",
        );
        await until(
          () => named(view.read()),
          (values) => values.includes(slug),
          "the replica the server confirmed for the rotated bearer",
        );
        expect(wallet.minted).toBe(2);
        view.release();
      } finally {
        await partition(subject, false);
        await second.client.close();
      }
    } finally {
      await partition(subject, false);
      await deleteDatabase(storageName);
    }
  },
);

const errandStatuses = (client: Client): readonly string[] => {
  const receivers = (client as unknown as {
    readonly receivers: ReadonlyMap<
      string,
      { readonly sync: { getSnapshot: () => { readonly status: string } } } | undefined
    >;
  }).receivers;
  return [...receivers.values()].map((handle) =>
    handle === undefined ? "resolving" : handle.sync.getSnapshot().status
  );
};

browserTest(
  "client.sync reports the databases the application opened, not the queue's errand",
  { timeout: 120_000 },
  async ({ browser }) => {
    const subject = principal(browser.uniqueId);
    const wallet = new Wallet(subject);
    const storageName = `ramose-example-${browser.uniqueId}`;
    const slug = `org-${browser.uniqueId.slice(0, 8)}`;
    const board = `board-${browser.uniqueId.slice(0, 8)}`;
    const first = app(storageName, wallet);
    try {
      const root = first.client.open();
      const board1 = await workspace(root, slug, board);
      const observed = board1.observe(issues(board1));
      const release = observed.subscribe(() => undefined);
      await until(
        () => observed.getSnapshot().status,
        (status) => status === "ready",
        "the board's own value to become readable",
      );
      await partition(subject, true);
      await board1.mutate.createIssue({ title: "Queued for an errand" }).queued;
      release();
      await first.client.close();

      const second = app(storageName, wallet);
      try {
        const reopened = second.client.open();
        const view = rows(reopened, organizations(reopened));
        await until(
          () => named(view.read()),
          (values) => values.includes(slug),
          "the organization this client did open",
        );
        await partition(subject, false);

        let sampling = true;
        let staged = 0;
        let discriminated = 0;
        let reported: string | undefined;
        const sampler = (async () => {
          const deadline = performance.now() + 30_000;
          while (sampling && performance.now() < deadline) {
            const errands = errandStatuses(second.client);
            const application = reopened.sync.getSnapshot().status;
            const client = second.client.sync.getSnapshot().status;
            if (errands.length > 0) staged += 1;
            if (
              errands.some((status) => status !== "resolving" && status !== application)
            ) discriminated += 1;
            if (client !== application) reported ??= `${client} beside ${application}`;
            await new Promise((resolve) => setTimeout(resolve));
          }
        })();

        await awake(reopened, (status) => status === "live", "the root returning to live");
        await until(
          () => discriminated,
          (count) => count > 0,
          "an errand reporting differently from the database the application opened",
          20_000,
        );
        sampling = false;
        await sampler;

        expect(staged).toBeGreaterThan(0);
        expect(reported).toBeUndefined();

        const board2 = boardDb(reopened, slug, board);
        const queued = rows(board2, issues(board2));
        await until(
          () => titles(queued.read()),
          (values) => values.includes("Queued for an errand"),
          "the invocation the errand submitted",
        );
        queued.release();
        view.release();
      } finally {
        await partition(subject, false);
        await second.client.close();
      }
    } finally {
      await partition(subject, false);
      await deleteDatabase(storageName);
    }
  },
);

