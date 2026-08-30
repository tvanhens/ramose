import type { Worker } from "alchemy/Cloudflare/Workers";
import type { InputProps } from "alchemy/Input";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { isResourceOfType, Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { type AuthConfig, DEFAULT_JWT_MAX_TTL } from "./Auth.ts";
export { DEFAULT_JWT_MAX_TTL } from "./Auth.ts";
import { InvalidRequest, NetworkError } from "./db/Errors.ts";
import {
  declareOwnedPeer,
  ownedPeerDurableObjects,
  type PeerRoute,
  type PeerStorage,
  validatePeerWiring,
  workerEnvOf,
} from "./peer.ts";
import type { Providers } from "./Providers.ts";
import type { RamoseEnv } from "./RamoseEnv.ts";

export const isServer = (value: unknown): value is Server =>
  isResourceOfType(value, "Ramose.Server");

export type ServerWorker =
  | Worker
  | {
      readonly url: string | undefined;
      readonly workerName?: string | undefined;
    }
  | string;

const trimSlashes = (value: string): string => value.replace(/\/+$/, "");

export interface ServerProbe {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly timeoutMs?: number;
  readonly deadlineMs?: number;
}

export const PROBE_DEFAULTS = {
  live: { attempts: 30, delayMs: 2_000, timeoutMs: 10_000, deadlineMs: 120_000 },
  local: { attempts: 60, delayMs: 250, timeoutMs: 2_000, deadlineMs: 30_000 },
} as const satisfies Record<"live" | "local", Required<ServerProbe>>;

/**
 * A string, or an Alchemy Output / Effect that resolves to one at deploy.
 * Reef's JWKS URL and CORS origins are interpolations over the auth Worker;
 * owned form writes them onto the Worker, hatch form compares by identity.
 */
export type AuthEnvValue = string | object;

/**
 * What the server Worker needs to verify JWTs.
 *
 * When Server owns the Worker, these are applied onto {@link RamoseEnv}.
 * On the escape hatch they are compared against the Worker's env and
 * fail the deploy on divergence — do not configure auth only on the Worker.
 */
export interface ServerAuth {
  readonly jwksUrl?: AuthEnvValue | undefined;
  readonly jwksJson?: AuthEnvValue | undefined;
  readonly jwksService?: string | undefined;
  readonly issuers?: readonly string[] | AuthEnvValue | undefined;
  readonly aud?: string | undefined;
  readonly maxTtl?: number | undefined;
  readonly jwt?: AuthConfig | undefined;
  readonly allowedOrigins?: readonly string[] | AuthEnvValue | undefined;
}

export type ServerProps = {
  worker?: ServerWorker;
  storage?: PeerStorage;
  main?: string;
  env?: Record<string, unknown>;
  name?: string;
  dev?: { readonly port?: number };
  peer?: string;
  routes?: PeerRoute[];
  url?: string;
  auth?: ServerAuth;
  probe?: ServerProbe | false;
};

export const AUTH_ENV_KEYS = {
  jwksUrl: "RAMOSE_JWKS_URL",
  jwksJson: "RAMOSE_JWKS_JSON",
  jwksService: "RAMOSE_JWKS_SERVICE",
  issuers: "RAMOSE_JWT_ISS",
  aud: "RAMOSE_JWT_AUD",
  maxTtl: "RAMOSE_JWT_MAX_TTL",
  allowedOrigins: "RAMOSE_ALLOWED_ORIGINS",
} as const satisfies Record<
  Exclude<keyof ServerAuth, "jwt">,
  keyof RamoseEnv
>;

const AUTH_COMPARE_KEYS = [
  AUTH_ENV_KEYS.jwksUrl,
  AUTH_ENV_KEYS.jwksJson,
  AUTH_ENV_KEYS.jwksService,
  AUTH_ENV_KEYS.issuers,
  AUTH_ENV_KEYS.aud,
  AUTH_ENV_KEYS.maxTtl,
  AUTH_ENV_KEYS.allowedOrigins,
] as const;

const withAuthConfig = (auth: ServerAuth): ServerAuth =>
  auth.jwt === undefined
    ? auth
    : {
        ...auth,
        issuers: auth.issuers ?? auth.jwt.issuer,
        aud: auth.aud ?? auth.jwt.audience,
        maxTtl: auth.maxTtl ?? auth.jwt.ttl,
      };

const isBound = (value: unknown): boolean => value !== undefined && value !== "";

const list = (value: unknown): unknown => {
  if (!isBound(value)) return undefined;
  if (typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"))) {
    const items = (typeof value === "string" ? value.split(",") : value)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return items.length === 0 ? undefined : items.join(",");
  }
  return value;
};

const bindAuthFields = (
  peerAuth: ServerAuth | undefined,
): Record<string, unknown> => {
  if (peerAuth === undefined) return {};
  const auth = withAuthConfig(peerAuth);
  const k = AUTH_ENV_KEYS;
  const env: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (isBound(value)) env[key] = value;
  };
  set(k.jwksUrl, auth.jwksUrl);
  set(k.jwksJson, auth.jwksJson);
  set(k.jwksService, auth.jwksService);
  set(k.issuers, list(auth.issuers));
  set(k.aud, auth.aud);
  set(k.maxTtl, auth.maxTtl === undefined ? undefined : String(auth.maxTtl));
  set(k.allowedOrigins, list(auth.allowedOrigins));
  return env;
};

