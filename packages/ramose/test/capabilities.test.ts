/**
 * One capability, one transport.
 *
 * The binding **is** the client: `yield* Ramose.Databases(Server)` hands
 * back a server-side `Databases` — no `live` / `livePull`. The {@link layer}
 * auto-picks a service binding when the host Worker has one, otherwise HTTPS.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { WorkerEnvironment } from "alchemy/Cloudflare/Workers";
import * as Output from "alchemy/Output";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { pipe } from "effect/Function";
import { Operation, Query } from "../src/db/index.ts";
import * as Schema from "effect/Schema";
import { asRead, Databases, layer, SERVICE_ORIGIN } from "../src/Databases.ts";
import type { Server } from "../src/Server.ts";
import { Movies, User } from "./db/fixture.ts";

const ACK = { t: 7, txEid: 13194139533319, tempids: {}, datoms: 1, output: {} };

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

const addAda = Operation(
  "user/add-ada",
  {
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    schema: Movies,
  },
  (op) => {
    op.put(User, { name: "Ada" });
    return {};
  },
);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Databases over a service binding", () => {
  test("the binding is the client: writes dispatch through env[LogicalId]", async () => {
    const calls: Call[] = [];
    const env = { Ramose: { fetch: fetcher(calls) } };

    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const ramose = yield* Databases(server("s3cret"));
        expect(calls).toEqual([]);
        return yield* ramose.db("movies", Movies).effect.run(addAda, {});
      }).pipe(
        Effect.provide(layer),
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
    expect(calls[0].url).toBe(`${SERVICE_ORIGIN}/db/movies/op`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe("Bearer s3cret");
  });

  test("a missing service binding is a defect, not a DbError", async () => {
    const host = {
      Type: "Cloudflare.Worker",
      LogicalId: "App",
      bind: () => () => Effect.void,
    };
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const ramose = yield* Databases(server());
        return yield* ramose.db("movies", Movies).effect.run(addAda, {});
      }).pipe(
        Effect.provide(layer),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(WorkerEnvironment, {} as never),
            Layer.succeed(Self, host as never),
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

describe("Databases over HTTPS", () => {
  test("same client, public URL, same Worker body", async () => {
    const calls: Call[] = [];
    globalThis.fetch = fetcher(calls) as unknown as typeof fetch;

    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const ramose = yield* Databases(server("s3cret"));
        return yield* ramose.db("movies", Movies).effect.run(addAda, {});
      }).pipe(Effect.provide(layer), Effect.provide(runtimeLayer())),
    );

    expect(report.t).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://peer.example.com/db/movies/op");
    expect(calls[0].headers.authorization).toBe("Bearer s3cret");
  });
});

describe("server-side handles have no live / livePull", () => {
  test("the methods are not on the object", async () => {
    const calls: Call[] = [];
    globalThis.fetch = fetcher(calls) as unknown as typeof fetch;

    const db = await Effect.runPromise(
      Effect.gen(function* () {
        const ramose = yield* Databases(server());
        return ramose.db("movies", Movies);
      }).pipe(Effect.provide(layer), Effect.provide(runtimeLayer())),
    );

    expect(typeof db.query).toBe("function");
    expect(typeof db.pull).toBe("function");
    expect(typeof db.asOf).toBe("function");
    expect("live" in db).toBe(false);
    expect("livePull" in db).toBe(false);
    expect("live" in db.effect).toBe(false);
    expect("livePull" in db.effect).toBe(false);
    // @ts-expect-error server-side handles do not have live
    expect(db.live).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("asRead is a type-level view of the same handle", async () => {
    globalThis.fetch = fetcher([]) as unknown as typeof fetch;
    const db = await Effect.runPromise(
      Effect.gen(function* () {
        const ramose = yield* Databases(server());
        return ramose.db("movies", Movies);
      }).pipe(Effect.provide(layer), Effect.provide(runtimeLayer())),
    );
    const read = asRead(db);
    expect(read).toBe(db);
    // @ts-expect-error a read view cannot name a write
    type _noWrite = (typeof read)["transact"];
  });

  test("reads take the HTTPS wire when no service binding is present", async () => {
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
        const ramose = yield* Databases(server());
        return yield* ramose
          .db("movies", Movies)
          .effect.query(Query.q(() => pipe(Query.entities(User), Query.select({ name: User.name }))));
      }).pipe(Effect.provide(layer), Effect.provide(runtimeLayer())),
    );

    expect(rows).toEqual([{ name: "Ada" }]);
    expect(calls[0].url).toBe("https://peer.example.com/db/movies/query");
  });
});
