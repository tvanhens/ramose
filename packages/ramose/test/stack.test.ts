/**
 * The resources through the real engine: plan → apply → attributes, with an
 * in-memory state store and a local HTTP server standing in for the peer.
 *
 * No cloud, no credentials — `Ramose.providers()` talks to nothing but the
 * peer's `/health` and, for a `Database`, one `POST /db/:name/transact`. That
 * is the point: `Server` only proves the peer is up, and `Database` is not a
 * cloud object at all — it is "install this catalog on this name".
 */

import { afterAll, beforeEach, describe, expect } from "bun:test";
import * as Alchemy from "alchemy";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as net from "node:net";
import { Database } from "../src/Database.ts";
import { providers } from "../src/Providers.ts";
import { Server } from "../src/Server.ts";
import { Movie, Movies, User } from "./db/fixture.ts";
import { Attr, Catalog, Namespace } from "../src/db/internal.ts";
import * as Schema from "effect/Schema";

interface Transaction {
  readonly name: string;
  readonly authorization: string | null;
  readonly tx: readonly any[];
}

/** A peer that is up, counting its health probes and recording its writes. */
let probes = 0;
let transactions: Transaction[] = [];
let t = 0;
const peer = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      probes++;
      return Response.json({ ok: true, service: "ramose", stage: "test", time: Date.now() });
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
});

/** The planned action per resource, in FQN order. */
const actions = (plan: { resources: Record<string, { action: string }> }) =>
  Object.keys(plan.resources)
    .sort()
    .map((fqn) => plan.resources[fqn].action);

/** The idents a schema install asserts, in order. */
const idents = (tx: readonly any[]): string[] =>
  tx.map((op) => (op as { ":db/ident"?: string })[":db/ident"]).filter((i) => i !== undefined);

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
      // a server is the peer, not a database: no name, no /db/:name prefix
      const attributes = Object.keys(server);
      expect(attributes).toContain("url");
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

  test.provider("a policy with no verifier configured fails the deploy, not the first read", (stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        stack.deploy(
          Server("Ramose", { worker: peerUrl, probe: false, auth: { policy: '{"v":1}' } }),
        ),
      );
      expect(result._tag).toBe("Failure");

      // the same policy with a complete verifier deploys
      const server = yield* stack.deploy(
        Server("Ramose", {
          worker: peerUrl,
          probe: false,
          auth: {
            policy: '{"v":1}',
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

describe("Ramose.Database", () => {
  const server = () => Server("Ramose", { worker: peerUrl, probe: false });

  test.provider("installs the catalog on the name, at deploy", (stack) =>
    Effect.gen(function* () {
      const db = yield* stack.deploy(
        Database("movies", { server: server(), catalog: Movies }),
      );

      expect(db.name).toBe("movies");
      expect(db.server).toBe(peerUrl);
      expect(db.t).toBeGreaterThan(0);

      // exactly one transaction, on this name, and it is the catalog
      expect(transactions).toHaveLength(1);
      expect(transactions[0].name).toBe("movies");
      expect(idents(transactions[0].tx)).toEqual(
        expect.arrayContaining([User.name.ident, Movie.title.ident]),
      );

      yield* stack.destroy();
    }),
  );

  test.provider("the name defaults to the logical id, and `name` overrides it", (stack) =>
    Effect.gen(function* () {
      const db = yield* stack.deploy(
        Database("Todos", { server: server(), catalog: Movies, name: "todos-prod" }),
      );
      expect(db.name).toBe("todos-prod");
      expect(transactions.map((c) => c.name)).toEqual(["todos-prod"]);
      yield* stack.destroy();
    }),
  );

  test.provider("carries the server's token, so a peer with RAMOSE_TOKEN accepts it", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Database("movies", {
          server: Server("Ramose", {
            worker: peerUrl,
            probe: false,
            token: Redacted.make("s3cret"),
          }),
          catalog: Movies,
        }),
      );
      expect(transactions[0].authorization).toBe("Bearer s3cret");
      yield* stack.destroy();
    }),
  );

  test.provider("a redeploy is a no-op, and an update re-installs idempotently", (stack) =>
    Effect.gen(function* () {
      const declare = (catalog: typeof Movies) =>
        Effect.gen(function* () {
          const s = yield* server();
          return yield* Database("movies", { server: s, catalog });
        });

      yield* stack.deploy(declare(Movies));
      expect(transactions).toHaveLength(1);

      // same catalog, same name → nothing to do
      const plan = yield* stack.plan(declare(Movies));
      expect(actions(plan)).toEqual(["noop", "noop"]);

      yield* stack.deploy(declare(Movies));
      expect(transactions).toHaveLength(1);

      // a grown catalog is an ordinary update: install() upserts it
      const Extra = Namespace("extra", { note: Attr(Schema.String) });
      const grown = Catalog({ ...Movies.namespaces, extra: Extra }) as typeof Movies;
      yield* stack.deploy(declare(grown));
      expect(transactions).toHaveLength(2);
      expect(idents(transactions[1].tx)).toContain(":extra/note");

      yield* stack.destroy();
    }),
  );

  test.provider("destroying it writes nothing — a database is a name", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(Database("movies", { server: server(), catalog: Movies }));
      expect(transactions).toHaveLength(1);

      yield* stack.destroy();
      // no retraction, no drop, no delete request of any kind
      expect(transactions).toHaveLength(1);
    }),
  );

  test.provider("an illegal database name fails the deploy, not the first request", (stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        stack.deploy(
          Database("bad", { server: server(), catalog: Movies, name: "has/slash" }),
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
            catalog: Movies,
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