export const authEnv = (
  peerAuth: ServerAuth | undefined,
): Record<string, unknown> => bindAuthFields(peerAuth);

export const checkAuth = (peerAuth: ServerAuth | undefined): string | undefined => {
  if (peerAuth === undefined) return undefined;
  const auth = withAuthConfig(peerAuth);
  if (auth.maxTtl !== undefined && (!Number.isFinite(auth.maxTtl) || auth.maxTtl <= 0)) {
    return `ramose: auth.maxTtl must be a positive number of seconds (default ${DEFAULT_JWT_MAX_TTL})`;
  }
  return undefined;
};

const normalizeBinding = (value: unknown): unknown => {
  const raw = value;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort()
      .join(",");
  }
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string" || typeof item === "number")) {
    return raw
      .map((item) => String(item).trim())
      .filter((s) => s.length > 0)
      .sort()
      .join(",");
  }
  return raw;
};

const sameBinding = (expected: unknown, actual: unknown): boolean => {
  if (expected === actual) return true;
  const a = expected;
  const b = actual;
  if (a === b) return true;
  if (typeof a === "object" || typeof b === "object") return false;
  return normalizeBinding(a) === normalizeBinding(b);
};

export const compareAuthToWorker = (
  peerAuth: ServerAuth | undefined,
  worker: unknown,
): string | undefined => {
  if (typeof worker === "string") return undefined;
  const env = workerEnvOf(worker);
  if (env === undefined) return undefined;

  const expected = bindAuthFields(peerAuth);

  const keys = new Set<string>([...AUTH_COMPARE_KEYS, ...Object.keys(expected)]);
  const diverged: string[] = [];
  for (const key of keys) {
    const want = expected[key];
    const got = env[key];
    if (isBound(want) !== isBound(got) || (isBound(want) && isBound(got) && !sameBinding(want, got))) {
      diverged.push(key);
    }
  }
  if (diverged.length === 0) return undefined;
  return `ramose: Server auth and the Worker env diverge on ${diverged.join(", ")} — Server({ auth }) is the source of truth`;
};

export type Server = Resource<
  "Ramose.Server",
  ServerProps,
  {
    url: string;
    workerName: string;
  },
  never,
  Providers
>;

const ServerResource = Resource<Server>("Ramose.Server");

const ownedPeers = new WeakSet<object>();

export const Server = Object.assign(
  (id: string, props: InputProps<ServerProps>) => {
    const durableObjects =
      props.worker === undefined ? ownedPeerDurableObjects() : undefined;
    return ServerResource(
      id,
      Effect.gen(function* () {
        const given = props.worker as
          | ServerWorker
          | Effect.Effect<ServerWorker, unknown, never>
          | undefined;
        if (given !== undefined) {
          const worker = Effect.isEffect(given) ? yield* given : given;
          return { ...props, worker } as InputProps<ServerProps>;
        }
        const worker = yield* declareOwnedPeer({
          storage: props.storage as PeerStorage | undefined,
          main: props.main as string | undefined,
          env: props.env as Record<string, unknown> | undefined,
          name: props.name as string | undefined,
          dev: props.dev as { readonly port?: number } | undefined,
          peer: props.peer as string | undefined,
          routes: props.routes as PeerRoute[] | undefined,
          authEnv: authEnv(props.auth as ServerAuth | undefined),
          durableObjects,
        });
        if (typeof worker === "object" && worker !== null) ownedPeers.add(worker);
        return { ...props, worker } as InputProps<ServerProps>;
      }) as unknown as Effect.Effect<InputProps<ServerProps>, never, never>,
    );
  },
  ServerResource,
) as typeof ServerResource;

