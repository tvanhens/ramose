/**
 * Workspace wiring. The mint is the `ramose/better-auth` client plugin
 * (`authClient.ramose.token`); `Ramose.token.jwt` re-mints the JWT near
 * `exp`; `cls` is the decoded, unverified claim — UI hints only. The client
 * that lives with the board is owned by `<RamoseProvider key={slug}>` in
 * App.tsx. This module mints `{ slug, cls, token }` and, on create only,
 * runs `install()` + seeds labels over a short-lived client. The peer
 * upserts the signed-in user row (`sub`, `role`, name, email) at session
 * establishment; screens read it with `db.principal()`.
 */
import * as Ramose from "ramose/db";
import { policy, type Class } from "../domain/policy.ts";
import { Reef } from "../domain/schema.ts";
import { provisionWorkspace } from "./mutations.ts";

export const RAMOSE_URL =
  import.meta.env.VITE_RAMOSE_URL ?? "http://localhost:1337";

export interface Workspace {
  readonly slug: string;
  readonly cls: Class;
  /** Stable for the workspace's lifetime — `RamoseProvider` keys its client on it. */
  readonly token: Ramose.TokenSource;
}

/**
 * Test / in-process peer seam. Production `openWorkspace` never passes this;
 * a refresh (`provision: false`) ignores `url` / `fetch` / `webSocket` /
 * `connect` because it does not open a session.
 */
export type OpenWorkspaceOptions = Pick<
  Ramose.ClientOptions,
  "url" | "fetch" | "webSocket"
> & {
  readonly token?: Ramose.TokenSource;
  readonly connect?: typeof Ramose.connect;
};

/**
 * Mint the source and decode `cls`. A refresh / shared-URL open
 * (`provision: false`) stops there — no `Ramose.connect`. Create still
 * `install()`s and seeds labels over a client that is closed before the
 * board mounts; `myEid` comes from `db.principal()` on the live client.
 */
export const openWorkspace = async (
  slug: string,
  provision: boolean,
  options?: OpenWorkspaceOptions,
): Promise<Workspace> => {
  // docs:open-workspace-token
  const token =
    options?.token ??
    Ramose.token.jwt(async () => {
      const { authClient } = await import("./auth.ts");
      return authClient.ramose.token({ db: slug });
    });
  const raw = (await token.claims()).ramose?.class;
  const cls = policy.classes.find((c) => c === raw) ?? "viewer";
  // enddocs:open-workspace-token
  if (provision) {
    // docs:open-workspace-provision
    const connect = options?.connect ?? Ramose.connect;
    const ramose = connect({
      url: options?.url ?? RAMOSE_URL,
      token,
      fetch: options?.fetch,
      webSocket: options?.webSocket,
    });
    try {
      // docs:ramose-db-slug
      await provisionWorkspace(ramose.db(slug, Reef));
      // enddocs:ramose-db-slug
    } finally {
      await ramose.close();
    }
    // enddocs:open-workspace-provision
  }
  return { slug, cls, token };
};
