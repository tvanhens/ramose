import { createAuthClient } from "better-auth/react";
import { AUTH_BASE_PATH } from "../domain/shared.ts";

export const authClient = createAuthClient({
  baseURL: `${location.origin}${AUTH_BASE_PATH}`,
});

export type CachedUser = {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
};

const USER_KEY = "reef:user";

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
