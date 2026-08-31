import { createAuthClient } from "better-auth/react";
import { AUTH_BASE_PATH, MINT_PATH } from "../domain/shared.ts";

export const authClient = createAuthClient({
  baseURL: `${location.origin}${AUTH_BASE_PATH}`,
});

export type CachedUser = {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
};

const USER_KEY = "reef:user";
const bearerKey = (userId: string) => `reef:bearer:${userId}`;

const readJson = <A>(key: string): A | undefined => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as A);
  } catch {
    return undefined;
  }
};

const writeJson = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
};

const drop = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    return;
  }
};

/**
 * The account that last rendered this app, kept so a refresh — online or
 * offline — mounts straight into the shell instead of waiting on
 * `/api/auth/get-session`. It names an account; it grants nothing.
 */
export const readCachedUser = (): CachedUser | undefined =>
  readJson<CachedUser>(USER_KEY);

export const writeCachedUser = (user: CachedUser): void =>
  writeJson(USER_KEY, user);

export const clearCachedUser = (): void => drop(USER_KEY);

type StoredBearer = {
  readonly token: string;
  readonly exp: number;
};

const freshFor = (bearer: StoredBearer | undefined): boolean =>
  bearer !== undefined && Date.now() < bearer.exp * 1000 - 60_000;

/**
 * The credential for one activation. The stored bearer is presented again
 * whenever it is still fresh — and, when the mint endpoint is unreachable,
 * even when it is not: presenting the *same* bearer the replica was last
 * confirmed under is what lets stored data render before anything reaches
 * the network, and an unreachable server cannot refuse it. A reachable mint
 * replaces it and the next activation carries the renewal.
 */
export const mintToken = async (userId: string): Promise<string> => {
  const stored = readJson<StoredBearer>(bearerKey(userId));
  if (freshFor(stored)) return stored!.token;
  let response: Response;
  try {
    response = await fetch(`${location.origin}${MINT_PATH}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (cause) {
    if (stored !== undefined) return stored.token;
    throw cause;
  }
  if (!response.ok) {
    throw new Error(`reef: token mint failed with ${response.status}`);
  }
  const body = (await response.json()) as {
    readonly token?: unknown;
    readonly exp?: unknown;
  };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("reef: token mint returned no token");
  }
  const exp = typeof body.exp === "number"
    ? body.exp
    : Math.floor(Date.now() / 1000) + 60;
  writeJson(bearerKey(userId), { token: body.token, exp });
  return body.token;
};

export const dropToken = (userId: string): void => drop(bearerKey(userId));
