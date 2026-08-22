/**
 * `Ramose.Server` — a Ramose peer Worker, and every database it serves.
 *
 * A Ramose database is not a cloud object you create with an API call: it is
 * a *name*. The server Worker routes `/db/:name/*` to a Transactor Durable
 * Object (`idFromName(name)`) and to region-local QueryReplicas, and the log
 * and segments live under `db/<name>/…` in R2. The first transaction
 * materializes it. There is no create-database endpoint, and no list.
 *
 * So the resource is not a database — it is the server that serves them all.
 * It creates nothing: it resolves the Worker's URL and, on a live deploy,
 * proves the Worker is actually up before anything downstream binds to it.
 * Naming a database is a function call (`ramose.db(name, catalog)`), which is
 * why one deploy can serve a database per tenant without a resource per
 * tenant. Installing a catalog on one of those names is
 * {@link import("./Database.ts").Database}.
 *
 * @resource
 * @product Ramose
 * @category Storage & Databases
 * @section Creating a Server
 * @example Declaring the server on its Worker
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Ramose from "ramose";
 *
 * const RamoseWorker = Cloudflare.Worker("RamoseWorker", { main: import.meta.resolve("ramose/worker") });
 * export const Server = Ramose.Server("Ramose", { worker: RamoseWorker });
 * export const TodosDb = Ramose.Database("todos", { server: Server, catalog: Todos });
 * ```
 *
 * `main` is a **path**, not a module specifier — Alchemy `realpath`s it before
 * bundling — which is why the package name goes through `import.meta.resolve`.
 * `Ramose.workerEntry()` from `ramose/workerEntry` is the same
 * resolution under a name. A bare `"ramose/worker"` resolves against the
 * working directory, finds nothing, and leaves a Worker that binds its port
 * and never answers; the probe below is what turns that into an error.
 *
 * @section Using it from a Worker
 * @example Open a database, then transact and query
 * ```typescript
 * const ramose = yield* Ramose.ReadWriteDatabases(Server);
 * const movies = ramose.db("movies", Movies);
 * const { dbAfter } = yield* movies.transact(function* (tx) {
 *   const ada = yield* tx.entity();
 *   yield* ada.add(User.name, "Ada");
 * });
 * const rows = yield* dbAfter.q(
 *   Ramose.Query.q(() => pipe(Ramose.Query.entities(User), Ramose.Query.select({ name: User.name }))),
 * );
 * ```
 *
 * Provide `Ramose.ServerBinding` (a Worker service binding to the server) or
 * `Ramose.ServerHttp` (plain HTTPS — also what an `Alchemy.Action` and
 * `alchemy dev` use) in the Worker's runtime layer. `Ramose.ReadDatabases` is
 * the least-privilege half of `ReadWriteDatabases`: the `db()` it hands back
 * has no `transact` and no `install`.
 */

