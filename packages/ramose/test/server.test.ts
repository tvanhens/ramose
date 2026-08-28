/**
 * The resources themselves: identity, the name rule their clients enforce,
 * Worker resolution, and the env keys the two transports agree on.
 *
 * Instantiating a resource (`Ramose.Server("Ramose", …)`) needs a running
 * engine — that lives in `stack.test.ts`. What is checkable in isolation is
 * everything the provider decides *about* a server, plus the shape of the
 * props and attributes, which the compiler checks.
 */

import { describe, expect, test } from "bun:test";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Redacted from "effect/Redacted";
import { OperationsCoverageError } from "../src/db/Errors.ts";
import { Database, isDatabase } from "../src/Database.ts";
import {
  AUTH_ENV_KEYS,
  authEnv,
  checkAuth,
  compareAuthToWorker,
  compareOperationsToHealth,
  coverageTimeoutMs,
  DEFAULT_JWT_MAX_TTL,
  internalSecret,
  isServer,
  PROBE_DEFAULTS,
  resolveWorker,
  Server,
  type ServerProps,
} from "../src/Server.ts";
import { envKeys } from "../src/ServerRuntime.ts";
import {
  PEER_COMPAT,
  PEER_BINDINGS,
  PEER_DO_CLASSES,
  ownedPeerDurableObjects,
  validatePeerWiring,
} from "../src/peer.ts";
import { workerEntry } from "../src/workerEntry.ts";
import * as Schema from "effect/Schema";
import { Operation, defineOperations } from "../src/db/internal.ts";
import { Movies, User } from "./db/fixture.ts";

describe("identity", () => {
  test("the resource classes carry their types", () => {
    expect(Server.Type).toBe("Ramose.Server");
    expect(Database.Type).toBe("Ramose.Database");
  });

  test("isServer recognises a server and nothing else", () => {
    expect(isServer({ Type: "Ramose.Server", FQN: "app/Ramose" })).toBe(true);
    const ref = Object.assign(() => {}, { Type: "Ramose.Server" });
    expect(isServer(ref)).toBe(true);
    expect(isServer({ Type: "Cloudflare.KV.Namespace", FQN: "app/KV" })).toBe(false);
    expect(isServer({ Type: "Ramose.Database", FQN: "app/Movies" })).toBe(false);
    expect(isDatabase({ Type: "Ramose.Database", FQN: "app/Movies" })).toBe(true);
    expect(isDatabase({ Type: "Ramose.Server", FQN: "app/Ramose" })).toBe(false);
    expect(isServer(undefined)).toBe(false);
    expect(isServer("Ramose.Server")).toBe(false);
  });

});

describe("a server has no database name", () => {
  test("there is no deploy-time database seeder; `name` is an optional Worker name", () => {
    type HasDatabases = "databases" extends keyof ServerProps ? true : false;
    const hasDatabases: HasDatabases = false;
    expect(hasDatabases).toBe(false);

    const workerName: ServerProps["name"] = undefined;
    expect(workerName).toBeUndefined();
  });

  test("the attributes are url / workerName — no client or seed state", () => {
    const attributes: Server["Attributes"] = {
      url: "https://peer.example.com",
      workerName: "ramose-peer",
    };
    expect(Object.keys(attributes).sort()).toEqual(["url", "workerName"]);

    type Attr = keyof Server["Attributes"];
    const hasName: "name" extends Attr ? true : false = false;
    const hasDatabaseUrl: "databaseUrl" extends Attr ? true : false = false;
    expect([hasName, hasDatabaseUrl]).toEqual([false, false]);
  });

  test("a Database, by contrast, is exactly a name plus its catalog", () => {
    type Props = keyof Database["Props"];
    const hasName: "name" extends Props ? true : false = true;
    const hasCatalog: "schema" extends Props ? true : false = true;
    const hasServer: "server" extends Props ? true : false = true;
    expect([hasName, hasCatalog, hasServer]).toEqual([true, true, true]);
  });
});

