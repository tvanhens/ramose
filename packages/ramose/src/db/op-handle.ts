/**
 * Build an `Op` handle: transaction verbs via {@link txBuilder}, plus the
 * injected reads / effect / principal. Shared by the client overlay and
 * the peer Worker so both sides run the same body.
 */

import * as Effect from "effect/Effect";
import type { AnyCatalog } from "./Catalog.ts";
import type { DbError } from "./Errors.ts";
import {
  type Op,
  type OpPrincipal,
  type EffectThunk,
  PrefixHalt,
} from "./Operation.ts";
import { txBuilder, type Entity } from "./Tx.ts";

export interface OpHandleOptions {
  readonly catalog: AnyCatalog;
  readonly db: string;
  readonly principal: OpPrincipal;
  readonly self?: unknown;
  readonly q: (
    input: unknown,
    params?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, DbError>;
  readonly pull: (
    subject: unknown,
    pattern: unknown,
  ) => Effect.Effect<unknown, DbError>;
  /**
   * `"halt"` — client prefix: `op.effect` fails with {@link PrefixHalt}.
   * `"run"` — server: evaluate the thunk with `ctx`.
   */
  readonly effects: "halt" | "run";
  readonly effectCtx?: {
    readonly env: unknown;
    readonly databases: {
      install(
        catalog: AnyCatalog,
        name?: string,
      ): Effect.Effect<unknown, DbError>;
    };
  };
}

export interface BuiltOp {
  readonly op: Op<any>;
  readonly ops: () => readonly unknown[];
}

export const buildOp = (options: OpHandleOptions): BuiltOp => {
  const tx = txBuilder(options.catalog);
  let self: Entity | undefined;
  if (options.self !== undefined) {
    self = Effect.runSync(tx.entity(options.self as never));
  }

  const effect = <A, E, R>(
    _name: string,
    run: EffectThunk<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    if (options.effects === "halt") {
      return Effect.fail(new PrefixHalt()) as unknown as Effect.Effect<A, E, R>;
    }
    const ctx = {
      env: options.effectCtx?.env,
      principal: options.principal,
      databases: options.effectCtx?.databases ?? {
        install: () =>
          Effect.fail({
            _tag: "InternalError",
            message: "ramose: no databases.install on this runtime",
          } as DbError),
      },
    };
    const out = run(ctx);
    return (
      Effect.isEffect(out)
        ? out
        : Effect.tryPromise({
            try: () => out,
            catch: (cause) =>
              ({
                _tag: "InternalError",
                message:
                  cause instanceof Error ? cause.message : String(cause),
              }) as DbError,
          })
    ) as Effect.Effect<A, E, R>;
  };

  const op = {
    ...tx,
    self,
    principal: options.principal,
    db: options.db,
    q: options.q,
    pull: options.pull,
    effect,
  } as Op<any>;

  return {
    op,
    ops: () => tx.spec.ops,
  };
};

const isPrefixHalt = (e: unknown): e is PrefixHalt =>
  typeof e === "object" &&
  e !== null &&
  (e as { _tag?: unknown })._tag === "ramose/PrefixHalt";

/** Run a body, treating {@link PrefixHalt} as a successful prefix stop. */
export const runBody = (
  body: (op: Op<any>, input: unknown) => Effect.Effect<unknown, any, any>,
  op: Op<any>,
  input: unknown,
): Effect.Effect<{ output: unknown; halted: boolean }, unknown> =>
  body(op, input).pipe(
    Effect.map((output) => ({ output, halted: false })),
    Effect.catchIf(isPrefixHalt, () =>
      Effect.succeed({ output: undefined, halted: true }),
    ),
  ) as Effect.Effect<{ output: unknown; halted: boolean }, unknown>;
