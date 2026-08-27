/**
 * Provider-algorithm tests: plan → apply → attributes, with an in-memory
 * state store and a local HTTP server standing in for the peer.
 *
 * This file tests the Alchemy provider, not the Ramose topology. Owned
 * Server catalog seeding against real workerd is `test/local` (`registerCatalogSeed`).
 * `Test.make({ dev: true, sidecar: false })` below is the in-process
 * local-provider path — not the default integration environment.
 */

import { afterAll, beforeEach, describe, expect } from "bun:test";
import * as Alchemy from "alchemy";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as net from "node:net";
import { OperationsCoverageError } from "../src/db/Errors.ts";
import { Database } from "../src/Database.ts";
import { providers } from "../src/Providers.ts";
import { Server } from "../src/Server.ts";
import { workerEntry } from "../src/workerEntry.ts";
import { Movies } from "./db/fixture.ts";
import {
  Operation,
  defineOperations,
} from "../src/db/internal.ts";
import * as Schema from "effect/Schema";

interface Transaction {
  readonly name: string;
  readonly authorization: string | null;
  readonly tx: readonly any[];
}

/** A peer that is up, counting its health probes and recording its writes. */
let probes = 0;
let healthOperations: string[] | undefined;
let transactions: Transaction[] = [];
let t = 0;
const peer = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      probes++;
      return Response.json({
        ok: true,
        service: "ramose",
        stage: "test",
        time: Date.now(),
        ...(healthOperations !== undefined ? { operations: healthOperations } : {}),
      });
    }
    const write = /^\/db\/([^/]+)\/transact$/.exec(pathname);
    if (write !== null) {
      const body = (await request.json()) as { tx: readonly any[] };
      transactions.push({
        name: decodeURIComponent(write[1]),
        authorization: request.headers.get("authorization"),
        tx: body.tx,
      });
      t += 1;
      return Response.json({ t, txEid: 13194139533319 + t, tempids: {}, datoms: body.tx.length });
    }
    // install() reads the installed catalog before the upsert. An empty
    // result is a fresh name — no user attributes, check passes.
    if (/^\/db\/[^/]+\/query$/.test(pathname)) {
      return Response.json({ t, result: [] });
    }
    return new Response("not found", { status: 404 });
  },
});
const peerUrl = `http://127.0.0.1:${peer.port}`;

/**
 * A peer that accepts every connection and answers nothing — the state
 * `alchemy dev` leaves behind when the peer Worker's bundle never lands. Its
 * proxy port is bound and reports `ready`, so this is *not* a connection
 * refusal: the handshake completes and the request then waits forever. The
 * whole bug this file guards against is that "forever" used to be literal.
 *
 * A raw socket server, not `Bun.serve`, precisely because it must never
 * answer: an HTTP server whose handler never settles cannot be shut down, and
 * the sockets have to be destroyable from the teardown hook.
 */
const silentSockets = new Set<net.Socket>();
const silentPeer = net.createServer((socket) => {
  silentSockets.add(socket);
  socket.on("close", () => silentSockets.delete(socket));
  socket.on("error", () => socket.destroy());
});
silentPeer.listen(0, "127.0.0.1");
const silentPeerUrl = `http://127.0.0.1:${(silentPeer.address() as net.AddressInfo).port}`;

afterAll(() => peer.stop(true));
afterAll(() => {
  for (const socket of silentSockets) socket.destroy();
  silentPeer.close();
});
beforeEach(() => {
  transactions = [];
  healthOperations = undefined;
});

/** The planned action per resource, in FQN order. */
const actions = (plan: { resources: Record<string, { action: string }> }) =>
  Object.keys(plan.resources)
    .sort()
    .map((fqn) => plan.resources[fqn].action);

const { test } = Test.make({
  providers: providers(),
  state: Alchemy.inMemoryState(),
  stage: "test",
});

