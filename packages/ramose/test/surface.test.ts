/**
 * The `ramose` barrel, exactly.
 *
 * Everything on `ramose/db` (asserted name-by-name in
 * `db-portable.test.ts`) plus the deploy-time half: two resources, one
 * capability, one transport layer, the provider collection, typed policy
 * and the peer constants. Nothing else is public.
 */

import { describe, expect, test } from "bun:test";

const ADDS = [
  // resources
  "Server",
  "Database",
  // one capability, one transport
  "Databases",
  "layer",
  "asRead",
  // peer
  "PEER_COMPAT",
  "PEER_BINDINGS",
  "PEER_DO_CLASSES",
  // the stack
  "providers",
  "Providers",
  // deploy-time policy
  "Policy",
  "policy",
  "DEFAULT_JWT_MAX_TTL",
  // the verifier/minter contract
  "claims",
  // app-Worker HTTP mapping (not on `ramose/db`)
  "errorToHttp",
  "errorResponse",
  "statusOf",
  "toDbError",
];

/** Names the kill-list retired: internal, deleted, or renamed. */
const KILLED = [
  "System",
  "SystemProps",
  "SystemPeer",
  "SystemProbe",
  "isSystem",
  "resolvePeer",
  "ProviderLive",
  "ProviderLocal",
  "SystemProvider",
  "ProviderRequirements",
  "ReadSystem",
  "WriteSystem",
  "ReadWriteSystem",
  "WriteDatabases",
  "ReadWriteDatabases",
  "ReadDatabases",
  "ServerBinding",
  "ServerHttp",
  "authEnv",
  "internalSecret",
  "AUTH_ENV_KEYS",
  "applyLocalDev",
  "LOCAL_DEV",
  "LOCAL_DEV_ACCOUNT_ID",
  ...["Read", "Write", "ReadWrite"].flatMap((cap) =>
    ["Binding", "Http", "Local"].map((wire) => `${cap}System${wire}`),
  ),
  "ServerLocal",
  "SystemSource",
  "SystemEndpoint",
  "Client",
  "Session",
  "openSession",
];

describe("the `ramose` barrel", () => {
  test("is `/db` plus exactly the deploy-time half", async () => {
    const [alchemy, db] = await Promise.all([
      import("../src/index.ts"),
      import("../src/db/index.ts"),
    ]);
    expect(Object.keys(alchemy).sort()).toEqual(
      [...Object.keys(db), ...ADDS].sort(),
    );
  });

  test("the kill-list is gone", async () => {
    const alchemy = await import("../src/index.ts");
    expect(KILLED.filter((name) => name in alchemy)).toEqual([]);
  });
});
