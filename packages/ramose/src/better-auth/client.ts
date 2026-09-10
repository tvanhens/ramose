import type { AuthCredential, AuthProvider } from "../client/client.ts";

/** A Better Auth credential provider for one account and token endpoint. */
export interface BetterAuthProvider extends AuthProvider {
  /** Forget the saved bearer and permanently close this provider on sign-out. */
  clear(): void;
}

export interface BetterAuthProviderOptions {
  readonly userId: string;
  /** Better Auth base URL. Defaults to `/api/auth` on the current origin. */
  readonly baseURL?: string;
}

type Bearer = { readonly token: string; readonly exp: number };
const bearerOf = (value: unknown): Bearer | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<Bearer>;
  return typeof candidate.token === "string" && candidate.token.length > 0 &&
      typeof candidate.exp === "number" && Number.isFinite(candidate.exp) && candidate.exp > 0
    ? { token: candidate.token, exp: candidate.exp }
    : undefined;
};

/**
 * Cache and renew the bearer minted by `ramoseToken`. A network failure may
 * reuse the previously saved bearer; an HTTP refusal never does. Concurrent
 * requests share one renewal. Saved credentials grant no local authority:
 * the Ramose client still requires its prior or current authenticated binding.
 */
export const createAuthProvider = (options: BetterAuthProviderOptions): BetterAuthProvider => {
  const userId = options.userId;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("ramose/better-auth: userId is required");
  }
  const base = new URL(options.baseURL ?? "/api/auth", location.origin);
  const endpoint = new URL(`${base.pathname.replace(/\/$/, "")}/ramose/token`, base.origin).href;
  const key = `ramose:bearer:${encodeURIComponent(endpoint)}:${encodeURIComponent(userId)}`;
  let closed = false;
  let pending: Promise<AuthCredential> | undefined;
  let memory: Bearer | undefined;
  let persisted = false;
  const controller = new AbortController();
  const remove = () => {
    memory = undefined;
    try { localStorage.removeItem(key); } catch {}
  };
  const read = (): Bearer | undefined => {
    let raw: string | null;
    try { raw = localStorage.getItem(key); } catch { return memory; }
    if (raw === null) return persisted ? undefined : memory;
    try { return bearerOf(JSON.parse(raw)); } catch { return undefined; }
  };
  const renew = async (): Promise<AuthCredential> => {
    const stored = read();
    const credential = (token: string): AuthCredential => ({ token, cacheKey: userId });
    if (stored !== undefined && Date.now() < stored.exp * 1000 - 60_000) return credential(stored.token);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
    } catch (cause) {
      if (!closed && stored !== undefined) return credential(stored.token);
      throw cause;
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) remove();
      throw new Error(`ramose/better-auth: token mint failed with ${response.status}`);
    }
    const bearer = bearerOf(await response.json());
    if (closed) throw new Error("ramose/better-auth: credential provider is closed");
    if (bearer === undefined) throw new Error("ramose/better-auth: token mint returned an invalid credential");
    memory = bearer;
    try {
      localStorage.setItem(key, JSON.stringify(bearer));
      persisted = true;
    } catch { persisted = false; }
    return credential(bearer.token);
  };
  return Object.assign((): Promise<AuthCredential> => {
    if (closed) return Promise.reject(new Error("ramose/better-auth: credential provider is closed"));
    pending ??= renew().then((credential) => {
      if (closed) throw new Error("ramose/better-auth: credential provider is closed");
      return credential;
    }).finally(() => { pending = undefined; });
    return pending;
  }, {
    clear() {
      closed = true;
      controller.abort();
      remove();
    },
  });
};
