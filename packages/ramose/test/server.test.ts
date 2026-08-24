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
import * as Redacted from "effect/Redacted";
import { Database, isDatabase } from "../src/Database.ts";
import { Databases } from "../src/Databases.ts";
import {
  AUTH_ENV_KEYS,
  authEnv,
  DEFAULT_JWT_MAX_TTL,
  internalSecret,
  isServer,
  resolveWorker,
  Server,
  type ServerProps,
} from "../src/Server.ts";
import { SERVICE_ORIGIN } from "../src/ServerBinding.ts";
import { envKeys } from "../src/ServerRuntime.ts";
import {
  PEER_COMPAT,
  PEER_BINDINGS,
  PEER_DO_CLASSES,
  ownedPeerDurableObjects,
  validatePeerWiring,
} from "../src/peer.ts";
import { workerEntry } from "../src/workerEntry.ts";

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

  test("the capability is keyed under a stable id", () => {
    expect(Databases.key).toBe("Ramose.Databases");
  });
});

describe("a server has no database name", () => {
  test("`databases` is the seeder; `name` is an optional Worker name", () => {
    type HasDatabases = "databases" extends keyof ServerProps ? true : false;
    const hasDatabases: HasDatabases = true;
    expect(hasDatabases).toBe(true);

    const workerName: ServerProps["name"] = undefined;
    expect(workerName).toBeUndefined();
  });

  test("the attributes are url / workerName / token / seeded — no name, no databaseUrl", () => {
    const attributes: Server["Attributes"] = {
      url: "https://peer.example.com",
      workerName: "ramose-peer",
      token: undefined,
      seeded: [],
    };
    expect(Object.keys(attributes).sort()).toEqual(["seeded", "token", "url", "workerName"]);

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
      token: "Ramose_TOKEN",
    });
    expect(Object.values(keys)).not.toContain("Ramose_DB");
  });

  test("service-binding dispatch uses a synthetic origin", () => {
    expect(SERVICE_ORIGIN).toBe("https://ramose.internal");
  });
});

describe("PEER_COMPAT", () => {
  test("one date, nodejs_compat, and the fixed binding / class names", () => {
    expect(PEER_COMPAT).toEqual({ date: "2026-03-17", flags: ["nodejs_compat"] });
    expect(PEER_BINDINGS).toEqual({ store: "STORE", transactor: "TRANSACTOR", replica: "REPLICA" });
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
    Props: { main, env },
  });

  const dos = {
    STORE: { Type: "Cloudflare.R2.Bucket" },
    TRANSACTOR: { Type: "Cloudflare.DurableObject", Props: { className: "TransactorDO" } },
    REPLICA: { Type: "Cloudflare.DurableObject", Props: { className: "QueryReplicaDO" } },
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
        }),
      ),
    ).toBeUndefined();
  });

  test("a missing binding is a deploy error", () => {
    const { REPLICA: _r, ...partial } = dos;
    expect(validatePeerWiring(peer(partial))).toMatch(/missing env binding.*REPLICA/);
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
      policy: "RAMOSE_POLICY",
      jwksUrl: "RAMOSE_JWKS_URL",
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
    expect(authEnv({ policy: "" })).toEqual({});
  });

  test("issuers and origins are comma-separated sets, from a list or a string", () => {
    const { [AUTH_ENV_KEYS.internalSecret]: _secret, ...env } = authEnv({
      policy: '{"v":1}',
      jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
      issuers: ["https://auth.acme.example", " https://auth.other.example "],
      aud: "ramose:peer:prod",
      maxTtl: 300,
      allowedOrigins: "https://app.acme.example, ",
    });
    expect(env).toEqual({
      RAMOSE_POLICY: '{"v":1}',
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

  test("a policy always binds an internal secret, minting one if none was pinned", () => {
    const env = authEnv({
      policy: '{"v":1}',
      jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
      issuers: "https://auth.acme.example",
      aud: "ramose:peer:prod",
    });
    const bound = env[AUTH_ENV_KEYS.internalSecret];
    expect(Redacted.isRedacted(bound)).toBe(true);
    const minted = Redacted.value(bound as Redacted.Redacted<string>);
    expect(minted).not.toBe("");
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a policy with a pinned secret uses that secret, not a fresh one", () => {
    const env = authEnv({
      policy: '{"v":1}',
      jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
      issuers: "https://auth.acme.example",
      aud: "ramose:peer:prod",
      internalSecret: "sh4red",
    });
    expect(Redacted.value(env[AUTH_ENV_KEYS.internalSecret] as Redacted.Redacted<string>)).toBe(
      "sh4red",
    );
  });

  test("no policy and no pinned secret binds no internal secret", () => {
    expect(authEnv({ jwksUrl: "https://auth.acme.example/.well-known/jwks.json" })).toEqual({
      RAMOSE_JWKS_URL: "https://auth.acme.example/.well-known/jwks.json",
    });
    expect(authEnv({})[AUTH_ENV_KEYS.internalSecret]).toBeUndefined();
    expect(authEnv({ policy: "" })[AUTH_ENV_KEYS.internalSecret]).toBeUndefined();
  });

  test("an unpinned internal secret is minted, and is not the same twice", () => {
    const a = Redacted.value(internalSecret());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(Redacted.value(internalSecret()));
    expect(Redacted.value(internalSecret("pinned"))).toBe("pinned");
    expect(Redacted.value(internalSecret(Redacted.make("pinned")))).toBe("pinned");
  });

  test("`auth` is a prop of the server, and the attributes are unchanged", () => {
    const props: ServerProps = { worker: "https://peer.example.com", auth: { policy: "{}" } };
    expect(props.auth?.policy).toBe("{}");
    type HasAuth = "auth" extends keyof Server["Attributes"] ? true : false;
    const hasAuth: HasAuth = false;
    expect(hasAuth).toBe(false);
    type DatabaseHasAuth = "auth" extends keyof Database["Props"] ? true : false;
    const databaseHasAuth: DatabaseHasAuth = false;
    expect(databaseHasAuth).toBe(false);
  });
});