describe("worker resolution", () => {
  test("a Worker-shaped value yields its url and script name", () => {
    expect(resolveWorker({ url: "https://peer.example.com", workerName: "ramose-peer" })).toEqual({
      url: "https://peer.example.com",
      workerName: "ramose-peer",
    });
  });

  test("a bare URL has no script name — no service binding is possible", () => {
    expect(resolveWorker("https://peer.example.com")).toEqual({
      url: "https://peer.example.com",
      workerName: "",
    });
  });

  test("an undeployed Worker has no url yet", () => {
    expect(resolveWorker({ url: undefined }).url).toBeUndefined();
  });
});

describe("env keys", () => {
  test("the env keys are derived from the logical id — and there is no _DB key", () => {
    const keys = envKeys({ LogicalId: "Ramose" });
    expect(keys).toEqual({
      service: "Ramose",
      url: "Ramose_URL",
    });
    expect(Object.values(keys)).not.toContain("Ramose_DB");
  });

});

describe("PEER_COMPAT", () => {
  test("one date, nodejs_compat, and the fixed binding / class names", () => {
    expect(PEER_COMPAT).toEqual({
      date: "2026-03-17",
      flags: ["nodejs_compat", "global_fetch_strictly_public"],
    });
    expect(PEER_BINDINGS).toEqual({
      store: "STORE",
      transactor: "TRANSACTOR",
      replica: "REPLICA",
      versionMetadata: "CF_VERSION_METADATA",
    });
    expect(PEER_DO_CLASSES).toEqual({ transactor: "TransactorDO", replica: "QueryReplicaDO" });
  });

  test("owned DO declarations keep the exported class names as their logical ids", () => {
    const dos = ownedPeerDurableObjects();
    expect(dos.transactor.name).toBe("TransactorDO");
    expect(dos.replica.name).toBe("QueryReplicaDO");
    expect(dos.transactor.className).toBe("TransactorDO");
    expect(dos.replica.className).toBe("QueryReplicaDO");
  });
});

describe("escape-hatch wiring", () => {
  const peer = (env: Record<string, unknown>, main = workerEntry()) => ({
    Type: "Cloudflare.Worker",
    Props: { main, env, compatibility: PEER_COMPAT },
  });

  const dos = {
    STORE: { Type: "Cloudflare.R2.Bucket" },
    TRANSACTOR: { Type: "Cloudflare.DurableObject", Props: { className: "TransactorDO" } },
    REPLICA: { Type: "Cloudflare.DurableObject", Props: { className: "QueryReplicaDO" } },
    CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
  };

  test("a URL worker has nothing to validate", () => {
    expect(validatePeerWiring("https://peer.example.com")).toBeUndefined();
    expect(validatePeerWiring({ url: "https://peer.example.com" })).toBeUndefined();
  });

  test("a well-wired Worker passes", () => {
    expect(validatePeerWiring(peer(dos))).toBeUndefined();
  });

  test("a hatch whose DO logical id is not the class name still passes", () => {
    expect(
      validatePeerWiring(
        peer({
          STORE: { Type: "Cloudflare.R2.Bucket" },
          TRANSACTOR: {
            Type: "Cloudflare.DurableObject",
            LogicalId: "Tx",
            name: "Tx",
            Props: { className: "TransactorDO" },
          },
          REPLICA: {
            Type: "Cloudflare.DurableObject",
            LogicalId: "Rep",
            name: "Rep",
            Props: { className: "QueryReplicaDO" },
          },
          CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
        }),
      ),
    ).toBeUndefined();
  });

  test("a missing binding is a deploy error", () => {
    const { REPLICA: _r, ...partial } = dos;
    expect(validatePeerWiring(peer(partial))).toMatch(/missing env binding.*REPLICA/);
  });

  test("live renewal requirements fail at deploy time", () => {
    const { CF_VERSION_METADATA: _version, ...withoutVersion } = dos;
    expect(validatePeerWiring(peer(withoutVersion))).toMatch(
      /missing env binding CF_VERSION_METADATA/,
    );
    expect(
      validatePeerWiring(peer({ ...dos, CF_VERSION_METADATA: "not-a-binding" })),
    ).toMatch(/Cloudflare\.Workers\.VersionMetadata/);
    const configured = peer(dos);
    expect(
      validatePeerWiring({
        ...configured,
        Props: { ...configured.Props, compatibility: { flags: ["nodejs_compat"] } },
      }),
    ).toMatch(/global_fetch_strictly_public/);
  });

  test("a typo'd className is a deploy error", () => {
    expect(
      validatePeerWiring(
        peer({
          ...dos,
          TRANSACTOR: { Type: "Cloudflare.DurableObject", Props: { className: "WriterDO" } },
        }),
      ),
    ).toMatch(/TRANSACTOR className must be "TransactorDO"/);
  });

  test("the bare specifier is refused", () => {
    expect(validatePeerWiring(peer(dos, "ramose/worker"))).toMatch(/bare specifier/);
  });

  test("a main that does not resolve is refused", () => {
    expect(validatePeerWiring(peer(dos, "/no/such/peer.ts"))).toMatch(/does not resolve/);
  });
});

