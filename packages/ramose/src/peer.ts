/**
 * The peer Worker the Server owns: pinned compat, fixed binding names,
 * Durable Object class names, and deploy-time validation of the escape hatch.
 *
 * A typo'd `className` used to pass `/health` and die on the first transact.
 * {@link validatePeerWiring} is what makes that a deploy error instead.
 */

import type { Bucket } from "alchemy/Cloudflare/R2";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { RamoseEnv } from "./RamoseEnv.ts";
import { workerEntry } from "./workerEntry.ts";

/**
 * Compatibility date and flags every Ramose peer Worker is deployed with.
 * One value — do not copy a date into a stack file.
 */
export const PEER_COMPAT: {
  date: string;
  flags: Array<"nodejs_compat" | "global_fetch_strictly_public">;
} = {
  date: "2026-03-17",
  flags: ["nodejs_compat", "global_fetch_strictly_public"],
};

/** Env keys the peer Worker and both DO classes read. */
export const PEER_BINDINGS = {
  store: "STORE",
  transactor: "TRANSACTOR",
  replica: "REPLICA",
  versionMetadata: "CF_VERSION_METADATA",
  internalSecret: "RAMOSE_INTERNAL_SECRET",
} as const satisfies {
  store: keyof RamoseEnv;
  transactor: keyof RamoseEnv;
  replica: keyof RamoseEnv;
  versionMetadata: keyof RamoseEnv;
  internalSecret: keyof RamoseEnv;
};

/** Durable Object `className`s the `ramose/worker` entry exports. */
export const PEER_DO_CLASSES = {
  transactor: "TransactorDO",
  replica: "QueryReplicaDO",
} as const;

/** Default Alchemy logical ids when Server declares the peer. */
export const PEER_DEFAULTS = {
  storage: "Store",
  worker: "Peer",
} as const;

export type PeerStorage = string | Bucket | Effect.Effect<Bucket, unknown, unknown>;

export type OwnedPeerOptions = {
  /** R2 bucket, or the logical id to declare. @default `"Store"` */
  readonly storage?: PeerStorage | undefined;
  /**
   * Peer entry module. Defaults to {@link workerEntry} (`ramose/worker`).
   * A custom `createServer({ operations })` module belongs here — that is
   * still Server-owned (DOs, bindings, compat are not yours to name).
   */
  readonly main?: string | undefined;
  /**
   * Extra env bindings (AUTH, ANALYTICS, tuning). Merged after the fixed
   * peer bindings and before auth — `Server({ auth })` wins.
   */
  readonly env?: Record<string, unknown> | undefined;
  /** Physical Worker name override (Alchemy's `name`). */
  readonly name?: string | undefined;
  /** Local-dev port for the peer proxy. */
  readonly dev?: { readonly port?: number } | undefined;
  /** Alchemy logical id of the Worker resource. @default `"Peer"` */
  readonly peer?: string | undefined;
  /** Zone routes on the owned Worker (`/db/*` on a custom hostname). */
  readonly routes?: PeerRoute[] | undefined;
};

/** Zone route passed through to `Cloudflare.Worker`. */
export type PeerRoute = {
  readonly pattern: string;
  readonly zoneName?: string | undefined;
  readonly zoneId?: string | undefined;
};

/**
 * Deploy-time Node/Bun only. The package build has no `@types/node` and
 * must not import `node:fs` / `node:url` — those would fail `tsc -p
 * tsconfig.build.json` and leak into the published graph.
 */
type FsLike = { readonly realpathSync: (path: string) => string };

declare const process: {
  readonly getBuiltinModule?: (id: string) => FsLike | undefined;
};

const nodeFs = (): FsLike => {
  try {
    const builtin = process.getBuiltinModule?.("fs") ?? process.getBuiltinModule?.("node:fs");
    if (builtin?.realpathSync !== undefined) return builtin;
  } catch {
    // no `process`
  }
  const req = (globalThis as { require?: (id: string) => FsLike }).require;
  if (typeof req === "function") return req("node:fs");
  throw new Error("cannot stat a path in this runtime (no node:fs)");
};

/** Alchemy's `fileURLToPath` + fall-back, without importing `node:url`. */
const fileUrlToPath = (value: string): string => {
  if (!value.startsWith("file:")) return value;
  const url = new URL(value);
  let path = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return path;
};

