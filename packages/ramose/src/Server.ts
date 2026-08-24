/**
 * `Ramose.Server` — a Ramose peer Worker, and every database it serves.
 *
 * The resource owns the peer: it declares the Worker, both Durable Object
 * classes, the pinned compat date, and the fixed binding names. The user
 * names storage and options. `databases:` seeds catalogs at deploy (it is
 * not the directory — that is #215).
 *
 * The explicit `worker:` form is the escape hatch (extra bindings, a
 * user-owned entry). It is validated at deploy: binding names, DO classes,
 * `main` resolution.
 *
 * @resource
 * @product Ramose
 * @category Storage & Databases
 * @section Creating a Server
 * @example The owned form
 * ```typescript
 * export const Server = Ramose.Server("Ramose", {
 *   databases: { todos: Todos },
 *   auth: { policy, jwt: AUTH },
 * });
 * ```
 *
 * @section Using it from a Worker
 * @example Open a database
 * ```typescript
 * const ramose = yield* Ramose.Databases(Server);
 * const movies = ramose.db("movies", Movies);
 * ```
 *
 * Provide `Ramose.layer` in the Worker's runtime. `db()` hands back a
 * {@link import("./server-db.ts").ServerDb} — no `live` / `livePull`.
 */

import type { Worker } from "alchemy/Cloudflare/Workers";
import type { InputProps } from "alchemy/Input";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { isResourceOfType, Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { type AuthConfig, DEFAULT_JWT_MAX_TTL } from "./Auth.ts";
export { DEFAULT_JWT_MAX_TTL } from "./Auth.ts";
import { installCatalog } from "./Database.ts";
import { InvalidRequest, NetworkError } from "./db/Errors.ts";
import { trimSlashes } from "./db/http.ts";
import type { Schema } from "./db/index.ts";
import { declareOwnedPeer, type PeerStorage, validatePeerWiring } from "./peer.ts";
import type { Providers } from "./Providers.ts";
import type { RamoseEnv } from "./RamoseEnv.ts";

/** @internal */
export const isServer = (value: unknown): value is Server =>
  isResourceOfType(value, "Ramose.Server");

/**
 * @internal The Worker that serves this server: a `Cloudflare.Worker` (the
 * resource, or the Effect that declares it), an explicit `{ url }`, or a bare
 * base URL. The escape hatch — omit it and Server declares the peer.
 */
export type ServerWorker =
  | Worker
  | {
      readonly url: string | undefined;
      readonly workerName?: string | undefined;
    }
  | string;

/**
 * A catalog to install at deploy, or a schema plus `doc` destined for the
 * directory (#215). Server seeds the catalog; it does not own the metadata.
 */
export type DatabaseSeed =
  | Schema.Any
  | {
      readonly schema: Schema.Any;
      readonly doc?: string | undefined;
      readonly description?: string | undefined;
    };

export const isSchemaSeed = (value: DatabaseSeed): value is Schema.Any =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === "Schema";

export const schemaOf = (seed: DatabaseSeed): Schema.Any =>
  isSchemaSeed(seed) ? seed : seed.schema;

export const docOf = (seed: DatabaseSeed): string | undefined => {
  if (isSchemaSeed(seed)) return undefined;
  const doc = seed.doc ?? seed.description;
  return doc === undefined || doc === "" ? undefined : doc;
};

/**
 * @internal Deploy-time liveness probe of the server.
 */
export interface ServerProbe {
  /** Total attempts before failing the deploy. @default 30 live, 60 local */
  readonly attempts?: number;
  /** Delay between attempts (ms). @default 2000 live, 250 local */
  readonly delayMs?: number;
  /** Cap on one attempt (ms) — a socket that accepts and never answers. @default 10000 live, 2000 local */
  readonly timeoutMs?: number;
  /** Cap on the whole ladder (ms), retries and sleeps included. @default 120000 live, 30000 local */
  readonly deadlineMs?: number;
}

/** @internal The probe's defaults, per mode. Exported for the tests. */
export const PROBE_DEFAULTS = {
  live: { attempts: 30, delayMs: 2_000, timeoutMs: 10_000, deadlineMs: 120_000 },
  local: { attempts: 60, delayMs: 250, timeoutMs: 2_000, deadlineMs: 30_000 },
} as const satisfies Record<"live" | "local", Required<ServerProbe>>;

/**
 * What the server Worker needs to verify JWTs and enforce a policy.
 *
 * When Server owns the Worker, these are applied onto {@link RamoseEnv}.
 * On the escape hatch they are still the deploy-time fail-closed check;
 * set the matching `RAMOSE_*` keys on the Worker yourself.
 */
export interface ServerAuth {
  /** Compiled policy JSON (`Ramose.Policy.compile(policy)`). Its presence is what arms enforcement. */
  readonly policy?: string | undefined;
  /** Where the issuer's public keys live. Required once `policy` is set. */
  readonly jwksUrl?: string | undefined;
  /**
   * Name of a service binding on the server Worker to fetch `jwksUrl`
   * through. Required when the issuer is another Worker on the same account.
   */
  readonly jwksService?: string | undefined;
  /** Accepted `iss` values — one, or a comma-separated set. Required once `policy` is set. */
  readonly issuers?: readonly string[] | string | undefined;
  /** The `aud` every token must carry. Required once `policy` is set. */
  readonly aud?: string | undefined;
  /** Cap on `exp - iat`, in seconds. @default 900 */
  readonly maxTtl?: number | undefined;
  /**
   * The pinned verifier/minter contract ({@link import("./Auth.ts").claims}
   * builds the matching payload). Stands in for `issuers`, `aud` and
   * `maxTtl`.
   */
  readonly jwt?: AuthConfig | undefined;
  /** Origins the server answers CORS for once a policy narrows it. */
  readonly allowedOrigins?: readonly string[] | string | undefined;
  /** Worker→DO shared secret. See {@link internalSecret}. */
  readonly internalSecret?: Redacted.Redacted<string> | string | undefined;
}

/** @internal The public spelling is the argument of {@link Server}. */
export type ServerProps = {
  /**
   * Escape hatch: a user-owned Worker (operations registry, extra bindings).
   * Validated at deploy (STORE / TRANSACTOR / REPLICA, DO class names, `main`).
   * Omit it and Server declares the peer.
   */
  worker?: ServerWorker;
  /** R2 bucket, or the logical id to declare. @default `"Store"` */
  storage?: PeerStorage;
  /** Peer entry. Defaults to `ramose/worker`. A `createServer({ operations })` module goes here. */
  main?: string;
  /** Extra env bindings on the owned Worker (ANALYTICS, AUTH, tuning, …). */
  env?: Record<string, unknown>;
  /** Physical Worker name override. */
  name?: string;
  /** Local-dev port for the owned peer. */
  dev?: { readonly port?: number };
  /** Alchemy logical id of the owned Worker. @default `"Peer"` */
  peer?: string;
  /**
   * Catalogs to install at deploy. A schema, or `{ schema, doc }` — `doc` is
   * data destined for the directory, not a resource-side authority.
   */
  databases?: Record<string, DatabaseSeed>;
  /** Override the URL resolved from `worker` — a custom domain, say. */
  url?: string;
  /**
   * Bearer token for this server, when it is deployed with `RAMOSE_TOKEN`.
   */
  token?: Redacted.Redacted<string> | string;
  /** Applied onto the owned Worker; deploy-time check on the escape hatch. */
  auth?: ServerAuth;
  /**
   * Bundled operations registry. The owned Worker still needs a `main` that
   * calls `createServer({ operations })` — wiring that is #172.
   */
  operations?: unknown;
  /** `"operations"` rejects raw `/transact` for app-class tokens. */
  writes?: "all" | "operations";
  /**
   * Liveness probe before anything binds to the URL; `false` skips it.
   */
  probe?: ServerProbe | false;
};

/**
 * @internal Env keys the auth fields lower onto. Values are `keyof RamoseEnv`.
 */
export const AUTH_ENV_KEYS = {
  policy: "RAMOSE_POLICY",
  jwksUrl: "RAMOSE_JWKS_URL",
  jwksService: "RAMOSE_JWKS_SERVICE",
  issuers: "RAMOSE_JWT_ISS",
  aud: "RAMOSE_JWT_AUD",
  maxTtl: "RAMOSE_JWT_MAX_TTL",
  allowedOrigins: "RAMOSE_ALLOWED_ORIGINS",
  internalSecret: "RAMOSE_INTERNAL_SECRET",
} as const satisfies Record<
  Exclude<keyof ServerAuth, "jwt">,
  keyof RamoseEnv
>;

const withAuthConfig = (auth: ServerAuth): ServerAuth =>
  auth.jwt === undefined
    ? auth
    : {
        ...auth,
        issuers: auth.issuers ?? auth.jwt.issuer,
        aud: auth.aud ?? auth.jwt.audience,
        maxTtl: auth.maxTtl ?? auth.jwt.ttl,
      };

const list = (value: readonly string[] | string | undefined): string | undefined => {
  const items = (typeof value === "string" ? value.split(",") : (value ?? []))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length === 0 ? undefined : items.join(",");
};

/**
 * @internal Mint (or pass through) the Worker→DO secret.
 */
export const internalSecret = (
  value?: Redacted.Redacted<string> | string | undefined,
): Redacted.Redacted<string> => {
  if (value !== undefined && value !== "") {
    return typeof value === "string" ? Redacted.make(value) : value;
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Redacted.make(
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
  );
};

/**
 * @internal The server Worker's auth env, as bindings. Unset fields emit no
 * key. A set `policy` also binds {@link internalSecret}.
 */
export const authEnv = (
  peerAuth: ServerAuth | undefined,
): Record<string, string | Redacted.Redacted<string>> => {
  if (peerAuth === undefined) return {};
  const auth = withAuthConfig(peerAuth);
  const k = AUTH_ENV_KEYS;
  const env: Record<string, string | Redacted.Redacted<string>> = {};
  const set = (key: string, value: string | Redacted.Redacted<string> | undefined) => {
    if (value !== undefined && value !== "") env[key] = value;
  };
  set(k.policy, auth.policy);
  set(k.jwksUrl, auth.jwksUrl);
  set(k.jwksService, auth.jwksService);
  set(k.issuers, list(auth.issuers));
  set(k.aud, auth.aud);
  set(k.maxTtl, auth.maxTtl === undefined ? undefined : String(auth.maxTtl));
  set(k.allowedOrigins, list(auth.allowedOrigins));
  const secret = auth.internalSecret;
  const pinned = secret !== undefined && secret !== "";
  if (pinned || (auth.policy !== undefined && auth.policy !== "")) {
    env[k.internalSecret] = internalSecret(secret);
  }
  return env;
};

const checkAuth = (peerAuth: ServerAuth | undefined): string | undefined => {
  if (peerAuth === undefined || peerAuth.policy === undefined || peerAuth.policy === "") {
    return undefined;
  }
  const auth = withAuthConfig(peerAuth);
  const missing: string[] = [];
  if (auth.jwksUrl === undefined || auth.jwksUrl === "") missing.push(AUTH_ENV_KEYS.jwksUrl);
  if (list(auth.issuers) === undefined) missing.push(AUTH_ENV_KEYS.issuers);
  if (auth.aud === undefined || auth.aud === "") missing.push(AUTH_ENV_KEYS.aud);
  if (missing.length > 0) {
    return `ramose: auth.policy is set but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not — a configured policy makes JWT verification mandatory, and an incomplete verifier denies every /db/*`;
  }
  if (auth.maxTtl !== undefined && (!Number.isFinite(auth.maxTtl) || auth.maxTtl <= 0)) {
    return `ramose: auth.maxTtl must be a positive number of seconds (default ${DEFAULT_JWT_MAX_TTL})`;
  }
  return undefined;
};

export type Server = Resource<
  "Ramose.Server",
  ServerProps,
  {
    /** Base URL, no trailing slash. */
    url: string;
    /** The server Worker's script name, or `""` when it was given as a URL. */
    workerName: string;
    /** The bearer token, when one was configured. */
    token: Redacted.Redacted<string> | undefined;
    /**
     * Catalogs this deploy seeded. Install results, not directory state —
     * `doc` is passed through for #215 and is not authoritative here.
     */
    seeded: readonly {
      readonly name: string;
      readonly t: number;
      readonly doc?: string | undefined;
    }[];
  },
  never,
  Providers
>;

const ServerResource = Resource<Server>("Ramose.Server");

/**
 * Declare a Ramose server.
 *
 * Without `worker`, Server declares the peer (R2, both DO classes, the
 * Worker, {@link import("./peer.ts").PEER_COMPAT}, fixed bindings) and
 * applies `auth` onto its env. With `worker`, that form is validated and
 * kept as the escape hatch.
 */
export const Server = Object.assign(
  (id: string, props: InputProps<ServerProps>) =>
    ServerResource(
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
          authEnv: authEnv(props.auth as ServerAuth | undefined),
        });
        return { ...props, worker } as InputProps<ServerProps>;
      }) as unknown as Effect.Effect<InputProps<ServerProps>, never, never>,
    ),
  ServerResource,
) as typeof ServerResource;

