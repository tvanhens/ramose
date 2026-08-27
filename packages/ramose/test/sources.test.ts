/**
 * The two transports, at the seam where they differ: how a
 * {@link ServerSource} turns a server's *attributes* (Outputs, not values)
 * into "where do I send, with which token".
 *
 * The `RuntimeContext` here is the one a deployed Worker (or an
 * `Alchemy.Action`) would supply: `set` registers the value under a key while
 * the host initializes, `get` reads it back out of the environment later.
 * Faking it is the whole test — including *when* `set` is called, which is the
 * difference between a Worker that deploys with its bindings and one that
 * reads `undefined` on the first request.
 */

import { describe, expect, test } from "bun:test";
import { makeCaptureContext, makeResolveContext } from "alchemy/ActionRuntimeContext";
import * as Output from "alchemy/Output";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Server } from "../src/Server.ts";
import { Self } from "alchemy/Self";
import { WorkerEnvironment } from "alchemy/Cloudflare/Workers";
import { makeTransport, SERVICE_ORIGIN } from "../src/Databases.ts";
import { makeBindingSource } from "../src/ServerBinding.ts";
import { makeHttpSource } from "../src/ServerHttp.ts";

/** A server whose attributes are literal Outputs, as after a deploy. */
const server = (attrs: {
  url: string;
}): Server =>
  ({
    LogicalId: "Ramose",
    FQN: "app/Ramose",
    Type: "Ramose.Server",
    url: Output.literal(attrs.url),
    workerName: Output.literal("ramose-peer"),
  }) as unknown as Server;

/**
 * Evaluate the Output expressions the sources build — literals off the fake
 * server, and the `.map(…)` over the token. (The engine's own evaluator
 * needs a state store; these two node kinds are all that is in play here.)
 */
const evaluate = (expr: unknown): unknown => {
  const node = expr as { kind?: string; value?: unknown; expr?: unknown; f?: (v: unknown) => unknown };
  if (node?.kind === "LiteralExpr") return node.value;
  if (node?.kind === "ApplyExpr") return node.f!(evaluate(node.expr));
  return expr;
};

/** The env a deployed Worker would see: whatever `set` bound, keyed by name. */
const runtime = (env: Record<string, unknown> = {}) => {
  const bound: Record<string, unknown> = { ...env };
  return {
    bound,
    layer: Layer.succeed(RuntimeContext, {
      Type: "test",
      id: "test",
      env: bound,
      set: (key: string, output: Output.Output) =>
        Effect.sync(() => {
          bound[key] = evaluate(output);
          return key;
        }),
      get: <T>(key: string) => Effect.succeed(bound[key] as T | undefined),
    } as never),
  };
};

