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

/** One signed-in principal of the example's identity plane. */
const principal = (uniqueId: string): string =>
  `user_${uniqueId.replaceAll("-", "").slice(0, 20)}`;

const partition = async (subject: string, offline: boolean): Promise<void> => {
  const response = await fetch(
    `${PARTITION_PATH}?sub=${encodeURIComponent(subject)}&offline=${offline ? "1" : "0"}`,
  );
  expect(response.status).toBe(204);
};

/**
 * The bearer an application holds between activations.
 *
 * A real application caches its access token until it expires and asks its
 * identity provider for another one — which is what makes an exact prior
 * binding, and a rotation, two different things a test can ask for.
 */
class Wallet {
  minted = 0;
  private held: { readonly token: string; readonly cacheKey: string } | undefined;
  private expiresAt = 0;

  constructor(private readonly subject: string) {}

  /** Sign out and back in: the next activation presents a different bearer. */
  rotate(): void {
    this.held = undefined;
  }

  readonly session = async (): Promise<{ token: string; cacheKey: string }> => {
    // A held bearer is presented again while it is comfortably valid, which is
    // what makes an exact prior binding reachable; a nearly expired one is
    // renewed, as an application's own token client would renew it.
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

const settled = async (receipt: Receipt): Promise<void> => {
  await receipt.queued;
  await receipt.committed;
};

/**
 * Provision one organization and one board for a test, through the same public
 * surface an application uses.
 */
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
  // The board stays observed for the life of the test, as it would while it is
  // the screen a person is looking at.
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
      // The public identity is the sealed handle, never a numeric eid.
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

      // Reopening with the exact prior bearer binding renders the persisted
      // replica before anything is reachable.
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

      // The optimistic layer is visible immediately, and its row carries the
      // ClientRef this device minted rather than a server handle.
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

      // Nothing settles while the wire is cut, and the row never disappears.
      await steady(
        () => open.read().length,
        (count) => count === 2,
        "the offline row count",
      );

      await partition(subject, false);
      await receipt.committed;

      // The commit is durable, and the layer stays visible until a fresh
      // activation observes it: the count never drops below two.
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

