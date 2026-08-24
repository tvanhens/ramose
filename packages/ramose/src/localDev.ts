/**
 * Placeholder Cloudflare credentials for `alchemy dev` (miniflare).
 *
 * Alchemy reads `CI` before it will skip interactive login, and the local
 * emulator insists on an account id (32 hex) and a token before it starts.
 * Nothing is uploaded. Real values, when set, are left alone.
 */

/** The documented placeholder account id — any 32 hex characters work. */
export const LOCAL_DEV_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

/** Env the local emulator needs when no real Cloudflare credentials are set. */
export const LOCAL_DEV = {
  CI: "1",
  ALCHEMY_STATE: "local",
  CLOUDFLARE_ACCOUNT_ID: LOCAL_DEV_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: "x",
} as const;

/**
 * Fill missing local-dev credentials on `env` (default `process.env`).
 *
 * Call at the top of `alchemy.run.ts` so `bun alchemy dev` works without
 * inventing a 32-hex account id. Does not override a key that is already set.
 *
 * ```ts
 * import * as Ramose from "ramose";
 * Ramose.applyLocalDev();
 * ```
 */
export const applyLocalDev = (env: NodeJS.ProcessEnv = process.env): void => {
  for (const [key, value] of Object.entries(LOCAL_DEV)) {
    const current = env[key];
    if (current === undefined || current === "") env[key] = value;
  }
};
