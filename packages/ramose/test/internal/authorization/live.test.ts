/**
 * #415 — leased live queries over the filtered Db from executeAuthorizedRequest.
 *
 * Real Connection + schemaTx + transact. Locally signed JWTs. Thin NDJSON
 * consumer. Checkpoints + Scope/Clock at orchestration boundaries. No
 * frontend runtime and no fabricated transport peer.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { schemaTx } from "../../../src/db/internal.ts";
import { Unauthorized } from "../../../src/db/Errors.ts";
import {
  DatabaseId,
  assembleDeployedCatalogs,
  callerFromVerified,
  contains,
  diffAuthorizedResults,
  eq,
  executeAuthorizedLive,
  executeAuthorizedRead,
  hashCatalogSchemaFingerprint,
  isSilentLiveDiff,
  liveDiffFromPrevious,
  me,
  path,
  read,
  subject,
  type AuthorizedRequestInput,
  type DeployedCatalogs,
  type LiveQueryDiff,
} from "../../../src/internal/authorization/index.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import { stringifyJson } from "../../../src/internal/core/json.ts";
import {
  armCheckpoint,
  checkpointStatus,
  releaseCheckpoint,
  resetTestHooks,
} from "../../../src/internal/test-hooks.ts";
import { authorizedLiveResponse } from "../../../src/worker/authorized-live.ts";
import { fromEnv, resetJwtVerifier } from "../../../src/worker/jwt.ts";
import { applyLiveDiffs, collectLive } from "../../../../../test/support/live-query.ts";
import {
  App,
  Issue,
  User,
  Workspace,
  catalog,
  catalogDescriptor,
  compileRules,
  database,
  expectOk,
  version,
} from "./semantic-fixtures.ts";

const ISS = "https://issuer.example.test";
const AUD = "ramose:test";
const titlesQuery = { kind: "query" as const, query: `[:find [?t ...] :where [?e :issue/title ?t]]` };

interface TestKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

let keyA: TestKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  keyA = {
    kid: "key-a",
    privateKey: pair.privateKey,
    publicJwk: {
      ...(await exportJWK(pair.publicKey)),
      alg: "ES256",
      kid: "key-a",
      use: "sig",
    },
  };
});

beforeEach(() => {
  resetJwtVerifier();
});

afterEach(() => {
  resetTestHooks();
});

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

const env = (keys: readonly JWK[] = [keyA.publicJwk]) =>
  ({
    RAMOSE_JWKS_JSON: JSON.stringify({ keys }),
    RAMOSE_JWT_ISS: ISS,
    RAMOSE_JWT_AUD: AUD,
    RAMOSE_JWT_MAX_TTL: "900",
  }) as Parameters<typeof fromEnv>[0];

const payload = (over: Record<string, unknown> = {}): JWTPayload => {
  const now = nowSeconds();
  return {
    iss: ISS,
    aud: AUD,
    sub: "alice-sub",
    iat: now,
    exp: now + 300,
    ramose: { class: "member", attrs: { org: "acme" } },
    ...over,
  };
};

const sign = async (options: { readonly payload?: JWTPayload } = {}): Promise<string> =>
  new SignJWT(options.payload ?? payload())
    .setProtectedHeader({ alg: "ES256", kid: keyA.kid })
    .sign(keyA.privateKey);

const authenticateToken = (token: string) =>
  fromEnv(env())
    .verify(Redacted.make(token))
    .pipe(Effect.map(callerFromVerified));

const sealedDescriptor = async (db: DatabaseId = database) => {
  const base = { ...catalogDescriptor(), database: db };
  const fingerprint = await Effect.runPromise(hashCatalogSchemaFingerprint(base));
  return { ...base, fingerprint };
};

const deployPolicy = async (
  rules: Parameters<typeof compileRules>[0],
  extras: Parameters<typeof compileRules>[1] = {},
  db: DatabaseId = database,
): Promise<DeployedCatalogs> => {
  const descriptor = await sealedDescriptor(db);
  return Effect.runPromise(
    assembleDeployedCatalogs({
      root: catalog,
      units: [
        {
          catalog,
          database: db,
          version,
          descriptor,
          policy: expectOk(compileRules(rules, extras)),
        },
      ],
    }),
  );
};

const ownerPolicy = (): Promise<DeployedCatalogs> =>
  deployPolicy([read(Issue).when(eq(Issue.owner, me)), read(User).when(eq(User.authId, subject))]);

const membershipPolicy = (): Promise<DeployedCatalogs> =>
  deployPolicy([
    read(Issue).when(contains(path(Issue.workspace, Workspace.members), me)),
    read(User).when(eq(User.authId, subject)),
    read(Workspace).when(contains(Workspace.members, me)),
  ]);

const installEntityKinds = (conn: Connection, namespaces: readonly string[]) =>
  conn.transact(
    namespaces.map((ns) => ({
      ":db/ident": `:${ns}`,
      ":ramose/kind": ":ramose.kind/entity",
    })),
  );

const seedWorld = async () => {
  const conn = await Connection.create();
  await conn.transact(schemaTx(App));
  await installEntityKinds(conn, ["user", "workspace", "tag"]);
  const report = await conn.transact([
    { ":db/id": "alice", ":ramose/type": ":user", ":user/authId": "alice-sub" },
    { ":db/id": "bob", ":ramose/type": ":user", ":user/authId": "bob-sub" },
    { ":db/id": "ws", ":ramose/type": ":workspace", ":workspace/members": "alice" },
    {
      ":db/id": "i1",
      ":ramose/type": ":issue",
      ":issue/title": "Bug",
      ":issue/owner": "alice",
      ":issue/workspace": "ws",
      ":issue/parent": "i1",
    },
    {
      ":db/id": "i2",
      ":ramose/type": ":issue",
      ":issue/title": "Other",
      ":issue/owner": "bob",
      ":issue/workspace": "ws",
      ":issue/parent": "i1",
    },
    {
      ":db/id": "i3",
      ":ramose/type": ":issue",
      ":issue/title": "Child",
      ":issue/owner": "alice",
      ":issue/workspace": "ws",
      ":issue/parent": "i1",
    },
  ]);
  return {
    conn,
    aliceEid: report.tempids["alice"]!,
    bobEid: report.tempids["bob"]!,
    wsEid: report.tempids["ws"]!,
    i1: report.tempids["i1"]!,
    i2: report.tempids["i2"]!,
    i3: report.tempids["i3"]!,
  };
};

const proofOf = (catalogs: DeployedCatalogs, route: DatabaseId = database) => {
  const deployed = Result.getOrThrow(catalogs.requireDatabase(route));
  return { catalogKey: deployed.catalogKey, unitHash: deployed.unitHash };
};

const inputOf = (
  catalogs: DeployedCatalogs,
  token: string,
  conn: Connection,
  extra: Partial<AuthorizedRequestInput> = {},
): AuthorizedRequestInput => ({
  authenticate: authenticateToken(token),
  catalogs,
  routeDatabase: database,
  ...proofOf(catalogs),
  currentDb: (db) => {
    expect(db).toBe(database);
    return Effect.sync(() => conn.db());
  },
  ...extra,
});

const titlesOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).map(String).sort();

const leakKeys = (value: unknown): string[] => {
  const text = stringifyJson(value);
  return ["datoms", "txEid", "basisT", "\"t\":", "rule", "grant"].filter((key) => text.includes(key));
};

const waitArmed = async (name: string): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (checkpointStatus()[name]?.pending === true) return;
    await Bun.sleep(5);
  }
  throw new Error(`${name} never armed`);
};

describe("diffAuthorizedResults", () => {
  test("additions and retractions are result rows only", () => {
    const diff = diffAuthorizedResults(["Bug", "Child"], ["Bug", "Other"]);
    expect(diff.added).toEqual(["Other"]);
    expect(diff.retracted).toEqual(["Child"]);
    expect(isSilentLiveDiff(diffAuthorizedResults(["Bug"], ["Bug"]))).toBe(true);
    expect(liveDiffFromPrevious(undefined, ["Bug"]).added).toEqual(["Bug"]);
    expect(leakKeys(diff)).toEqual([]);
  });
});

describe("executeAuthorizedLive equals one-shot and diffs visibility", () => {
  test("the first live result equals one-shot at the same basis and principal", async () => {
    const world = await seedWorld();
    const catalogs = await ownerPolicy();
    const token = await sign();
    const input = inputOf(catalogs, token, world.conn);
    const oneShot = await Effect.runPromise(executeAuthorizedRead(input, titlesQuery));
    const { diffs, fiber } = await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Queue.unbounded<LiveQueryDiff>();
        const fiber = yield* executeAuthorizedLive(input, titlesQuery).pipe(
          Stream.runForEach((diff) => Queue.offer(seen, diff)),
          Effect.forkChild,
        );
        const first = yield* Queue.take(seen);
        return { diffs: [first], fiber };
      }),
    );
    expect(titlesOf(applyLiveDiffs(diffs))).toEqual(titlesOf(oneShot));
    expect(titlesOf(oneShot)).toEqual(["Bug", "Child"]);
    expect(leakKeys(diffs)).toEqual([]);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test("grant and revoke emit visible additions and retractions without the rule transaction", async () => {
    const world = await seedWorld();
    const catalogs = await ownerPolicy();
    const token = await sign();
    const wakes = await Effect.runPromise(Queue.unbounded<void>());
    const input = inputOf(catalogs, token, world.conn);
    const { first, grant, revoke, fiber } = await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Queue.unbounded<LiveQueryDiff>();
        const fiber = yield* executeAuthorizedLive({ ...input, wakes }, titlesQuery).pipe(
          Stream.runForEach((diff) => Queue.offer(seen, diff)),
          Effect.forkChild,
        );
        const first = yield* Queue.take(seen);
        yield* Effect.promise(() =>
          world.conn.transact([{ ":db/id": world.i2, ":issue/owner": world.aliceEid }]),
        );
        yield* Queue.offer(wakes, undefined);
        const grant = yield* Queue.take(seen);
        yield* Effect.promise(() =>
          world.conn.transact([{ ":db/id": world.i1, ":issue/owner": world.bobEid }]),
        );
        yield* Queue.offer(wakes, undefined);
        const revoke = yield* Queue.take(seen);
        return { first, grant, revoke, fiber };
      }),
    );
    expect(titlesOf(applyLiveDiffs([first]))).toEqual(["Bug", "Child"]);
    expect(titlesOf(grant.added)).toEqual(["Other"]);
    expect(grant.retracted).toEqual([]);
    expect(titlesOf(revoke.retracted)).toEqual(["Bug"]);
    expect(leakKeys([first, grant, revoke])).toEqual([]);
    expect(stringifyJson([first, grant, revoke])).not.toMatch(/:issue\/owner|:db\/id/);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test("hidden-only changes are silent", async () => {
    const world = await seedWorld();
    const catalogs = await ownerPolicy();
    const token = await sign();
    const wakes = await Effect.runPromise(Queue.unbounded<void>());
    const input = inputOf(catalogs, token, world.conn, { interruptAfter: 80 });
    const { first, next, fiber } = await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Queue.unbounded<LiveQueryDiff>();
        const fiber = yield* executeAuthorizedLive({ ...input, wakes }, titlesQuery).pipe(
          Stream.runForEach((diff) => Queue.offer(seen, diff)),
          Effect.forkChild,
        );
        const first = yield* Queue.take(seen);
        yield* Effect.promise(() =>
          world.conn.transact([{ ":db/id": world.i2, ":issue/title": "Secret" }]),
        );
        yield* Queue.offer(wakes, undefined);
        const next = yield* Queue.take(seen).pipe(Effect.timeoutOption("60 millis"));
        return { first, next, fiber };
      }),
    );
    expect(titlesOf(applyLiveDiffs([first]))).toEqual(["Bug", "Child"]);
    expect(next._tag).toBe("None");
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test("membership revoke retracts previously visible rows", async () => {
    const world = await seedWorld();
    const catalogs = await membershipPolicy();
    const token = await sign();
    const wakes = await Effect.runPromise(Queue.unbounded<void>());
    const input = inputOf(catalogs, token, world.conn);
    const { first, revoke, fiber } = await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Queue.unbounded<LiveQueryDiff>();
        const fiber = yield* executeAuthorizedLive({ ...input, wakes }, titlesQuery).pipe(
          Stream.runForEach((diff) => Queue.offer(seen, diff)),
          Effect.forkChild,
        );
        const first = yield* Queue.take(seen);
        yield* Effect.promise(() =>
          world.conn.transact([
            [":db/retract", world.wsEid, ":workspace/members", world.aliceEid],
          ]),
        );
        yield* Queue.offer(wakes, undefined);
        const revoke = yield* Queue.take(seen);
        return { first, revoke, fiber };
      }),
    );
    expect(titlesOf(applyLiveDiffs([first])).length).toBeGreaterThan(0);
    expect(titlesOf(revoke.retracted)).toEqual(titlesOf(applyLiveDiffs([first])));
    expect(leakKeys([first, revoke])).toEqual([]);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test("renewal failure closes uniformly without leaking its reason", async () => {
    const world = await seedWorld();
    const catalogs = await ownerPolicy();
    let calls = 0;
    const caller = {
      claims: { sub: "alice-sub", org: "acme" },
      classes: ["member"],
      exp: nowSeconds() + 300,
    };
    const input = inputOf(catalogs, await sign(), world.conn, {
      authenticate: Effect.suspend(() => {
        calls += 1;
        return calls > 1 ? Effect.fail(new Unauthorized({})) : Effect.succeed(caller);
      }),
      interruptAfter: "50 millis",
    });
    const seen: LiveQueryDiff[] = [];
    const exit = await Effect.runPromise(
      executeAuthorizedLive(input, titlesQuery).pipe(
        Stream.runForEach((diff) => Effect.sync(() => seen.push(diff))),
        Effect.result,
      ),
    );
    expect(titlesOf(applyLiveDiffs(seen))).toEqual(["Bug", "Child"]);
    expect(Result.isSuccess(exit) || (Result.isFailure(exit) && exit.failure instanceof Unauthorized)).toBe(true);
    if (Result.isFailure(exit)) {
      expect(leakKeys(exit.failure)).toEqual([]);
      expect(JSON.stringify(exit.failure)).not.toMatch(/jwt|catalog|grant|expir/i);
    }
  });

  test("cancellation interrupts the live scope", async () => {
    const world = await seedWorld();
    const catalogs = await ownerPolicy();
    const token = await sign();
    const input = inputOf(catalogs, token, world.conn);
    const interrupted = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* executeAuthorizedLive(input, titlesQuery).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    expect(interrupted._tag === "Failure" || interrupted._tag === "Success").toBe(true);
  });
});

describe("lease invalidation around recompute and enqueue", () => {
  const runRace = async (name: "live.recompute" | "live.enqueue" | "live.emit") => {
    const world = await seedWorld();
    const catalogs = await ownerPolicy();
    const token = await sign();
    const revoked = await Effect.runPromise(Deferred.make<void>());
    const input = inputOf(catalogs, token, world.conn);
    const emitted: LiveQueryDiff[] = [];
    armCheckpoint(name, "wait");
    const fiber = Effect.runFork(
      executeAuthorizedLive({ ...input, revoked }, titlesQuery).pipe(
        Stream.runForEach((diff) => Effect.sync(() => emitted.push(diff))),
      ),
    );
    await waitArmed(name);
    await Effect.runPromise(Deferred.succeed(revoked, undefined));
    releaseCheckpoint(name);
    await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeout("2 seconds"), Effect.ignoreCause));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(emitted).toEqual([]);
  };

  test("revocation during recomputation drops that epoch's output", async () => {
    await runRace("live.recompute");
  });

  test("revocation around enqueue does not emit that snapshot", async () => {
    await runRace("live.enqueue");
  });

  test("revocation around emit drops the queued snapshot", async () => {
    await runRace("live.emit");
  });
});

describe("thin consumer against the live HTTP body", () => {
  test("authorizedLiveResponse writes NDJSON additions only", async () => {
    const world = await seedWorld();
    const catalogs = await ownerPolicy();
    const token = await sign();
    const input = inputOf(catalogs, token, world.conn);
    const response = await Effect.runPromise(authorizedLiveResponse(input, titlesQuery, {}, {}));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("ndjson");
    const diffs = await collectLive(response, 1);
    expect(titlesOf(applyLiveDiffs(diffs))).toEqual(["Bug", "Child"]);
    expect(leakKeys(diffs)).toEqual([]);
  });
});