/**
 * The server Worker declares its own auth env; `authEnv` only names the keys
 * it reads. The Worker must agree on these exact strings.
 */
describe("the server's auth env", () => {
  test("the key names are the ones the server Worker reads", () => {
    expect(AUTH_ENV_KEYS).toEqual({
      jwksUrl: "RAMOSE_JWKS_URL",
      jwksJson: "RAMOSE_JWKS_JSON",
      jwksService: "RAMOSE_JWKS_SERVICE",
      issuers: "RAMOSE_JWT_ISS",
      aud: "RAMOSE_JWT_AUD",
      maxTtl: "RAMOSE_JWT_MAX_TTL",
      allowedOrigins: "RAMOSE_ALLOWED_ORIGINS",
      internalSecret: "RAMOSE_INTERNAL_SECRET",
    });
    expect(DEFAULT_JWT_MAX_TTL).toBe(900);
  });

  test("nothing configured binds nothing — today's server, byte for byte", () => {
    expect(authEnv(undefined)).toEqual({});
    expect(authEnv({})).toEqual({});
    expect(authEnv({ jwksUrl: "" })).toEqual({});
  });

  test("issuers and origins are comma-separated sets, from a list or a string", () => {
    const { [AUTH_ENV_KEYS.internalSecret]: _secret, ...env } = authEnv({
      jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
      issuers: ["https://auth.acme.example", " https://auth.other.example "],
      aud: "ramose:peer:prod",
      maxTtl: 300,
      allowedOrigins: "https://app.acme.example, ",
    });
    expect(env).toEqual({
      RAMOSE_JWKS_URL: "https://auth.acme.example/.well-known/jwks.json",
      RAMOSE_JWT_ISS: "https://auth.acme.example,https://auth.other.example",
      RAMOSE_JWT_AUD: "ramose:peer:prod",
      RAMOSE_JWT_MAX_TTL: "300",
      RAMOSE_ALLOWED_ORIGINS: "https://app.acme.example",
    });
  });

  test("the Worker→DO secret stays Redacted, so it lands as a secret binding", () => {
    const env = authEnv({ internalSecret: "sh4red" });
    const bound = env[AUTH_ENV_KEYS.internalSecret];
    expect(Redacted.isRedacted(bound)).toBe(true);
    expect(Redacted.value(bound as Redacted.Redacted<string>)).toBe("sh4red");
  });

  test("a pinned secret is bound; verifier keys alone do not mint one", () => {
    const env = authEnv({
      jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
      issuers: "https://auth.acme.example",
      aud: "ramose:peer:prod",
      internalSecret: "sh4red",
    });
    expect(Redacted.value(env[AUTH_ENV_KEYS.internalSecret] as Redacted.Redacted<string>)).toBe(
      "sh4red",
    );
    expect(authEnv({ jwksUrl: "https://auth.acme.example/.well-known/jwks.json" })).toEqual({
      RAMOSE_JWKS_URL: "https://auth.acme.example/.well-known/jwks.json",
    });
    expect(authEnv({ jwksJson: '{"keys":[]}' })).toEqual({ RAMOSE_JWKS_JSON: '{"keys":[]}' });
    expect(authEnv({})[AUTH_ENV_KEYS.internalSecret]).toBeUndefined();
  });

  test("an unpinned internal secret is minted, and is not the same twice", () => {
    const a = Redacted.value(internalSecret());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(Redacted.value(internalSecret()));
    expect(Redacted.value(internalSecret("pinned"))).toBe("pinned");
    expect(Redacted.value(internalSecret(Redacted.make("pinned")))).toBe("pinned");
  });

  test("`auth` is a prop of the server, and the attributes are unchanged", () => {
    const props: ServerProps = { worker: "https://peer.example.com", auth: { aud: "ramose:peer" } };
    expect(props.auth?.aud).toBe("ramose:peer");
    type HasAuth = "auth" extends keyof Server["Attributes"] ? true : false;
    const hasAuth: HasAuth = false;
    expect(hasAuth).toBe(false);
    type DatabaseHasAuth = "auth" extends keyof Database["Props"] ? true : false;
    const databaseHasAuth: DatabaseHasAuth = false;
    expect(databaseHasAuth).toBe(false);
    type HasOperations = "operations" extends keyof ServerProps ? true : false;
    const hasOperations: HasOperations = true;
    type HasWrites = "writes" extends keyof ServerProps ? true : false;
    const hasWrites: HasWrites = false;
    type HasToken = "token" extends keyof ServerProps ? true : false;
    const hasToken: HasToken = false;
    expect([hasOperations, hasWrites, hasToken]).toEqual([true, false, false]);
  });

  test("Output / Effect-valued JWKS and origins pass through un-normalised", () => {
    const jwksUrl = { kind: "Output", value: "https://auth.example/jwks" };
    const allowedOrigins = { kind: "Effect", value: "https://app.example" };
    const env = authEnv({
      jwksUrl,
      issuers: "https://auth.example",
      aud: "ramose:peer",
      allowedOrigins,
      internalSecret: "sh4red",
    });
    expect(env[AUTH_ENV_KEYS.jwksUrl]).toBe(jwksUrl);
    expect(env[AUTH_ENV_KEYS.allowedOrigins]).toBe(allowedOrigins);
  });
});