const resolveMainPath = (main: string): string => {
  let asPath: string;
  try {
    asPath = fileUrlToPath(main);
  } catch {
    asPath = main;
  }
  return nodeFs().realpathSync(asPath);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const workerProps = (
  worker: unknown,
): { main?: unknown; env?: unknown; compatibility?: unknown; Type?: unknown } | undefined => {
  if (!isRecord(worker)) return undefined;
  const props = isRecord(worker.Props) ? worker.Props : worker;
  return {
    main: props.main,
    env: props.env,
    compatibility: props.compatibility,
    Type: worker.Type,
  };
};

const isCloudflareWorker = (worker: unknown): boolean => {
  if (!isRecord(worker)) return false;
  if (worker.Type === "Cloudflare.Worker") return true;
  const props = workerProps(worker);
  return props?.env !== undefined || typeof props?.main === "string";
};

const classNameOf = (binding: unknown): string | undefined => {
  if (!isRecord(binding)) return undefined;
  const props = isRecord(binding.Props) ? binding.Props : undefined;
  if (typeof props?.className === "string") return props.className;
  if (typeof binding.className === "string") return binding.className;
  // LogicalId / name are Alchemy resource ids, not the exported class.
  // Guessing them turns a missing className into a wrong one and fails a
  // correctly-wired hatch (`DurableObject("Tx", { className: "TransactorDO" })`).
  return undefined;
};

const envOf = (worker: unknown): Record<string, unknown> | undefined => {
  const env = workerProps(worker)?.env;
  return isRecord(env) ? env : undefined;
};

const isVersionMetadataBinding = (value: unknown): boolean =>
  Cloudflare.Workers.isVersionMetadata(value) ||
  (isRecord(value) &&
    value.kind === "Cloudflare.Workers.VersionMetadata" &&
    value.name === PEER_BINDINGS.versionMetadata);

/**
 * @internal The Worker's env bag, or `undefined` when the value is a URL
 * (nothing to compare or validate).
 */
export const workerEnvOf = (worker: unknown): Record<string, unknown> | undefined =>
  envOf(worker);

/**
 * Deploy-time check of a user-owned Worker. Returns an error message, or
 * `undefined` when the worker is not a Cloudflare Worker (a URL, or
 * `{ url }`) — those forms have no bindings to validate.
 */
export const validatePeerWiring = (worker: unknown): string | undefined => {
  if (typeof worker === "string") return undefined;
  if (!isCloudflareWorker(worker)) return undefined;

  const env = envOf(worker);
  if (env === undefined) {
    return "ramose: the server Worker has no `env` — bind STORE, TRANSACTOR and REPLICA (or omit `worker` and let Ramose.Server declare them)";
  }

  const missing: string[] = [];
  for (const key of [
    PEER_BINDINGS.store,
    PEER_BINDINGS.transactor,
    PEER_BINDINGS.replica,
    PEER_BINDINGS.versionMetadata,
    PEER_BINDINGS.internalSecret,
  ]) {
    if (env[key] === undefined) missing.push(key);
  }
  if (missing.length > 0) {
    return `ramose: the server Worker is missing required internal binding${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`;
  }

  if (!isVersionMetadataBinding(env[PEER_BINDINGS.versionMetadata])) {
    return "ramose: CF_VERSION_METADATA must be Cloudflare.Workers.VersionMetadata() so catalog identity and live queries can fence deployments";
  }

  const compatibility = workerProps(worker)?.compatibility;
  const flags = isRecord(compatibility) && Array.isArray(compatibility.flags)
    ? compatibility.flags
    : [];
  if (!flags.includes("global_fetch_strictly_public")) {
    return 'ramose: the server Worker compatibility flags must include "global_fetch_strictly_public" so live-query renewal probes re-enter the public Worker route';
  }

  const transactor = classNameOf(env[PEER_BINDINGS.transactor]);
  if (transactor !== undefined && transactor !== PEER_DO_CLASSES.transactor) {
    return `ramose: TRANSACTOR className must be "${PEER_DO_CLASSES.transactor}", not ${JSON.stringify(transactor)} — a typo here passes /health and fails on the first write`;
  }
  const replica = classNameOf(env[PEER_BINDINGS.replica]);
  if (replica !== undefined && replica !== PEER_DO_CLASSES.replica) {
    return `ramose: REPLICA className must be "${PEER_DO_CLASSES.replica}", not ${JSON.stringify(replica)} — a typo here passes /health and fails on the first read`;
  }

  const main = workerProps(worker)?.main;
  if (typeof main !== "string" || main === "") {
    return "ramose: the server Worker has no `main` — point it at a module that re-exports TransactorDO and QueryReplicaDO, or omit `worker` and let Ramose.Server resolve ramose/worker";
  }
  if (main === "ramose/worker") {
    return `ramose: main is the bare specifier "ramose/worker", which Alchemy resolves as a path and never finds. Use import.meta.resolve("ramose/worker") or omit \`worker\` so Ramose.Server calls workerEntry()`;
  }
  try {
    resolveMainPath(main);
  } catch (cause) {
    return `ramose: the server Worker's main ${JSON.stringify(main)} does not resolve to a file — ${
      cause instanceof Error ? cause.message : String(cause)
    }`;
  }
  return undefined;
};

/**
 * `Cloudflare.Worker`'s route config has no bare `undefined` in its
 * `zoneName` / `zoneId` unions (only `string`, or a wrapped `Config` /
 * `Effect` / `Output`) — so an *absent* key, not a present-but-`undefined`
 * one, is what a caller who left them unset must produce.
 */
const cloudflareRoute = (route: PeerRoute) => ({
  pattern: route.pattern,
  ...(route.zoneName !== undefined ? { zoneName: route.zoneName } : {}),
  ...(route.zoneId !== undefined ? { zoneId: route.zoneId } : {}),
});

const storageDecl = (storage: PeerStorage | undefined) => {
  if (storage === undefined) return Cloudflare.R2.Bucket(PEER_DEFAULTS.storage);
  if (typeof storage === "string") return Cloudflare.R2.Bucket(storage);
  return storage;
};

/** Fresh deployment-owned Worker-to-DO capability; never caller-configurable. */
const ownedInternalSecret = (): Redacted.Redacted<string> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Redacted.make(
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
};

/**
 * The two Durable Object *declarations* a hand-written stack writes at
 * module scope (`Cloudflare.DurableObject("TransactorDO", …)`). Alchemy
 * scopes a declaration created while evaluating `Worker({ env })` as a
 * nested binding (`[Worker/TRANSACTOR]`) and never gives it its own
 * logical id — the working e2e stack and Reef both declare these as
 * siblings of the Worker instead.
 *
 * Call this from `Ramose.Server(…)` itself (stack-module evaluation),
 * not from inside Worker's env literal.
 */
export const ownedPeerDurableObjects = () => ({
  transactor: Cloudflare.DurableObject(PEER_DO_CLASSES.transactor, {
    className: PEER_DO_CLASSES.transactor,
  }),
  replica: Cloudflare.DurableObject(PEER_DO_CLASSES.replica, {
    className: PEER_DO_CLASSES.replica,
  }),
});

export type OwnedPeerDurableObjects = ReturnType<typeof ownedPeerDurableObjects>;

/**
 * Declare the R2 bucket, both DO classes, and the peer Worker. The caller
 * `yield*`s this from Server's init so Alchemy tracks the dependencies
 * through the Worker's env (the same pattern as a hand-written stack).
 */
export const declareOwnedPeer = (options: OwnedPeerOptions & {
  readonly authEnv?: Record<string, unknown> | undefined;
  /** Pre-declared at the `Server()` call site so they are stack-level siblings. */
  readonly durableObjects?: OwnedPeerDurableObjects | undefined;
}) =>
  Effect.gen(function* () {
    const dos = options.durableObjects ?? ownedPeerDurableObjects();
    const worker = yield* Cloudflare.Worker(options.peer ?? PEER_DEFAULTS.worker, {
      main: options.main ?? workerEntry(),
      compatibility: PEER_COMPAT,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.dev !== undefined ? { dev: options.dev } : {}),
      env: {
        [PEER_BINDINGS.store]: storageDecl(options.storage),
        [PEER_BINDINGS.transactor]: dos.transactor,
        [PEER_BINDINGS.replica]: dos.replica,
        [PEER_BINDINGS.versionMetadata]: Cloudflare.Workers.VersionMetadata(),
        ...options.env,
        ...options.authEnv,
        // Fixed last: ordinary app configuration cannot replace this
        // deployment-owned capability with a caller-known value.
        [PEER_BINDINGS.internalSecret]: ownedInternalSecret(),
      },
      ...(options.routes !== undefined ? { routes: options.routes.map(cloudflareRoute) } : {}),
    });
    return worker;
  });
