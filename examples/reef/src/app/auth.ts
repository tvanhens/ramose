import { createAuthClient } from "better-auth/react";
import { AUTH_BASE_PATH, MINT_PATH } from "../domain/shared.ts";

export const authClient = createAuthClient({
  baseURL: `${location.origin}${AUTH_BASE_PATH}`,
});

let held: { readonly token: string; readonly until: number } | undefined;

/** Mint a short-lived Ramose JWT for the signed-in Better Auth session. */
export const mintToken = async (): Promise<string> => {
  if (held !== undefined && Date.now() < held.until) return held.token;
  const response = await fetch(`${location.origin}${MINT_PATH}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    held = undefined;
    throw new Error(`reef: token mint failed with ${response.status}`);
  }
  const body = (await response.json()) as {
    readonly token?: unknown;
    readonly exp?: unknown;
  };
  if (typeof body.token !== "string" || body.token.length === 0) {
    held = undefined;
    throw new Error("reef: token mint returned no token");
  }
  const expiresMs = typeof body.exp === "number"
    ? body.exp * 1000
    : Date.now() + 60_000;
  held = { token: body.token, until: expiresMs - 60_000 };
  return body.token;
};

export const dropToken = (): void => {
  held = undefined;
};