/** @internal `{ url, workerName }` out of whichever Worker form was given. */
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

const redact = (
  token: Redacted.Redacted<string> | string | undefined,
): Redacted.Redacted<string> | undefined =>
  token === undefined
    ? undefined
    : typeof token === "string"
      ? Redacted.make(token)
      : token;

/**
 * @internal One `GET {url}/health`; a non-2xx is a failure so the retry policy
 * sees it, and so is silence past `timeoutMs`.
 */
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

/**
 * @internal Probe the server, with retries.
 */
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

const seedDatabases = (
  url: string,
  token: Redacted.Redacted<string> | undefined,
  databases: Record<string, DatabaseSeed> | undefined,
) =>
  Effect.gen(function* () {
    if (databases === undefined) return [] as Server["Attributes"]["seeded"];
    const seeded: { name: string; t: number; doc?: string }[] = [];
    for (const [name, seed] of Object.entries(databases)) {
      const report = yield* installCatalog({
        name,
        url,
        token,
        schema: schemaOf(seed),
      });
      const doc = docOf(seed);
      seeded.push(doc === undefined ? { name: report.name, t: report.t } : { name: report.name, t: report.t, doc });
    }
    return seeded;
  });

const attributes = Effect.fn(function* (
  props: ServerProps,
  defaults: Required<ServerProbe>,
) {
  const badAuth = checkAuth(props.auth);
  if (badAuth !== undefined) return yield* Effect.fail(new InvalidRequest({ message: badAuth }));
  if (props.worker !== undefined) {
    const badWiring = validatePeerWiring(props.worker);
    if (badWiring !== undefined) {
      return yield* Effect.fail(new InvalidRequest({ message: badWiring }));
    }
  }
  const worker = resolveWorker(props.worker as ServerWorker);
  const chosen = props.url ?? worker.url;
  if (chosen === undefined || chosen === "") {
    return yield* Effect.fail(
      new InvalidRequest({
        message:
          "ramose: the server has no URL — pass a deployed Cloudflare.Worker (workers.dev or a custom domain) or an explicit `url`",
      }),
    );
  }
  const url = trimSlashes(chosen);
  yield* probeHealth(url, props.probe, defaults);
  const token = redact(props.token);
  const seeded = yield* seedDatabases(url, token, props.databases);
  return {
    url,
    workerName: worker.workerName,
    token,
    seeded,
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
    delete: Effect.fn(function* () {}),
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

/** @internal Registered by `providers()`. */
export const ServerProvider = () =>
  ProviderLayer.dual(Server, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
