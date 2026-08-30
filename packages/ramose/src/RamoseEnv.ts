import type { AnalyticsEngineDatasetLike } from "./internal/transactor/observability.ts";

export interface RamoseEnv {
  STORE: R2Bucket;
  TRANSACTOR: DurableObjectNamespace;
  REPLICA: DurableObjectNamespace;
  CF_VERSION_METADATA?: {
    readonly id: string;
    readonly tag: string;
    readonly timestamp: string;
  };
  ANALYTICS?: AnalyticsEngineDatasetLike;
  RAMOSE_STAGE?: string;
  RAMOSE_JWKS_URL?: string;
  RAMOSE_JWKS_SERVICE?: string;
  RAMOSE_JWKS_JSON?: string;
  RAMOSE_JWT_ISS?: string;
  RAMOSE_JWT_AUD?: string;
  RAMOSE_JWT_MAX_TTL?: string;
  RAMOSE_ALLOWED_ORIGINS?: string;
  RAMOSE_INTERNAL_SECRET: string;
  RAMOSE_INDEX_INTERVAL_MS?: string;
  RAMOSE_INDEX_TX_THRESHOLD?: string;
  RAMOSE_INDEX_MAX_TXS_PER_RUN?: string;
  RAMOSE_LOG_KEEP_TXS?: string;
  RAMOSE_GC_EVERY_N_INDEXES?: string;
  RAMOSE_RETAIN_ROOTS?: string;
  RAMOSE_MAX_BATCH?: string;
  RAMOSE_TIMING_YIELDS?: string;
  RAMOSE_QUERY_MAX_CELLS?: string;
  RAMOSE_LOG_LEVEL?: string;
  RAMOSE_REPLICA_HINT?: string;
  RAMOSE_CACHE_BASIS?: string;
  RAMOSE_CACHE_MODE?: string;
  RAMOSE_TEST_HOOKS?: string;
  RAMOSE_TEST_CAPABILITY?: string;
}