describe("owned form binds auth onto the Worker", () => {
  const auth = {
    jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
    issuers: "https://auth.acme.example",
    aud: "ramose:peer:prod",
    internalSecret: "sh4red",
  };

  test("authEnv binds verifier keys and no seed token", () => {
    const bindings = authEnv(auth);
    expect(bindings[AUTH_ENV_KEYS.jwksUrl]).toBe(auth.jwksUrl);
    expect(bindings[AUTH_ENV_KEYS.issuers]).toBe(auth.issuers);
    expect(bindings[AUTH_ENV_KEYS.aud]).toBe(auth.aud);
    expect(bindings.RAMOSE_TOKEN).toBeUndefined();
    expect(Redacted.value(bindings[AUTH_ENV_KEYS.internalSecret] as Redacted.Redacted<string>)).toBe(
      "sh4red",
    );
    expect(authEnv(undefined).RAMOSE_TOKEN).toBeUndefined();
  });

  test("checkAuth only rejects a non-positive maxTtl", () => {
    expect(checkAuth({ maxTtl: 0 })).toMatch(/positive number of seconds/);
    expect(
      checkAuth({
        jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
        issuers: "https://auth.acme.example",
        aud: "ramose:peer:prod",
      }),
    ).toBeUndefined();
    expect(checkAuth(undefined)).toBeUndefined();
    expect(checkAuth({})).toBeUndefined();
  });

  test("verifier bindings without a compiled policy still pass checkAuth", () => {
    expect(
      checkAuth({
        jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
        issuers: "https://auth.acme.example",
        aud: "ramose:peer:prod",
      }),
    ).toBeUndefined();
    expect(
      checkAuth({
        jwt: { issuer: "https://auth.acme.example", audience: "ramose:peer:prod", ttl: 900 },
        jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
      }),
    ).toBeUndefined();
    expect(checkAuth({ issuers: "https://auth.acme.example" })).toBeUndefined();
    expect(checkAuth({ jwksJson: '{"keys":[]}' })).toBeUndefined();
    expect(checkAuth({ allowedOrigins: "https://app.acme.example" })).toBeUndefined();
  });

  test("an Output-valued jwksUrl counts as present for checkAuth", () => {
    expect(
      checkAuth({
        jwksUrl: { interpolate: "https://auth.example/jwks" },
        issuers: "https://auth.example",
        aud: "ramose:peer",
      }),
    ).toBeUndefined();
  });
});

