/**
 * The peer Worker's env — one type for deploy and runtime.
 *
 * The resource applies {@link import("./Server.ts").ServerAuth} and
 * `token` onto these keys when it owns the Worker. The Worker and both
 * Durable Object classes read the same type at runtime. Adding a key here
 * is what makes it real on both sides; there is no second name list to
 * keep in sync.
 */

import type { AnalyticsEngineDatasetLike } from "./internal/transactor/observability.ts";

/** Worker environment bindings shared by the Worker and both DO classes. */
export interface RamoseEnv {
  STORE: R2Bucket;
  TRANSACTOR: DurableObjectNamespace;
  REPLICA: DurableObjectNamespace;
  /** optional Analytics Engine dataset for write-path + http metrics; unbound = metrics off */
  ANALYTICS?: AnalyticsEngineDatasetLike;
  /** stage name (dev / prod) */
  RAMOSE_STAGE?: string;
  /** shared bearer token: with no policy, unset = open and a match = admin; under a policy it is not a data-plane principal */
  RAMOSE_TOKEN?: string;
  /** compiled policy JSON (`Ramose.Policy.compile`). Its presence arms enforcement (fail closed). */
  RAMOSE_POLICY?: string;
  /** JWKS endpoint for the issuer's public keys */
  RAMOSE_JWKS_URL?: string;
  /**
   * Name of a service binding on this Worker to fetch `RAMOSE_JWKS_URL`
   * through. Required when the issuer is another Worker on the same account:
   * Cloudflare answers a Worker→Worker subrequest over `*.workers.dev` with
   * error 1042, so the peer must dispatch through the binding.
   */
  RAMOSE_JWKS_SERVICE?: string;
  /** test/offline seam: a literal JWK Set, used when RAMOSE_JWKS_URL is unset */
  RAMOSE_JWKS_JSON?: string;
  /** accepted `iss` values, comma-separated */
  RAMOSE_JWT_ISS?: string;
  /** the `aud` every token must carry */
  RAMOSE_JWT_AUD?: string;
  /** cap on `exp - iat` in seconds (default 900) */
  RAMOSE_JWT_MAX_TTL?: string;
  /** origins CORS is narrowed to once a policy is configured, comma-separated */
  RAMOSE_ALLOWED_ORIGINS?: string;
  /** Worker→DO shared secret; every internal fetch must carry it. Unset = no gate. */
  RAMOSE_INTERNAL_SECRET?: string;
  /** indexer tuning */
  RAMOSE_INDEX_INTERVAL_MS?: string;
  RAMOSE_INDEX_TX_THRESHOLD?: string;
  RAMOSE_INDEX_MAX_TXS_PER_RUN?: string;
  RAMOSE_LOG_KEEP_TXS?: string;
  RAMOSE_GC_EVERY_N_INDEXES?: string;
  RAMOSE_RETAIN_ROOTS?: string;
  /** group commit: max txs per storage write (0 = unbounded) */
  RAMOSE_MAX_BATCH?: string;
  /** "1" = timing fences in the commit loop (diagnostics; Workers clock only advances across I/O) */
  RAMOSE_TIMING_YIELDS?: string;
  /** query memory guardrail: max intermediate cells (rows × columns) per query */
  RAMOSE_QUERY_MAX_CELLS?: string;
  /** structured log level for all components: debug | info | warn | error (default info) */
  RAMOSE_LOG_LEVEL?: string;
  /**
   * Who may POST raw `/transact`. `"operations"` (the default, including
   * unset) closes it for app-class tokens; admin and the seed token keep
   * it. `"all"` is the explicit opt-out.
   */
  RAMOSE_WRITES?: string;
  /** default replica location hint: wnam|enam|…|auto (auto = colo→hint); unset = continent default */
  RAMOSE_REPLICA_HINT?: string;
  /** "1" = isolate basis cache on by default */
  RAMOSE_CACHE_BASIS?: string;
  /** default basis-cache consistency mode: ttl | peer */
  RAMOSE_CACHE_MODE?: string;
}
