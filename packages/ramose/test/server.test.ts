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
import { ReadDatabases } from "../src/ReadDatabases.ts";
import { ReadWriteDatabases } from "../src/ReadWriteDatabases.ts";
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

describe("identity", () => {
  test("the resource classes carry their types", () => {
    expect(Server.Type).toBe("Ramose.Server");
    expect(Database.Type).toBe("Ramose.Database");
  });

  test("isServer recognises a server and nothing else", () => {
    expect(isServer({ Type: "Ramose.Server", FQN: "app/Ramose" })).toBe(true);
    // Refs resolve to callable proxies, hence the `function` case.
    const ref = Object.assign(() => {}, { Type: "Ramose.Server" });
    expect(isServer(ref)).toBe(true);
    expect(isServer({ Type: "Cloudflare.KV.Namespace", FQN: "app/KV" })).toBe(false);
    // the other resource in this package is not this resource
    expect(isServer({ Type: "Ramose.Database", FQN: "app/Movies" })).toBe(false);
    expect(isDatabase({ Type: "Ramose.Database", FQN: "app/Movies" })).toBe(true);
    expect(isDatabase({ Type: "Ramose.Server", FQN: "app/Ramose" })).toBe(false);
    expect(isServer(undefined)).toBe(false);
    expect(isServer("Ramose.Server")).toBe(false);
  });

  test("the capabilities are keyed under stable ids", () => {
    expect(ReadWriteDatabases.key).toBe("Ramose.ReadWriteDatabases");
    expect(ReadDatabases.key).toBe("Ramose.ReadDatabases");
  });
});

/**
 * A server pins no database name — that is the whole point of the resource.
 * Both halves of that are compile-time facts, so the assertions below are
 * type-level; the `expect`s only keep the test runner honest about having run
 * the file.
 */
describe("a server has no database name", () => {
  test("`name` is not a prop", () => {
    // @ts-expect-error a database name is chosen per call, by `ramose.db(name, …)`
    const props: ServerProps = { worker: "https://peer.example.com", name: "movies" };
    expect(props.worker).toBe("https://peer.example.com");

    type NameIsAProp = "name" extends keyof ServerProps ? true : false;
    const nameIsAProp: NameIsAProp = false;
    expect(nameIsAProp).toBe(false);
  });

  test("the attributes are url / workerName / token — no name, no databaseUrl", () => {
    const attributes: Server["Attributes"] = {
      url: "https://peer.example.com",
      workerName: "ramose-peer",
      token: undefined,
    };
    expect(Object.keys(attributes).sort()).toEqual(["token", "url", "workerName"]);

    type Attr = keyof Server["Attributes"];
    const hasName: "name" extends Attr ? true : false = false;
    const hasDatabaseUrl: "databaseUrl" extends Attr ? true : false = false;
    expect([hasName, hasDatabaseUrl]).toEqual([false, false]);
  });

  test("a Database, by contrast, is exactly a name plus its catalog", () => {
    type Props = keyof Database["Props"];
    const hasName: "name" extends Props ? true : false = true;
    const hasCatalog: "catalog" extends Props ? true : false = true;
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

/**
 * The server Worker declares its own auth env; `authEnv` only names the keys
 * it reads. The Worker must agree on these exact strings.
 */
describe("the server's auth env", () => {
  test("the key names are the ones the server Worker reads", () => {
    expect(AUTH_ENV_KEYS).toEqual({
      policy: "RAMOSE_POLICY",
      jwksUrl: "RAMOSE_JWKS_URL",
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

  /**
   * The DO gate is off when `RAMOSE_INTERNAL_SECRET` is unset, so a policy that
   * bound no secret would arm enforcement on the Worker while leaving the
   * transactor trusting whatever principal the Worker claims.
   */
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
    // a pinned one is passed through, whichever wrapper it arrives in
    expect(Redacted.value(internalSecret("pinned"))).toBe("pinned");
    expect(Redacted.value(internalSecret(Redacted.make("pinned")))).toBe("pinned");
  });

  test("`auth` is a prop of the server, and the attributes are unchanged", () => {
    const props: ServerProps = { worker: "https://peer.example.com", auth: { policy: "{}" } };
    expect(props.auth?.policy).toBe("{}");
    type HasAuth = "auth" extends keyof Server["Attributes"] ? true : false;
    const hasAuth: HasAuth = false;
    expect(hasAuth).toBe(false);
    // auth lives on the server (the peer), never on a database
    type DatabaseHasAuth = "auth" extends keyof Database["Props"] ? true : false;
    const databaseHasAuth: DatabaseHasAuth = false;
    expect(databaseHasAuth).toBe(false);
  });
});