describe("hatch form compares auth against the Worker env", () => {
  const dos = {
    STORE: { Type: "Cloudflare.R2.Bucket" },
    TRANSACTOR: { Type: "Cloudflare.DurableObject", Props: { className: "TransactorDO" } },
    REPLICA: { Type: "Cloudflare.DurableObject", Props: { className: "QueryReplicaDO" } },
  };
  const auth = {
    jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
    issuers: "https://auth.acme.example",
    aud: "ramose:peer:prod",
  };
  const matching = {
    RAMOSE_JWKS_URL: auth.jwksUrl,
    RAMOSE_JWT_ISS: auth.issuers,
    RAMOSE_JWT_AUD: auth.aud,
  };
  const hatch = (env: Record<string, unknown>) => ({
    Type: "Cloudflare.Worker",
    Props: { main: workerEntry(), env: { ...dos, ...env } },
  });

  test("a URL worker has no env to compare", () => {
    expect(compareAuthToWorker(auth, "https://peer.example.com")).toBeUndefined();
    expect(compareAuthToWorker(auth, { url: "https://peer.example.com" })).toBeUndefined();
  });

  test("auth on Server without matching Worker verifier keys is a deploy error", () => {
    expect(compareAuthToWorker(auth, hatch({}))).toMatch(/diverge on/);
  });

  test("Worker verifier keys without Server auth is a deploy error", () => {
    expect(compareAuthToWorker(undefined, hatch(matching))).toMatch(/diverge on/);
  });

  test("divergence on iss / aud / jwks fails", () => {
    expect(compareAuthToWorker(auth, hatch({ ...matching, RAMOSE_JWT_AUD: "other" }))).toMatch(
      /diverge on RAMOSE_JWT_AUD/,
    );
    expect(
      compareAuthToWorker(
        { ...auth, jwksUrl: "https://other.example/jwks" },
        hatch(matching),
      ),
    ).toMatch(/diverge on RAMOSE_JWKS_URL/);
    expect(compareAuthToWorker(auth, hatch(matching))).toBeUndefined();
  });

  test("a correctly-wired hatch still deploys without a seed token", () => {
    expect(compareAuthToWorker(auth, hatch(matching))).toBeUndefined();
    expect(
      compareAuthToWorker(auth, hatch({ ...matching, RAMOSE_TOKEN: "s3cret" })),
    ).toBeUndefined();
  });

  test("hatch RAMOSE_JWKS_JSON matches auth.jwksJson and diverges without it", () => {
    const jwksJson = '{"keys":[]}';
    const jsonAuth = {
      jwksJson,
      issuers: "https://local.test",
      aud: "ramose:local",
    };
    const jsonHatch = {
      RAMOSE_JWKS_JSON: jwksJson,
      RAMOSE_JWT_ISS: jsonAuth.issuers,
      RAMOSE_JWT_AUD: jsonAuth.aud,
    };
    expect(compareAuthToWorker(jsonAuth, hatch(jsonHatch))).toBeUndefined();
    expect(
      compareAuthToWorker(undefined, hatch({ RAMOSE_JWKS_JSON: jwksJson })),
    ).toMatch(/diverge on RAMOSE_JWKS_JSON/);
    expect(
      compareAuthToWorker({ ...jsonAuth, jwksJson: '{"keys":[{"kid":"other"}]}' }, hatch(jsonHatch)),
    ).toMatch(/diverge on RAMOSE_JWKS_JSON/);
    expect(
      compareAuthToWorker(undefined, hatch({ RAMOSE_JWKS_URL: "https://auth.example/jwks" })),
    ).toMatch(/diverge on RAMOSE_JWKS_URL/);
    expect(
      compareAuthToWorker(undefined, hatch({ RAMOSE_JWT_ISS: "https://auth.example" })),
    ).toMatch(/diverge on RAMOSE_JWT_ISS/);
    expect(compareAuthToWorker(undefined, hatch({}))).toBeUndefined();
  });

  test("the same Output instance on both sides matches; a different instance does not", () => {
    const jwksUrl = { interpolate: "https://auth.example/jwks" };
    const deferred = { ...auth, jwksUrl };
    expect(
      compareAuthToWorker(deferred, hatch({ ...matching, RAMOSE_JWKS_URL: jwksUrl })),
    ).toBeUndefined();
    expect(
      compareAuthToWorker(
        deferred,
        hatch({ ...matching, RAMOSE_JWKS_URL: { interpolate: "https://auth.example/jwks" } }),
      ),
    ).toMatch(/diverge on RAMOSE_JWKS_URL/);
  });
});

