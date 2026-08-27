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
 * `main` resolution, and `auth` against the Worker env.
 *
 * @resource
 * @product Ramose
 * @category Storage & Databases
 * @section Creating a Server
 * @example The owned form
 * ```typescript
 * export const Server = Ramose.Server("Ramose", {
 *   databases: { todos: Todos },
 *   operations,
 *   auth: { jwt: AUTH },
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
import { InvalidRequest, NetworkError, OperationsCoverageError } from "./db/Errors.ts";
import {
  type AnyOperations,
  checkOperationsCoverage,
} from "./db/Operation.ts";
import { trimSlashes } from "./db/http.ts";
import type { Schema } from "./db/index.ts";
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
 *
 * Both providers run it. A server that never answers is not a hypothetical:
 * under `alchemy dev` the local Worker's proxy binds its port and reports
 * "ready" *before* the bundle is served, so a Worker that never finishes
 * bundling leaves a socket that accepts connections and answers nothing. Every
 * attempt is therefore bounded by {@link timeoutMs} and the whole ladder by
 * {@link deadlineMs} — without those, "unreachable" and "silent" are the same
 * thing to `fetch`, and the deploy hangs forever with no error to print.
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
  /**
   * Where the issuer's public keys live. Reserved for #412 verified
   * principals. External `/db/*` is fail-closed until that lands.
   */
  readonly jwksUrl?: AuthEnvValue | undefined;
  /** Literal JWK Set for offline / test verification; mutually exclusive with {@link jwksUrl}. */
  readonly jwksJson?: AuthEnvValue | undefined;
  /**
   * Name of a service binding on the server Worker to fetch `jwksUrl`
   * through. Required when the issuer is another Worker on the same account.
   */
  readonly jwksService?: string | undefined;
  /**
   * Accepted `iss` values — one, or a comma-separated set.
   */
  readonly issuers?: readonly string[] | AuthEnvValue | undefined;
  /**
   * The `aud` every token must carry.
   */
  readonly aud?: string | undefined;
  /** Cap on `exp - iat`, in seconds. @default 900 */
  readonly maxTtl?: number | undefined;
  /**
   * The pinned verifier/minter contract ({@link import("./Auth.ts").claims}
   * builds the matching payload). Stands in for `issuers`, `aud` and
   * `maxTtl`.
   */
  readonly jwt?: AuthConfig | undefined;
  /** Origins the server answers CORS for. */
  readonly allowedOrigins?: readonly string[] | AuthEnvValue | undefined;
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
  /** Zone routes on the owned Worker (`/db/*` on a custom hostname). */
  routes?: PeerRoute[];
  /**
   * Catalogs to install at deploy. A schema, or `{ schema, doc }` — `doc` is
   * data destined for the directory, not a resource-side authority.
   */
  databases?: Record<string, DatabaseSeed>;
  /**
   * The operations registry this deploy ships — the same value the app
   * imports and the peer entry `createServer({ operations })`s. After
   * the health probe, Server compares its ids to `GET /health` and
   * fails the deploy on a missing id. The registry shape (`names` /
   * `cards`) is what later MCP `learn` reads; this issue does not
   * implement that endpoint.
   */
  operations?: AnyOperations;
  /** Override the URL resolved from `worker` — a custom domain, say. */
  url?: string;
  /**
   * Source of truth for Worker auth env. Owned form applies it; hatch
   * form compares it and fails the deploy on divergence.
   */
  auth?: ServerAuth;
  /**
   * Liveness probe before anything binds to the URL; `false` skips it.
   */
  probe?: ServerProbe | false;
};

/**
 * @internal Env keys the auth fields lower onto. Values are `keyof RamoseEnv`.
 */