import type { Worker } from "alchemy/Cloudflare/Workers";
import type { InputProps } from "alchemy/Input";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { isResourceOfType, Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { AuthConfig } from "./Auth.ts";
import { InvalidRequest, NetworkError } from "./db/Errors.ts";
import type { Providers } from "./Providers.ts";

/** @internal */
export const isServer = (value: unknown): value is Server =>
  isResourceOfType(value, "Ramose.Server");

/**
 * @internal The Worker that serves this server: a `Cloudflare.Worker` (the
 * resource, or the Effect that declares it), an explicit `{ url }`, or a bare
 * base URL.
 *
 * `workerName` is only needed by {@link import("./ServerBinding.ts")}, which
 * lowers a `service` binding onto the host Worker; `ServerHttp` works from
 * `url` alone.
 */
export type ServerWorker =
  | Worker
  | {
      readonly url: string | undefined;
      readonly workerName?: string | undefined;
    }
  | string;

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
 * What the server Worker needs to verify JWTs and enforce a policy.
 *
 * The Server does **not** push these onto the Worker: spread {@link authEnv}
 * into the Worker's own `env`, and pass the same value here for the
 * deploy-time fail-closed check.
 *
 * With `policy` unset the server runs today's mode: `RAMOSE_TOKEN` if set,
 * otherwise open.
 */
export interface PeerAuth {
  /** Compiled policy JSON (`Ramose.Policy.compile(policy)`). Its presence is what arms enforcement. */
  readonly policy?: string | undefined;
  /** Where the issuer's public keys live. Required once `policy` is set. */
  readonly jwksUrl?: string | undefined;
  /**
   * Name of a service binding on the server Worker to fetch `jwksUrl`
   * through. Required when the issuer is another Worker on the same account:
   * Cloudflare answers a Worker→Worker subrequest over `*.workers.dev` with
   * error 1042, so the peer must dispatch through the binding. Bind the
   * issuer Worker under this name in the same `env` (examples/reef).
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
   * `maxTtl`; when one of those is also set explicitly, the explicit key
   * wins.
   */
  readonly auth?: AuthConfig | undefined;
  /** Origins the server answers CORS for once a policy narrows it. */
  readonly allowedOrigins?: readonly string[] | string | undefined;
  /** Worker→DO shared secret; every internal fetch carries it. See {@link internalSecret}. */
  readonly internalSecret?: Redacted.Redacted<string> | string | undefined;
}

/** @internal The public spelling is the argument of {@link Server}. */
export type ServerProps = {
  /** The Worker that serves `/db/:name/*` (or a URL, when it is not ours to deploy). */
  worker: ServerWorker;
  /** Override the URL resolved from `worker` — a custom domain, say. */
  url?: string;
  /**
   * Bearer token for this server, when it is deployed with `RAMOSE_TOKEN`.
   * Stored as a `Redacted` attribute and lowered onto consumers as a
   * `secret_text` binding. This is the server's one token: it covers every
   * database name it serves, and is ignored when the Worker has
   * `RAMOSE_TOKEN` unset. It is *not* a data-plane principal on a named
   * database once a policy is configured — a JWT is the only way to be one.
   */
  token?: Redacted.Redacted<string> | string;
  /** The server's auth configuration, for a deploy-time consistency check only. */
  auth?: PeerAuth;
  /**
   * Liveness probe before anything binds to the URL, in both modes (`alchemy
   * dev` runs it on a tighter ladder); `false` skips it.
   */
  probe?: ServerProbe | false;
};

/** The env keys the server Worker reads its auth configuration from. */
export const AUTH_ENV_KEYS = {
  policy: "RAMOSE_POLICY",
  jwksUrl: "RAMOSE_JWKS_URL",
  jwksService: "RAMOSE_JWKS_SERVICE",
  issuers: "RAMOSE_JWT_ISS",
  aud: "RAMOSE_JWT_AUD",
  maxTtl: "RAMOSE_JWT_MAX_TTL",
  allowedOrigins: "RAMOSE_ALLOWED_ORIGINS",
  internalSecret: "RAMOSE_INTERNAL_SECRET",
  // `auth` is not a key: it lowers onto issuers / aud / maxTtl.
} as const satisfies Record<Exclude<keyof PeerAuth, "auth">, string>;

/** Cap on a token's lifetime when `RAMOSE_JWT_MAX_TTL` is unset, in seconds. */
export const DEFAULT_JWT_MAX_TTL = 900;

/**
 * Fold an {@link AuthConfig} into the three loose keys it stands in for.
 * Additive: an explicitly set loose key wins over the config's value.
 */
const withAuthConfig = (auth: PeerAuth): PeerAuth =>
  auth.auth === undefined
    ? auth
    : {
        ...auth,
        issuers: auth.issuers ?? auth.auth.issuer,
        aud: auth.aud ?? auth.auth.audience,
        maxTtl: auth.maxTtl ?? auth.auth.ttl,
      };

const list = (value: readonly string[] | string | undefined): string | undefined => {
  const items = (typeof value === "string" ? value.split(",") : (value ?? []))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length === 0 ? undefined : items.join(",");
};

/**
 * Mint (or pass through) the Worker→DO secret.
 *
 * The Worker and both Durable Object classes are one script, so one env key
 * covers all three and they rotate together. Pin it by passing a value or
 * setting `RAMOSE_INTERNAL_SECRET`; otherwise every deploy gets a fresh one.
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
 * The server Worker's auth env, as bindings. Unset fields emit no key, so an
 * unconfigured server is byte-for-byte today's server; a set `policy` also
 * binds {@link internalSecret}, since an unset key leaves the Worker→DO gate
 * off.
 *
 * An {@link AuthConfig} (`auth`) stands in for `issuers` / `aud` / `maxTtl`,
 * so the verifier pins the exact contract the mint route builds claims from.
 *
 * @example
 * ```typescript
 * export const RamoseWorker = Cloudflare.Worker("RamoseWorker", {
 *   main: import.meta.resolve("ramose/worker"),
 *   env: { STORE: Store, ...Ramose.authEnv({ policy, jwksUrl, auth: AUTH }) },
 * });
 * ```
 */
export const authEnv = (
  peerAuth: PeerAuth | undefined,
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
  // A configured policy arms the Worker→DO gate, and the gate is off when the
  // key is unset — so a policy always binds a secret, minting one if the caller
  // pinned none. Without a policy, only an explicitly passed secret binds.
  const secret = auth.internalSecret;
  const pinned = secret !== undefined && secret !== "";
  if (pinned || (auth.policy !== undefined && auth.policy !== "")) {
    env[k.internalSecret] = internalSecret(secret);
  }
  return env;
};

/**
 * Fail closed at deploy: a policy with no verifier configured would deny every
 * `/db/*` at runtime, so it fails here instead.
 */
const checkAuth = (peerAuth: PeerAuth | undefined): string | undefined => {
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
  },
  never,
  Providers
>;

const ServerResource = Resource<Server>("Ramose.Server");

/**
 * Declare a Ramose server.
 *
 * The Worker may be given as a `Cloudflare.Worker` *declaration* — the value
 * `Cloudflare.Worker("Worker", …)` returns, which is a yieldable Effect, not
 * a resource instance. Resolving it is the declaration's job: `yield*`ing it
 * here registers (or reuses) the Worker in the stack and hands back the
 * resource proxy whose attributes are `Output`s, which is what makes the
 * engine (a) order this server after its Worker and (b) substitute the real
 * URL at reconcile. Passing the unyielded declaration straight into `Props`
 * would track no dependency and read `url` off a function (`undefined`). Same
 * move as `Cloudflare.DurableObject.from` / `startContainer` make with a
 * Worker/Container declaration.
 */
export const Server = Object.assign(
  (id: string, props: InputProps<ServerProps>) =>
    ServerResource(
      id,
      Effect.gen(function* () {
        const worker = props.worker as
          | ServerWorker
          | Effect.Effect<ServerWorker, unknown, never>;
        return {
          ...props,
          worker: Effect.isEffect(worker) ? yield* worker : worker,
        };
      }) as unknown as Effect.Effect<InputProps<ServerProps>, never, never>,
    ),
  ServerResource,
) as typeof ServerResource;

/** @internal `{ url, workerName }` out of whichever Worker form was given. */
export const resolveWorker = (
  worker: ServerWorker,
): { url: string | undefined; workerName: string } => {
  if (typeof worker === "string") return { url: worker, workerName: "" };
  // At reconcile the engine has replaced the Worker's attribute Outputs with
  // their values, which the `Worker` arm of the union still types as Outputs
  // (same cast Neon's Branch makes for `project.projectId`).
  const resolved = worker as unknown as {
    url?: string | undefined;
    workerName?: string | undefined;
  };
  return { url: resolved?.url, workerName: resolved?.workerName ?? "" };
};

const trimSlashes = (url: string): string => url.replace(/\/+$/, "");

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
 * @internal Probe the server, with retries: a `Server` is usually reconciled
 * seconds after the Worker that serves it was uploaded, and workers.dev routes
 * take a moment to propagate.
 *
 * The ladder itself is bounded by `deadlineMs`. `attempts × (timeoutMs +
 * delayMs)` is the worst case otherwise, which for the live defaults is minutes
 * — long enough that a deploy against a silent server looks like a hang rather
 * than a failure.
 */
export const probeHealth = (
  url: string,
  probe: ServerProbe | false | undefined,
  defaults: Required<ServerProbe>,
) => {
  if (probe === false) return Effect.void;
  // workers.dev routes often need tens of seconds after a first upload before
  // they answer; 5×500 ms was empirically too short on real Cloudflare.
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
  if (badAuth !== undefined) return yield* Effect.fail(new InvalidRequest({ message: badAuth }));
  const worker = resolveWorker(props.worker);
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
  return {
    url,
    workerName: worker.workerName,
    token: redact(props.token),
  };
});

/**
 * @internal Live provider. `reconcile` is idempotent — there is nothing to
 * create, so it resolves the URL and proves the server answers `/health`.
 *
 * No `stables` and no `diff`: a server pins no name, so nothing about it can
 * force a replacement. Repointing it at another Worker is an ordinary update.
 */
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
export const ServerProvider = () =>
  ProviderLayer.dual(Server, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
