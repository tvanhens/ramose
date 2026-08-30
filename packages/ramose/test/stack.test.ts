import { afterAll, beforeEach, describe, expect } from "bun:test";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as net from "node:net";
import { Database } from "../src/Database.ts";
import { PEER_COMPAT } from "../src/peer.ts";
import { providers } from "../src/Providers.ts";
import { Server } from "../src/Server.ts";
import { workerEntry } from "../src/workerEntry.ts";
import { Movies } from "./db/fixture.ts";

interface Transaction {
  readonly name: string;
  readonly authorization: string | null;
  readonly tx: readonly any[];
}

let probes = 0;
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

    if (/^\/db\/[^/]+\/query$/.test(pathname)) {
      return Response.json({ t, result: [] });
    }
    return new Response("not found", { status: 404 });
  },
});
const peerUrl = `http://127.0.0.1:${peer.port}`;

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
});

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
  test.provider("resolves the url — and pins no database name", (stack) =>
    Effect.gen(function* () {
      const before = probes;
      const server = yield* stack.deploy(
        Server("Ramose", { worker: peerUrl }),
      );

      expect(server.url).toBe(peerUrl);
      expect(server.workerName).toBe("");

      const attributes = Object.keys(server);
      expect(attributes).toContain("url");
      expect(attributes).not.toContain("seeded");
      expect(attributes).not.toContain("name");
      expect(attributes).not.toContain("databaseUrl");
      expect(attributes).not.toContain("token");

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
          compatibility: PEER_COMPAT,
          env: {
            STORE: { Type: "Cloudflare.R2.Bucket" },
            TRANSACTOR: { Type: "Cloudflare.DurableObject", Props: { className: "TransactorDO" } },
            REPLICA: { Type: "Cloudflare.DurableObject", Props: { className: "QueryReplicaDO" } },
            CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
            RAMOSE_INTERNAL_SECRET: "deployment-owned-capability",
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

  test.provider("a peer that is down fails the deploy", (stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        stack.deploy(
          Server("Ramose", {

            worker: "http://127.0.0.1:1",
            probe: { attempts: 2, delayMs: 1 },
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      yield* stack.destroy();
    }),
  );

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

describe("under `alchemy dev`", () => {
  const { test: devTest } = Test.make({
    providers: providers(),
    state: Alchemy.inMemoryState(),
    stage: "test",
    dev: true,

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

  test.provider("catalog install stays closed without a seed credential", (stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        stack.deploy(
          Database("movies", {
            server: Server("Ramose", {
              worker: peerUrl,
              probe: false,
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

  test.provider("an install against a silent peer fails, rather than hanging", (stack) =>
    Effect.gen(function* () {
      const started = Date.now();
      const result = yield* Effect.result(
        stack.deploy(
          Database("movies", {

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
