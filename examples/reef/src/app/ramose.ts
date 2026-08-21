/**
 * Workspace wiring. The mint is the `ramose/better-auth` client plugin
 * (`authClient.ramose.token`); `Ramose.token.jwt` re-mints the JWT near
 * `exp`; `cls` is the decoded, unverified claim — UI hints only. The client
 * that lives with the board is owned by `<RamoseProvider key={slug}>` in
 * App.tsx. This module mints `{ slug, cls, token }` and, on create only,
 * runs `install()` + seeds over a short-lived client. `ensureSelf` (the
 * caller's `user` row) runs on the Provider client — see `bindSelf`.
 */
import * as Ramose from "ramose/db";
import * as Effect from "effect/Effect";
import type { ReefDb } from "../domain/queries.ts";
import { Reef } from "../domain/schema.ts";
import type { RamoseClass } from "../domain/shared.ts";
import { ensureSelf, provisionWorkspace } from "./mutations.ts";

export const RAMOSE_URL =
  import.meta.env.VITE_RAMOSE_URL ?? "http://localhost:1337";

export interface Workspace {
  readonly slug: string;
  readonly cls: RamoseClass;
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
 * `install()`s and seeds over a client that is closed before the board
 * mounts; the caller's `user` row is `bindSelf` on the live client.
 */
export const openWorkspace = async (
  slug: string,
  user: { id: string; name: string; email: string },
  provision: boolean,
  options?: OpenWorkspaceOptions,
): Promise<Workspace> => {
  const token =
    options?.token ??
    Ramose.token.jwt(async () => {
      const { authClient } = await import("./auth.ts");
      return authClient.ramose.token({ db: slug });
    });
  const cls = ((await token.claims()).ramose?.class ?? "viewer") as RamoseClass;
  if (provision) {
    const connect = options?.connect ?? Ramose.connect;
    const ramose = connect({
      url: options?.url ?? RAMOSE_URL,
      token,
      fetch: options?.fetch,
      webSocket: options?.webSocket,
    });
    try {
      await Effect.runPromise(
        provisionWorkspace(ramose.db(slug, Reef), user),
      );
    } finally {
      await ramose.close();
    }
  }
  return { slug, cls, token };
};

/**
 * The caller's `user` row on the client that stays mounted with the board.
 * Viewers skip the write (`cls !== "viewer"`) and stay `undefined`.
 */
export const bindSelf = (
  db: ReefDb,
  user: { id: string; name: string; email: string },
  cls: RamoseClass,
) => ensureSelf(db, user, cls !== "viewer");
