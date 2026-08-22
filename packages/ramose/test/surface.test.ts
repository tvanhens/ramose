/**
 * The `ramose` barrel, exactly.
 *
 * Everything on `ramose/db` (asserted name-by-name in
 * `db-portable.test.ts`) plus the deploy-time half: two resources, two
 * capabilities, two transports, the provider collection, typed policy and the
 * server's auth env. Nothing else is public — no source, no endpoint, no URL
 * type, no admin client, no per-capability transport.
 */

import { describe, expect, test } from "bun:test";

const ADDS = [
  // resources
  "Server",
  "Database",
  // capabilities
  "ReadWriteDatabases",
  "ReadDatabases",
  // transports
  "ServerBinding",
  "ServerHttp",
  // the stack
  "providers",
  "Providers",
  // deploy-time policy
  "Policy",
  "policy",
  // the server Worker's auth env
  "authEnv",
  "internalSecret",
  "AUTH_ENV_KEYS",
  "DEFAULT_JWT_MAX_TTL",
  // the verifier/minter contract (`AuthConfig` is a type; `claims` builds the payload)
  "claims",
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
  "PolicyError",
  "ReadSystem",
  "WriteSystem",
  "ReadWriteSystem",
  "WriteDatabases",
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
