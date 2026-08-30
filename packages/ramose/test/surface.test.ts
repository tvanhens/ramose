import { describe, expect, test } from "bun:test";

const ADDS = [

  "Server",
  "Database",
  "Catalog",
  "Policy",

  "PEER_COMPAT",

  "providers",
  "Providers",
  "DEFAULT_JWT_MAX_TTL",

  "claims",

  "errorToHttp",
  "errorResponse",
  "statusOf",
  "toDbError",
];

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
  "policy",
  "PolicyError",
  "filterDb",
  "parsePolicy",
  "authEnv",
  "internalSecret",
  "PEER_BINDINGS",
  "PEER_DO_CLASSES",
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
  "Databases",
  "connect",
  "layer",
  "asRead",
  "Session",
  "openSession",
  "transact",
  "Tx",
  "TxHandle",
  "TxGenBody",
  "TxEffectBody",
  "txBuilder",
  "TxSpec",
  "seedWrite",
  "submitRaw",
  "InstalledCatalogUnit",
  "InstalledCatalogUnitV2",
  "sealInstalledCatalogUnit",
  "assembleInstalledCatalogUnit",
  "verifyInstalledCatalogUnit",
  "normalizeAndValidateCatalogUnit",
  "CatalogUnitCorrupt",
  "CatalogUnitHash",
  "hashInstalledCatalogUnit",
  "hashCatalogSchemaFingerprint",
  "catalogUnitCanonicalBytes",
  "assembleDeployedCatalogs",
  "executeAuthorizedRequest",
  "executeAuthorizedRead",
  "executeAuthorizedLive",
  "runOneShotRead",
  "OneShotReadError",
  "diffAuthorizedResults",
  "liveDiffFromPrevious",
  "liveResultRows",
  "isSilentLiveDiff",
  "callerFromVerified",
  "AuthenticatedCaller",
  "AuthorizedRequestInput",
  "AuthorizedRequestView",
  "DeployedCatalogs",
  "CatalogVersionMismatch",
  "requireCatalogKey",
  "requireDatabase",
  "requireUnitHash",
  "opaqueCatalogDenial",
  "compareAndSwapCatalogUnit",
  "loadCatalogUnitAtBasis",
  "CatalogCasConflict",
  "publishCatalog",
  "schemaTxFromCatalog",
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
