/**
 * Worker access to the durable server identity/sealing root.
 *
 * The accessor itself lives in `internal/replication/identity-root.ts` because
 * the authoritative Transactor needs the same isolate-cached root (#475 seals
 * allocation mappings into the durable receipt and opens sealed operation
 * targets inside the writer). This module keeps the Worker-facing import path
 * and its `RamoseEnv` typing.
 */

export {
  clearServerIdentityRootCache,
  SERVER_IDENTITY_ROOT_NAME,
  serverIdentityRoot,
  serverIdentityRootId,
  serverSealingKey,
} from "../internal/replication/identity-root.ts";
