/**
 * `ramose/better-auth/client` — the browser half of the mint route.
 *
 * `ramoseTokenClient()` gives the auth client one action,
 * `authClient.ramose.token({ db })`, resolving to the mint route's body
 * `{ token, class, exp }` — exactly what `Ramose.token.jwt` accepts:
 *
 * ```typescript
 * const authClient = createAuthClient({ plugins: [ramoseTokenClient()] });
 * const source = Ramose.token.jwt(() => authClient.ramose.token({ db: slug }));
 * const runtime = ManagedRuntime.make(Ramose.layer({ url, token: source }));
 * ```
 *
 * Failure typing matches what `token.jwt` documents: a 401/403 from the mint
 * route (not signed in, not a member) throws Ramose's `Unauthorized`, which
 * passes through `token.jwt` untouched and fails a standing `live`
 * *terminally* — retrying cannot help until the user signs in again. Any
 * other failure throws a plain `Error`, which `token.jwt` wraps in
 * `NetworkError` and the transports retry as transient.
 */

import { Unauthorized } from "../db/index.ts";
import type { BetterAuthClientPlugin } from "better-auth";

type ClientFetch = Parameters<
  NonNullable<BetterAuthClientPlugin["getActions"]>
>[0];

/** The mint route's body — `Ramose.token.jwt` accepts it unchanged. */
export interface RamoseTokenResult {
  readonly token: string;
  /** The caller's `ramose.class` — role-aware chrome, never authorization. */
  readonly class: string;
  /** `exp` of the JWT, seconds since epoch (also inside the token itself). */
  readonly exp: number;
}

export interface RamoseTokenClientOptions {
  /** Must match the server plugin's `path`. @default "/ramose/token" */
  readonly path?: string;
}

/** The client plugin pairing with `ramoseToken` on the server. */
export const ramoseTokenClient = (options?: RamoseTokenClientOptions) => {
  const path = options?.path ?? "/ramose/token";
  return {
    id: "ramose-token",
    getActions: ($fetch: ClientFetch) => ({
      ramose: {
        token: async (
          input: { readonly db: string },
          fetchOptions?: { readonly headers?: HeadersInit },
        ): Promise<RamoseTokenResult> => {
          const { data, error } = await $fetch<RamoseTokenResult>(path, {
            method: "POST",
            body: { db: input.db },
            ...fetchOptions,
          });
          if (error) {
            const message =
              error.message ?? `ramose: token mint failed (${error.status})`;
            if (error.status === 401 || error.status === 403) {
              throw new Unauthorized({ message });
            }
            throw new Error(message);
          }
          return data as RamoseTokenResult;
        },
      },
    }),
  } satisfies BetterAuthClientPlugin;
};