export const AUTH_ENV_KEYS = {
  jwksUrl: "RAMOSE_JWKS_URL",
  jwksJson: "RAMOSE_JWKS_JSON",
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
 * key. Output / Effect values pass through (Reef's JWKS URL and origins).
 * A pinned `internalSecret` is bound; otherwise no Worker→DO secret is
 * emitted.
 */
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
  const secret = auth.internalSecret;
  if (isBound(secret)) {
    env[k.internalSecret] = internalSecret(secret as Redacted.Redacted<string> | string | undefined);
  }
  return env;
};

/**
 * @internal The server Worker's auth env, as bindings. Unset fields emit no
 * key. A pinned `internalSecret` is bound.
 */
export const authEnv = (
  peerAuth: ServerAuth | undefined,
): Record<string, unknown> => bindAuthFields(peerAuth);

/**
 * @internal Completeness: `maxTtl` must be a positive number of seconds.
 */
export const checkAuth = (peerAuth: ServerAuth | undefined): string | undefined => {
  if (peerAuth === undefined) return undefined;
  const auth = withAuthConfig(peerAuth);
  if (auth.maxTtl !== undefined && (!Number.isFinite(auth.maxTtl) || auth.maxTtl <= 0)) {
    return `ramose: auth.maxTtl must be a positive number of seconds (default ${DEFAULT_JWT_MAX_TTL})`;
  }
  return undefined;
};

const unwrapBinding = (value: unknown): unknown =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const normalizeBinding = (value: unknown): unknown => {
  const raw = unwrapBinding(value);
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
  const a = unwrapBinding(expected);
  const b = unwrapBinding(actual);
  if (a === b) return true;
  if (typeof a === "object" || typeof b === "object") return false;
  return normalizeBinding(a) === normalizeBinding(b);
};

/**
 * @internal Hatch form: `auth` must match the Worker env.
 * URL workers have no env and are skipped.
 */
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
  const pinnedSecret = isBound(peerAuth?.internalSecret);
  for (const key of keys) {
    if (key === AUTH_ENV_KEYS.internalSecret && !pinnedSecret) continue;
    const want = expected[key];
    const got = env[key];
    if (isBound(want) !== isBound(got) || (isBound(want) && isBound(got) && !sameBinding(want, got))) {
      diverged.push(key);
    }
  }
  if (diverged.length === 0) return undefined;
  return `ramose: Server auth and the Worker env diverge on ${diverged.join(", ")} — Server({ auth }) is the source of truth`;
};

const healthOperationsOf = (health: unknown): string[] => {
  if (typeof health !== "object" || health === null) return [];
  const listed = (health as { operations?: unknown }).operations;
  if (!Array.isArray(listed)) return [];
  return listed.filter((n): n is string => typeof n === "string");
};

/**
 * @internal `Server({ operations })` vs a `/health` body. Missing ids
 * fail the deploy as {@link OperationsCoverageError} so `missing` and
 * `instanceof` survive; extra peer ops are fine. Unset `operations` skips.
 */
export const compareOperationsToHealth = (
  operations: AnyOperations | undefined,
  health: unknown,
): OperationsCoverageError | undefined => {
  if (operations === undefined) return undefined;
  try {
    checkOperationsCoverage(operations, healthOperationsOf(health));
    return undefined;
  } catch (error) {
    if (error instanceof OperationsCoverageError) return error;
    throw error;
  }
};

/**
 * @internal One attempt's budget for the coverage `GET /health`.
 *
 * Same resolution as {@link probeHealth}: a caller-supplied
 * `probe.timeoutMs` wins; `probe: false` and an unset probe fall back
 * to the provider default. The coverage fetch is a second request, so
 * it has to share that budget — otherwise a slow peer that just passed
 * a 60s probe still dies on the 10s live / 2s local default.
 */
export const coverageTimeoutMs = (
  probe: ServerProbe | false | undefined,
  defaults: Required<ServerProbe>,
): number =>
  probe === false
    ? defaults.timeoutMs
    : (probe?.timeoutMs ?? defaults.timeoutMs);