const resolve = <A>(eff: Effect.Effect<A, never, RuntimeContext>, layer: Layer.Layer<RuntimeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

describe("the service-binding source", () => {
  test("dispatches through env[LogicalId] against the synthetic origin", async () => {
    const seen: string[] = [];
    const env = {
      Ramose: {
        fetch: (url: string) => {
          seen.push(url);
          return Promise.resolve(new Response("{}"));
        },
      },
    };
    const srv = server({ url: "https://peer.example.com" });
    const { layer } = runtime();
    const source = await resolve(makeBindingSource(env, srv), layer);

    const endpoint = await resolve(source.endpoint, layer);
    expect(endpoint.url).toBe(SERVICE_ORIGIN);

    await source.fetch(`${SERVICE_ORIGIN}/db/movies/info`, { method: "GET", headers: {} });
    expect(seen).toEqual([`${SERVICE_ORIGIN}/db/movies/info`]);
  });

  test("a missing service binding is a defect, not a DbError", async () => {
    const { layer } = runtime();
    const source = await resolve(makeBindingSource({}, server({ url: "https://x" })), layer);

    // provisioning mistakes die: the endpoint is read per request, and a
    // binding that was never lowered has no `DbError` to report
    const died = await Effect.runPromise(
      source.endpoint.pipe(
        Effect.catchCause((cause) =>
          Effect.succeed({ die: Cause.hasDies(cause), message: String(Cause.squash(cause)) }),
        ),
        Effect.provide(layer),
      ),
    );
    expect(died).toMatchObject({ die: true });
    expect((died as { message: string }).message).toMatch(/no service binding "Ramose"/);

    await expect(
      source.fetch("https://ramose.internal/db/movies/info", { method: "GET", headers: {} }),
    ).rejects.toThrow(/no service binding "Ramose"/);
  });

  test("a server pins no database name and no seed token", async () => {
    const srv = server({
      url: "https://peer.example.com",
    });
    const { bound, layer } = runtime();
    const source = await resolve(makeBindingSource({ Ramose: {} }, srv), layer);

    expect(Object.keys(bound)).toEqual([]);
    expect(Object.keys(bound)).not.toContain("Ramose_DB");
    expect(Object.keys(bound)).not.toContain("Ramose_TOKEN");
    const endpoint = await resolve(source.endpoint, layer);
    expect(endpoint.token).toBeUndefined();
  });
});

describe("the HTTP source", () => {
  test("takes the peer url from the attribute, and binds url + token only", async () => {
    const srv = server({ url: "https://peer.example.com" });
    const { bound, layer } = runtime();

    const source = await resolve(makeHttpSource(srv), layer);
    const endpoint = await resolve(source.endpoint, layer);

    expect(endpoint.url).toBe("https://peer.example.com");
    expect(endpoint.token).toBeUndefined();
    expect(Object.keys(bound).sort()).toEqual(["Ramose_URL"]);
    expect(Object.keys(bound)).not.toContain("Ramose_DB");
    expect(Object.keys(bound)).not.toContain("Ramose_TOKEN");
  });
});

/**
 * Regression: the binds must happen when the capability is BOUND, not when a
 * client method runs.
 *
 * A Worker's `Props.env` is snapshotted the instant its init Effect returns
 * (alchemy/Local/Platform.ts) and an Action's *capture* context is only
 * ambient during init (alchemy/ActionRuntimeContext.ts). Registering lazily,
 * from inside a request, registers nothing at all.
 */
describe("registration happens at bind time", () => {
  test("a Worker's env is populated before any client call", async () => {
    const srv = server({ url: "https://peer.example.com" });
    const { bound, layer } = runtime();

    // the init closure: bind the capability, return a handler, run nothing
    await resolve(
      Effect.asVoid(makeHttpSource(srv)),
      layer,
    );

    expect(Object.keys(bound).sort()).toEqual(["Ramose_URL"]);
  });

  test("an Action captures the outputs during init and reads them at apply", async () => {
    const srv = server({ url: "https://peer.example.com" });

    // init: the capture context records every Output the capability binds.
    const captures: Record<string, Output.Output> = {};
    const source = await Effect.runPromise(
      makeHttpSource(srv).pipe(
        Effect.provide(Layer.succeed(RuntimeContext, makeCaptureContext(captures) as never)),
      ),
    );
    expect(Object.keys(captures).sort()).toEqual(["Ramose_URL"]);

    // apply: the engine resolves what was captured; the accessors read it back.
    const resolved = Object.fromEntries(
      Object.entries(captures).map(([key, output]) => [key, evaluate(output)]),
    );
    const endpoint = await Effect.runPromise(
      source.endpoint.pipe(
        Effect.provide(Layer.succeed(RuntimeContext, makeResolveContext(resolved) as never)),
      ),
    );
    expect(endpoint.url).toBe("https://peer.example.com");
  });

  test("a host that registered nothing dies naming the key that is missing", async () => {
    const srv = server({ url: "https://peer.example.com" });
    // A context whose `set` is a no-op and whose `get` knows nothing — what an
    // Action sees at apply when the capture never happened, or a Worker whose
    // env is missing the binding. The endpoint must not fabricate
    // `https://undefined/db/undefined`.
    const blind = Layer.succeed(RuntimeContext, makeResolveContext({}) as never);
    const source = await Effect.runPromise(makeHttpSource(srv).pipe(Effect.provide(blind)));

    const error = await Effect.runPromise(
      source.endpoint.pipe(
        Effect.catchCause((cause) => Effect.succeed(String(Cause.squash(cause)))),
        Effect.provide(blind),
      ),
    );
    expect(error).toMatch(/no value bound under "Ramose_URL"/);
  });
});

/**
 * The deploy-time half of the one transport: what it lowers onto a Worker
 * host, and the hosts it falls back from (HTTPS, not a hard refuse).
 */
describe("the auto-transport lowers a service binding on a Worker host", () => {
  /** A stand-in host Worker that records what was bound to it. */
  const worker = (bound: unknown[]) =>
    ({
      Type: "Cloudflare.Worker",
      LogicalId: "App",
      FQN: "app/App",
      bind:
        (..._template: unknown[]) =>
        (binding: unknown) =>
          Effect.sync(() => {
            bound.push(binding);
          }),
    }) as never;

  const bind = (
    host: unknown,
    srv: Server,
    env: Record<string, unknown> = {},
    layer = runtime().layer,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const make = yield* makeTransport({ makeClient: (s) => s });
        return yield* make(srv);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(WorkerEnvironment, env as never),
            Layer.succeed(Self, host as never),
            layer,
          ),
        ),
      ),
    );

  const withWorker = (worker: unknown): Server => {
    const srv = server({ url: "https://peer.example.com" });
    return Object.assign(srv as object, { Props: { worker } }) as Server;
  };

  test("a Worker host gets one `service` binding named after the logical id", async () => {
    const bound: unknown[] = [];
    await bind(worker(bound), withWorker({ Type: "Cloudflare.Worker", LogicalId: "Peer" }));
    expect(bound).toHaveLength(1);
    const bindings = (bound[0] as { bindings: { type: string; name: string }[] }).bindings;
    expect(bindings).toHaveLength(1);
    expect(bindings[0].type).toBe("service");
    expect(bindings[0].name).toBe("Ramose");
  });

  test("a bare-URL worker skips the service binding and uses HTTPS", async () => {
    const bound: unknown[] = [];
    await bind(worker(bound), withWorker("https://peer.example.com"));
    expect(bound).toEqual([]);
  });

  test("a { url } worker skips the service binding — an empty target is not a binding", async () => {
    const bound: unknown[] = [];
    await bind(worker(bound), withWorker({ url: "https://peer.example.com" }));
    expect(bound).toEqual([]);
  });

  test("a host that is not a Worker uses HTTPS — it is not a defect", async () => {
    const bound: unknown[] = [];
    await bind({ Type: "AWS.Lambda.Function", LogicalId: "Fn" }, withWorker("x"));
    expect(bound).toEqual([]);
  });
});
