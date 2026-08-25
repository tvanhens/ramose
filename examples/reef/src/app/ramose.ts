/**
 * Workspace wiring. The mint is the `ramose/better-auth` client plugin
 * (`authClient.ramose.token`); `Ramose.token.jwt` re-mints the JWT near
 * `exp`. The client that lives with the board is owned by
 * `<RamoseProvider key={slug}>` in App.tsx. This module mints `{ slug,
 * token }` and, on create only, runs `install()` + seeds labels over a
 * short-lived client. Class is a UI hint from `useRamoseClaims()` once
 * the provider owns the source; `eid` comes from `usePrincipal(db)`.
 */
import * as Ramose from "ramose/db";
import { Reef } from "../domain/schema.ts";
import { provisionWorkspaceOp } from "./mutations.ts";

export const RAMOSE_URL =
  import.meta.env.VITE_RAMOSE_URL ?? "http://localhost:1337";

export interface Workspace {
  readonly slug: string;
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
 * Mint the source (and warm its claims cache so `useRamoseClaims` is
 * sync on the first board render). A refresh / shared-URL open
 * (`provision: false`) stops there — no `Ramose.connect`. Create still
 * `install()`s and seeds labels over a client that is closed before the
 * board mounts.
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
  await token.claims();
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
      // docs:provision-workspace
      await ramose.db(slug, Reef).run(provisionWorkspaceOp, {});
      // enddocs:provision-workspace
      // enddocs:ramose-db-slug
    } finally {
      await ramose.close();
    }
    // enddocs:open-workspace-provision
  }
  return { slug, token };
};