const fetchHealthJson = (url: string, timeoutMs: number) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(`${trimSlashes(url)}/health`, { method: "GET", signal }).then(
        async (response) => {
          let body: unknown = {};
          try {
            body = await response.json();
          } catch {
            body = {};
          }
          if (!response.ok) {
            throw new Error(`health ${response.status}`);
          }
          return body;
        },
      ),
    catch: (cause) =>
      new NetworkError({
        message: `ramose: server at ${url} is unreachable: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      }),
  }).pipe(
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

export type Server = Resource<
  "Ramose.Server",
  ServerProps,
  {
    /** Base URL, no trailing slash. */
    url: string;
    /** The server Worker's script name, or `""` when it was given as a URL. */
    workerName: string;
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
 * applies `auth` onto its env. With `worker`, that
 * form is validated — bindings, DO classes, `main`, and `auth`
 * against the Worker env — and kept as the escape hatch.
 */
const ownedPeers = new WeakSet<object>();

export const Server = Object.assign(
  (id: string, props: InputProps<ServerProps>) => {
    // Durable Object declarations must be created here — at the stack
    // module's `Ramose.Server(…)` call — so Alchemy registers them as
    // top-level `TransactorDO` / `QueryReplicaDO` resources. Creating
    // them inside `Worker({ env })` nests them as `[Worker/TRANSACTOR]`
    // bindings and never gives the namespaces their own logical ids.
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

/**
 * @internal One `GET {url}/health`; a non-2xx is a failure so the retry policy
 * sees it, and so is silence past `timeoutMs`.
 *
 * The timeout is the load-bearing part. `fetch` has no deadline of its own, so
 * a socket that completes its TCP handshake and then answers nothing — a local
 * Worker whose bundle never landed, a hung isolate — parks the whole deploy on
 * one unresolved promise. Bounding the attempt turns that into an ordinary
 * failure the ladder can retry and, eventually, report.
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
  _url: string,
  _databases: Record<string, DatabaseSeed> | undefined,
) =>
  Effect.succeed([] as Server["Attributes"]["seeded"]);

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
  if (props.operations !== undefined) {
    const body = yield* fetchHealthJson(url, coverageTimeoutMs(props.probe, defaults));
    const badOps = compareOperationsToHealth(props.operations, body);
    if (badOps !== undefined) {
      return yield* badOps;
    }
  }
  const seeded = yield* seedDatabases(url, props.databases);
  return {
    url,
    workerName: worker.workerName,
    seeded,
  };
});

const ProviderLive = () =>
  Provider.succeed(Server, {
    reconcile: Effect.fn(function* ({ news }) {
      return yield* attributes(news, PROBE_DEFAULTS.live);
    }),
    read: Effect.fn(function* ({ output }) {
      // Virtual: the persisted state row is the source of truth.
      return output ?? undefined;
    }),
    delete: Effect.fn(function* () {
      // Ramose databases are append-only and immutable; destroying the
      // resource forgets the *server*, it does not erase any log, the segments
      // in R2, or the Durable Objects. Deleting the data is a separate,
      // deliberate act (empty the bucket, delete the DO namespaces).
    }),
  });

/**
 * @internal Local provider (`alchemy dev`): the same attributes, and the same
 * probe on a tighter ladder.
 *
 * It used to skip the probe on the reasoning that a local Worker the engine
 * already ordered us after must be up. It need not be. `alchemy dev` binds the
 * Worker's proxy port and logs "ready" before the first bundle is served, so a
 * peer whose bundle never lands — a `main` the bundler cannot resolve, a syntax
 * error in user code — leaves a socket that accepts connections and answers
 * nothing. Skipping the probe here handed that server to `Ramose.Database`,
 * whose install then blocked on an unresolvable `fetch` until the run was torn
 * down and printed a bare `fail` with no reason. Probing puts the failure on
 * the resource that owns the URL, with the URL in the message.
 */
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
// Kept as a zero-argument factory rather than a bare Layer value: as a
// value the whole provider graph would be constructed at module load,
// on every import, instead of when a stack actually asks for it. It is
// also the shape alchemy uses in every provider package it ships.
// @effect-diagnostics-next-line lazyEffect:off
export const ServerProvider = () =>
  ProviderLayer.dual(Server, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