describe("operations coverage vs /health", () => {
  const createUser = Operation(
    "user/create",
    { input: Schema.Struct({}), output: Schema.Struct({}) },
    () => ({}),
  );
  const setName = Operation(
    "user/set-name",
    {
      on: User,
      input: Schema.Struct({ name: Schema.String }),
      output: Schema.Struct({}),
    },
    () => ({}),
  );
  const client = defineOperations(Movies, { createUser, setName });

  test("unset operations skips", () => {
    expect(compareOperationsToHealth(undefined, { operations: [] })).toBeUndefined();
  });

  test("matching ids pass; extra peer ops pass", () => {
    expect(
      compareOperationsToHealth(client, {
        operations: ["user/create", "user/set-name", "user/extra"],
      }),
    ).toBeUndefined();
  });

  test("a missing id is a named deploy error", () => {
    const error = compareOperationsToHealth(client, { operations: ["user/create"] });
    expect(error).toBeInstanceOf(OperationsCoverageError);
    expect(error?.missing).toEqual(["user/set-name"]);
    expect(error?.message).toMatch(/missing operations: user\/set-name/);
  });

  test("a health body with no operations list is an empty registry", () => {
    const error = compareOperationsToHealth(client, { ok: true });
    expect(error).toBeInstanceOf(OperationsCoverageError);
    expect(error?.missing).toEqual(["user/create", "user/set-name"]);
  });

  test("coverage fetch uses the caller's probe.timeoutMs", () => {
    expect(coverageTimeoutMs({ timeoutMs: 60_000 }, PROBE_DEFAULTS.live)).toBe(60_000);
    expect(coverageTimeoutMs({ timeoutMs: 60_000 }, PROBE_DEFAULTS.local)).toBe(60_000);
    expect(coverageTimeoutMs(undefined, PROBE_DEFAULTS.live)).toBe(PROBE_DEFAULTS.live.timeoutMs);
    expect(coverageTimeoutMs({}, PROBE_DEFAULTS.local)).toBe(PROBE_DEFAULTS.local.timeoutMs);
    expect(coverageTimeoutMs(false, PROBE_DEFAULTS.live)).toBe(PROBE_DEFAULTS.live.timeoutMs);
    expect(coverageTimeoutMs(false, PROBE_DEFAULTS.local)).toBe(PROBE_DEFAULTS.local.timeoutMs);
  });
});
