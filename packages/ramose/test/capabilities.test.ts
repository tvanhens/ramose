/**
 * The two capabilities through the two transport layers.
 *
 * The binding **is** the client: `yield* Ramose.ReadWriteDatabases(Server)`
 * hands back a `Databases`, and the Worker body is identical whether
 * `ServerBinding` (a service binding to the server Worker) or `ServerHttp`
 * (the public URL) decided the wire. `ReadDatabases` is the same client with
 * the writes removed — a shape, not a second transport.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { WorkerEnvironment } from "alchemy/Cloudflare/Workers";
import * as Output from "alchemy/Output";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { pipe } from "effect/Function";
import { Query, type Tx } from "../src/db/index.ts";
import { ReadDatabases } from "../src/ReadDatabases.ts";
import { ReadWriteDatabases } from "../src/ReadWriteDatabases.ts";
import type { Server } from "../src/Server.ts";
import { SERVICE_ORIGIN, ServerBinding } from "../src/ServerBinding.ts";
import { ServerHttp } from "../src/ServerHttp.ts";
import { Movies, User } from "./db/fixture.ts";

const ACK = { t: 7, txEid: 13194139533319, tempids: {}, datoms: 1 };

/** A server whose attributes are literal Outputs, as after a deploy. */
const server = (token?: string): Server =>
  ({
    LogicalId: "Ramose",
    FQN: "app/Ramose",
    Type: "Ramose.Server",
    url: Output.literal("https://peer.example.com"),
    workerName: Output.literal("ramose-peer"),
    token: Output.literal(token === undefined ? undefined : Redacted.make(token)),
  }) as unknown as Server;

const evaluate = (expr: unknown): unknown => {
  const node = expr as {
    kind?: string;
    value?: unknown;
    expr?: unknown;
    f?: (v: unknown) => unknown;
  };
  if (node?.kind === "LiteralExpr") return node.value;
  if (node?.kind === "ApplyExpr") return node.f!(evaluate(node.expr));
  return expr;
};

/** The env a deployed Worker would see: whatever `set` bound, keyed by name. */
const runtimeLayer = (env: Record<string, unknown> = {}) => {
  const bound: Record<string, unknown> = { ...env };
  return Layer.succeed(RuntimeContext, {
    Type: "test",
    id: "test",
    env: bound,
    set: (key: string, output: Output.Output) =>
      Effect.sync(() => {
        bound[key] = evaluate(output);
        return key;
      }),
    get: <T>(key: string) => Effect.succeed(bound[key] as T | undefined),
  } as never);
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** A fetcher that records what it was asked for and always acks. */
const fetcher = (calls: Call[]) => (url: string, init: any) => {
  calls.push({
    url: String(url),
    method: init?.method ?? "GET",
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  });
  return Promise.resolve(
    new Response(JSON.stringify(ACK), {
      headers: { "content-type": "application/json" },
    }),
  );
};

function* write(tx: Tx<typeof Movies>) {
  const ada = yield* tx.entity();
  yield* ada.add(User.name, "Ada");
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("ReadWriteDatabases under ServerBinding", () => {
  test("the binding is the client: writes dispatch through env[LogicalId]", async () => {
    const calls: Call[] = [];
    const env = { Ramose: { fetch: fetcher(calls) } };

    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const ramose = yield* ReadWriteDatabases(server("s3cret"));
        // pure: naming a database costs no request
        expect(calls).toEqual([]);
        return yield* ramose.db("movies", Movies).effect.transact(write);
      }).pipe(
        Effect.provide(ServerBinding),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(WorkerEnvironment, env as never),
            runtimeLayer(),
          ),
        ),
      ),
    );

    expect(report.t).toBe(7);
    expect(calls).toHaveLength(1);
    // the synthetic origin, the one writer's path, and the server's one token
    expect(calls[0].url).toBe(`${SERVICE_ORIGIN}/db/movies/transact`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe("Bearer s3cret");
  });

  test("a missing service binding is a defect, not a DbError", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const ramose = yield* ReadWriteDatabases(server());
        return yield* ramose.db("movies", Movies).effect.transact(write);
      }).pipe(
        Effect.provide(ServerBinding),
        Effect.provide(
          Layer.mergeAll(
            // the host Worker never lowered the binding
            Layer.succeed(WorkerEnvironment, {} as never),
            runtimeLayer(),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed({
            die: Cause.hasDies(cause),
            message: String(Cause.squash(cause)),
          }),
        ),
      ),
    );
    expect(outcome).toMatchObject({ die: true });
    expect((outcome as { message: string }).message).toMatch(
      /no service binding "Ramose"/,
    );
  });
});

describe("ReadWriteDatabases under ServerHttp", () => {
  test("same client, public URL, same Worker body", async () => {
    const calls: Call[] = [];
    globalThis.fetch = fetcher(calls) as unknown as typeof fetch;

    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const ramose = yield* ReadWriteDatabases(server("s3cret"));
        return yield* ramose.db("movies", Movies).effect.transact(write);
      }).pipe(Effect.provide(ServerHttp), Effect.provide(runtimeLayer())),
    );

    expect(report.t).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://peer.example.com/db/movies/transact");
    expect(calls[0].headers.authorization).toBe("Bearer s3cret");
  });
});

describe("ReadDatabases", () => {
  test("hands back a ReadDb: no transact, no install, under either transport", async () => {
    const calls: Call[] = [];
    globalThis.fetch = fetcher(calls) as unknown as typeof fetch;

    const read = (transport: Layer.Layer<ReadDatabases, never, WorkerEnvironment>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const ramose = yield* ReadDatabases(server());
          return ramose.db("movies", Movies);
        }).pipe(
          Effect.provide(transport),
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(WorkerEnvironment, {
                Ramose: { fetch: fetcher(calls) },
              } as never),
              runtimeLayer(),
            ),
          ),
        ),
      );

    const dbs = [await read(ServerHttp), await read(ServerBinding)];

    for (const db of dbs) {
      expect(typeof db.q).toBe("function");
      expect(typeof db.pull).toBe("function");
      expect(typeof db.live).toBe("function");
      expect(typeof db.asOf).toBe("function");
      // the writes are not merely untyped away — they are not there
      expect("transact" in db).toBe(false);
      expect("install" in db).toBe(false);
      // @ts-expect-error a read capability cannot name a write
      expect(db.transact).toBeUndefined();
    }
    // and a read that never ran issued nothing
    expect(calls).toEqual([]);
  });

  test("its reads take the same wire the read-write client would", async () => {
    const calls: Call[] = [];
    globalThis.fetch = ((url: string, init: any) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: init?.headers ?? {},
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ t: 3, root: 3, result: [[{ name: "Ada" }]] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const ramose = yield* ReadDatabases(server());
        return yield* ramose
          .db("movies", Movies)
          .effect.q(Query.q(() => pipe(Query.entities(User), Query.select({ name: User.name }))));
      }).pipe(Effect.provide(ServerHttp), Effect.provide(runtimeLayer())),
    );

    expect(rows).toEqual([{ name: "Ada" }]);
    expect(calls[0].url).toBe("https://peer.example.com/db/movies/query");
  });
});