export const resolveWorker = (
  worker: ServerWorker,
): { url: string | undefined; workerName: string } => {
  if (typeof worker === "string") return { url: worker, workerName: "" };
  const resolved = worker as unknown as {
    url?: string | undefined;
    workerName?: string | undefined;
  };
  return { url: resolved?.url, workerName: resolved?.workerName ?? "" };
};

export const healthOnce = (url: string, timeoutMs: number) =>
  Effect.tryPromise({
    try: (signal) => fetch(`${trimSlashes(url)}/health`, { method: "GET", signal }),
    catch: (cause) =>
      new NetworkError({
        message: `ramose: server at ${url} is unreachable: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.void
        : Effect.fail(
            new NetworkError({
              message: `ramose: server at ${url} answered /health with ${response.status}`,
            }),
          ),
    ),
    Effect.timeoutOrElse({
      duration: `${Math.max(1, timeoutMs)} millis`,
      orElse: () =>
        Effect.fail(
          new NetworkError({
            message: `ramose: server at ${url} accepted the connection but did not answer GET /health within ${timeoutMs}ms`,
          }),
        ),
    }),
  );

export const probeHealth = (
  url: string,
  probe: ServerProbe | false | undefined,
  defaults: Required<ServerProbe>,
) => {
  if (probe === false) return Effect.void;
  const attempts = Math.max(1, probe?.attempts ?? defaults.attempts);
  const delayMs = probe?.delayMs ?? defaults.delayMs;
  const timeoutMs = probe?.timeoutMs ?? defaults.timeoutMs;
  const deadlineMs = probe?.deadlineMs ?? defaults.deadlineMs;
  return healthOnce(url, timeoutMs).pipe(
    Effect.retry({ times: attempts - 1, schedule: Schedule.spaced(delayMs) }),
    Effect.timeoutOrElse({
      duration: `${Math.max(1, deadlineMs)} millis`,
      orElse: () =>
        Effect.fail(
          new NetworkError({
            message: `ramose: server at ${url} did not answer GET /health within ${deadlineMs}ms — is the Worker that serves it running? Under \`alchemy dev\` a Worker whose bundle failed still binds its port and answers nothing.`,
          }),
        ),
    }),
  );
};

const attributes = Effect.fn(function* (
  props: ServerProps,
  defaults: Required<ServerProbe>,
) {
  const badAuth = checkAuth(props.auth);
  if (badAuth !== undefined) return yield* new InvalidRequest({ message: badAuth });
  if (props.worker !== undefined) {
    const badWiring = validatePeerWiring(props.worker);
    if (badWiring !== undefined) {
      return yield* new InvalidRequest({ message: badWiring });
    }
    const hatch =
      typeof props.worker !== "object" ||
      props.worker === null ||
      !ownedPeers.has(props.worker);
    if (hatch) {
      const badMatch = compareAuthToWorker(props.auth, props.worker);
      if (badMatch !== undefined) {
        return yield* new InvalidRequest({ message: badMatch });
      }
    }
  }
  const worker = resolveWorker(props.worker as ServerWorker);
  const chosen = props.url ?? worker.url;
  if (chosen === undefined || chosen === "") {
    return yield* new InvalidRequest({
      message:
        "ramose: the server has no URL — pass a deployed Cloudflare.Worker (workers.dev or a custom domain) or an explicit `url`",
    });
  }
  const url = trimSlashes(chosen);
  yield* probeHealth(url, props.probe, defaults);
  return {
    url,
    workerName: worker.workerName,
  };
});

const ProviderLive = () =>
  Provider.succeed(Server, {
    reconcile: Effect.fn(function* ({ news }) {
      return yield* attributes(news, PROBE_DEFAULTS.live);
    }),
    read: Effect.fn(function* ({ output }) {
      return output ?? undefined;
    }),
    delete: Effect.fn(function* () {
    }),
  });

const ProviderLocal = () =>
  Provider.succeed(Server, {
    reconcile: Effect.fn(function* ({ news }) {
      return yield* attributes(news, PROBE_DEFAULTS.local);
    }),
    read: Effect.fn(function* ({ output }) {
      return output ?? undefined;
    }),
    delete: Effect.fn(function* () {}),
  });

// @effect-diagnostics-next-line lazyEffect:off
export const ServerProvider = () =>
  ProviderLayer.dual(Server, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