describe("Ramose.Server", () => {
  test.provider("resolves the url and token — and pins no database name", (stack) =>
    Effect.gen(function* () {
      const before = probes;
      const server = yield* stack.deploy(
        Server("Ramose", { worker: peerUrl, token: Redacted.make("s3cret") }),
      );

      expect(server.url).toBe(peerUrl);
      expect(server.workerName).toBe("");
      expect(Redacted.value(server.token!)).toBe("s3cret");
      expect(server.seeded).toEqual([]);
      // a server is the peer, not a database: no name, no /db/:name prefix
      const attributes = Object.keys(server);
      expect(attributes).toContain("url");
      expect(attributes).toContain("seeded");
      expect(attributes).not.toContain("name");
      expect(attributes).not.toContain("databaseUrl");
      // the live provider proved the peer was up before anything bound to it
      expect(probes).toBeGreaterThan(before);

      yield* stack.destroy();
    }),
  );

  test.provider("takes the url and script name from a Worker-shaped value", (stack) =>
    Effect.gen(function* () {
      const server = yield* stack.deploy(
        Server("Ramose", { worker: { url: `${peerUrl}/`, workerName: "ramose-peer" } }),
      );
      expect(server.url).toBe(peerUrl);
      expect(server.workerName).toBe("ramose-peer");
      expect(server.token).toBeUndefined();
      yield* stack.destroy();
    }),
  );

  test.provider("a redeploy of the same peer is a no-op", (stack) =>
    Effect.gen(function* () {
      const props = { worker: peerUrl, probe: false } as const;
      yield* stack.deploy(Server("Ramose", props));
      const plan = yield* stack.plan(Server("Ramose", props));
      expect(actions(plan)).toEqual(["noop"]);
      yield* stack.destroy();
    }),
  );

  test.provider("operations coverage fails the deploy when an id is missing", (stack) =>
    Effect.gen(function* () {
      healthOperations = ["user/create"];
      const createUser = Operation(
        "user/create",
        { input: Schema.Struct({}), output: Schema.Struct({}) },
        () => ({}),
      );
      const setName = Operation(
        "user/set-name",
        { input: Schema.Struct({ name: Schema.String }), output: Schema.Struct({}) },
        () => ({}),
      );
      const result = yield* Effect.result(
        stack.deploy(
          Server("Ramose", {
            worker: peerUrl,
            probe: false,
            operations: defineOperations(Movies, { createUser, setName }),
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure).toBeInstanceOf(OperationsCoverageError);
      expect((result.failure as OperationsCoverageError).missing).toEqual(["user/set-name"]);
      expect(String(result)).toMatch(/missing operations: user\/set-name/);
    }),
  );

  test.provider("operations coverage passes when /health lists every id", (stack) =>
    Effect.gen(function* () {
      healthOperations = ["user/create", "user/set-name"];
      const createUser = Operation(
        "user/create",
        { input: Schema.Struct({}), output: Schema.Struct({}) },
        () => ({}),
      );
      const setName = Operation(
        "user/set-name",
        { input: Schema.Struct({ name: Schema.String }), output: Schema.Struct({}) },
        () => ({}),
      );
      const server = yield* stack.deploy(
        Server("Ramose", {
          worker: peerUrl,
          probe: false,
          operations: defineOperations(Movies, { createUser, setName }),
        }),
      );
      expect(server.url).toBe(peerUrl);
      yield* stack.destroy();
    }),
  );

  test.provider("binding nothing still deploys; a hatch must match Server auth", (stack) =>
    Effect.gen(function* () {
      const open = yield* stack.deploy(Server("Ramose", { worker: peerUrl, probe: false }));
      expect(open.url).toBe(peerUrl);
      yield* stack.destroy();

      const server = yield* stack.deploy(
        Server("Ramose", {
          worker: peerUrl,
          probe: false,
          auth: {
            jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
            issuers: "https://auth.acme.example",
            aud: "ramose:peer:test",
          },
        }),
      );
      expect(server.url).toBe(peerUrl);
      yield* stack.destroy();
    }),
  );

  test.provider("a hatch Worker missing verifier keys fails the deploy when auth is set", (stack) =>
    Effect.gen(function* () {
      const hatch = (env: Record<string, unknown>) => ({
        Type: "Cloudflare.Worker",
        url: peerUrl,
        workerName: "ramose-peer",
        Props: {
          main: workerEntry(),
          env: {
            STORE: { Type: "Cloudflare.R2.Bucket" },
            TRANSACTOR: { Type: "Cloudflare.DurableObject", Props: { className: "TransactorDO" } },
            REPLICA: { Type: "Cloudflare.DurableObject", Props: { className: "QueryReplicaDO" } },
            ...env,
          },
        },
      });
      const auth = {
        jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
        issuers: "https://auth.acme.example",
        aud: "ramose:peer:test",
      };
      const missing = yield* Effect.result(
        stack.deploy(Server("Ramose", { worker: hatch({}), probe: false, auth })),
      );
      expect(missing._tag).toBe("Failure");
      expect(String(missing)).toMatch(/diverge on/);

      const diverged = yield* Effect.result(
        stack.deploy(
          Server("Ramose", {
            worker: hatch({
              RAMOSE_JWKS_URL: auth.jwksUrl,
              RAMOSE_JWT_ISS: auth.issuers,
              RAMOSE_JWT_AUD: "other-aud",
            }),
            probe: false,
            auth,
          }),
        ),
      );
      expect(diverged._tag).toBe("Failure");
      expect(String(diverged)).toMatch(/diverge on RAMOSE_JWT_AUD/);

      const matched = yield* stack.deploy(
        Server("Ramose", {
          worker: hatch({
            RAMOSE_JWKS_URL: auth.jwksUrl,
            RAMOSE_JWT_ISS: auth.issuers,
            RAMOSE_JWT_AUD: auth.aud,
          }),
          probe: false,
          auth,
        }),
      );
      expect(matched.url).toBe(peerUrl);
      yield* stack.destroy();
    }),
  );

  test.provider("hatch writes must match the Worker; policy + all warns and still deploys", (stack) =>
    Effect.gen(function* () {
      const hatch = (env: Record<string, unknown>) => ({
        Type: "Cloudflare.Worker",
        url: peerUrl,
        workerName: "ramose-peer",
        Props: {
          main: workerEntry(),
          env: {
            STORE: { Type: "Cloudflare.R2.Bucket" },
            TRANSACTOR: { Type: "Cloudflare.DurableObject", Props: { className: "TransactorDO" } },
            REPLICA: { Type: "Cloudflare.DurableObject", Props: { className: "QueryReplicaDO" } },
            ...env,
          },
        },
      });
      const matchedUnset = yield* stack.deploy(
        Server("Ramose", { worker: hatch({}), probe: false, writes: "operations" }),
      );
      expect(matchedUnset.url).toBe(peerUrl);
      yield* stack.destroy();

      const missingAll = yield* Effect.result(
        stack.deploy(Server("Ramose", { worker: hatch({}), probe: false, writes: "all" })),
      );
      expect(missingAll._tag).toBe("Failure");
      expect(String(missingAll)).toMatch(/unset means "operations"/);

      const diverged = yield* Effect.result(
        stack.deploy(
          Server("Ramose", {
            worker: hatch({ RAMOSE_WRITES: "operations" }),
            probe: false,
            writes: "all",
          }),
        ),
      );
      expect(diverged._tag).toBe("Failure");
      expect(String(diverged)).toMatch(/diverge on RAMOSE_WRITES/);

      const matched = yield* stack.deploy(
        Server("Ramose", {
          worker: hatch({ RAMOSE_WRITES: "operations" }),
          probe: false,
          writes: "operations",
        }),
      );
      expect(matched.url).toBe(peerUrl);
      yield* stack.destroy();

      const open = yield* stack.deploy(
        Server("Ramose", {
          worker: hatch({
            RAMOSE_JWKS_URL: "https://auth.acme.example/.well-known/jwks.json",
            RAMOSE_JWT_ISS: "https://auth.acme.example",
            RAMOSE_JWT_AUD: "ramose:peer:test",
            RAMOSE_WRITES: "all",
          }),
          probe: false,
          writes: "all",
          auth: {
            jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
            issuers: "https://auth.acme.example",
            aud: "ramose:peer:test",
          },
        }),
      );
      expect(open.url).toBe(peerUrl);
      yield* stack.destroy();
    }),
  );

  test.provider("a peer that is down fails the deploy", (stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        stack.deploy(
          Server("Ramose", {
            // loopback port 1: nothing listens, so connect() refuses immediately
            worker: "http://127.0.0.1:1",
            probe: { attempts: 2, delayMs: 1 },
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      yield* stack.destroy();
    }),
  );

  /**
   * The regression. A refused connection was already caught above; a socket
   * that *accepts* and never answers was not, because `fetch` has no deadline
   * of its own. The probe now bounds each attempt and the ladder as a whole,
   * so the deploy fails with the URL in the message instead of never
   * returning.
   */
  test.provider("a peer that accepts and never answers fails, rather than hanging", (stack) =>
    Effect.gen(function* () {
      const started = Date.now();
      const result = yield* Effect.result(
        stack.deploy(
          Server("Ramose", {
            worker: silentPeerUrl,
            probe: { attempts: 2, delayMs: 1, timeoutMs: 50, deadlineMs: 5_000 },
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(Date.now() - started).toBeLessThan(5_000);
      yield* stack.destroy();
    }),
  );

});

/**
 * The same two facts under `alchemy dev`, where they actually bit.
 *
 * The local provider used to skip the probe outright, on the reasoning that a
 * Worker the engine already ordered us after must be serving. `alchemy dev`
 * binds the Worker's proxy port before the first bundle lands, so it need not
 * be — and skipping the probe handed a silent URL straight to
 * `Ramose.Database`.
 */
describe("under `alchemy dev`", () => {
  const { test: devTest } = Test.make({
    providers: providers(),
    state: Alchemy.inMemoryState(),
    stage: "test",
    dev: true,
    // In-process: this exercises the local provider itself, not the sidecar.
    sidecar: false,
  });

  devTest.provider("the local Server provider probes too", (stack) =>
    Effect.gen(function* () {
      const started = Date.now();
      const result = yield* Effect.result(
        stack.deploy(
          Server("Ramose", {
            worker: silentPeerUrl,
            probe: { attempts: 2, delayMs: 1, timeoutMs: 50, deadlineMs: 5_000 },
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(Date.now() - started).toBeLessThan(5_000);
      yield* stack.destroy();
    }),
  );

  devTest.provider("a healthy local peer still deploys, probe and all", (stack) =>
    Effect.gen(function* () {
      const server = yield* stack.deploy(Server("Ramose", { worker: peerUrl }));
      expect(server.url).toBe(peerUrl);
      yield* stack.destroy();
    }),
  );
});

describe("Ramose.Server databases: seeder", () => {
  test.provider("does not install catalogs until authorized publication is wired", (stack) =>
    Effect.gen(function* () {
      const server = yield* stack.deploy(
        Server("Ramose", {
          worker: peerUrl,
          probe: false,
          databases: { movies: Movies, extras: { schema: Movies, doc: "the extras list" } },
        }),
      );
      expect(server.seeded).toEqual([]);
      expect(transactions).toEqual([]);
      yield* stack.destroy();
    }),
  );
});

describe("Ramose.Database", () => {
  const server = () => Server("Ramose", { worker: peerUrl, probe: false });

  test.provider("catalog install is closed until authorized publication is wired", (stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        stack.deploy(Database("movies", { server: server(), schema: Movies })),
      );
      expect(result._tag).toBe("Failure");
      expect(String(result)).toMatch(/catalog install/);
      expect(transactions).toEqual([]);
      yield* stack.destroy();
    }),
  );

  test.provider("a named Database is refused the same way", (stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        stack.deploy(
          Database("Todos", { server: server(), schema: Movies, name: "todos-prod" }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(transactions).toEqual([]);
      yield* stack.destroy();
    }),
  );

  test.provider("a server token does not reopen catalog install", (stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        stack.deploy(
          Database("movies", {
            server: Server("Ramose", {
              worker: peerUrl,
              probe: false,
              token: Redacted.make("s3cret"),
            }),
            schema: Movies,
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(transactions).toEqual([]);
      yield* stack.destroy();
    }),
  );

  test.provider("an illegal database name fails the deploy, not the first request", (stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        stack.deploy(
          Database("bad", { server: server(), schema: Movies, name: "has/slash" }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(transactions).toEqual([]);
      yield* stack.destroy();
    }),
  );

  /**
   * The other half of the regression. `Ramose.Server` now refuses to hand on a
   * URL that answers nothing, but its probe speaks for `/health` — not for
   * `/db/:name/transact`. An install that cannot finish has to end in a
   * message a reader can act on, and it used to end in nothing at all: the
   * resource sat in `creating` for as long as the process lived, and whatever
   * killed it wrote `fail` with a teardown error in its place.
   */
  test.provider("an install against a silent peer fails, rather than hanging", (stack) =>
    Effect.gen(function* () {
      const started = Date.now();
      const result = yield* Effect.result(
        stack.deploy(
          Database("movies", {
            // `probe: false` isolates the install: this is the Database's own
            // deadline, not the Server's.
            server: Server("Ramose", { worker: silentPeerUrl, probe: false }),
            schema: Movies,
            timeoutMs: 500,
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(Date.now() - started).toBeLessThan(20_000);
      yield* stack.destroy();
    }),
  );
});
