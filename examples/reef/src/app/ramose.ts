/**
 * Workspace wiring. The mint is the `ramose/better-auth` client plugin
 * (`authClient.ramose.token`); `Ramose.token.jwt` re-mints the JWT near
 * `exp`; `cls` is the decoded, unverified claim — UI hints only. The client
 * that lives with the board is owned by `<RamoseProvider key={slug}>` in
 * App.tsx; this module only runs the first-entry writes over a short-lived
 * one and hands the screens `{ slug, cls, token, myEid }`.
 */
import * as Ramose from "ramose/db";
import * as Effect from "effect/Effect";
import { Reef } from "../domain/schema.ts";
import type { RamoseClass } from "../domain/shared.ts";
import { authClient } from "./auth.ts";
import { ensureSelf, provisionWorkspace } from "./mutations.ts";

export const RAMOSE_URL =
  import.meta.env.VITE_RAMOSE_URL ?? "http://localhost:1337";

export interface Workspace {
  readonly slug: string;
  readonly cls: RamoseClass;
  /** Stable for the workspace's lifetime — `RamoseProvider` keys its client on it. */
  readonly token: Ramose.TokenSource;
  /** The caller's `user` eid in this workspace (`undefined` for viewers). */
  readonly myEid: number | undefined;
}

/**
 * Mint the source, then run the one-time writes — `install()` + seeds when
 * `provision`, and the caller's own `user` row — over a client closed before
 * the board mounts.
 */
export const openWorkspace = async (
  slug: string,
  user: { id: string; name: string; email: string },
  provision: boolean,
): Promise<Workspace> => {
  const token = Ramose.token.jwt(() => authClient.ramose.token({ db: slug }));
  const cls = ((await token.claims()).ramose?.class ?? "viewer") as RamoseClass;
  const ramose = Ramose.connect({ url: RAMOSE_URL, token });
  try {
    const db = ramose.db(slug, Reef);
    if (provision) await Effect.runPromise(provisionWorkspace(db, user));
    const myEid = await Effect.runPromise(
      ensureSelf(db, user, cls !== "viewer"),
    );
    return { slug, cls, token, myEid };
  } finally {
    await ramose.close();
  }
};
