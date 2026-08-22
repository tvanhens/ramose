/**
 * Build an `Op` handle: transaction verbs via {@link txBuilder}, plus the
 * injected reads / effect / principal. Shared by the client overlay and
 * the peer Worker so both sides run the same body.
 */

import * as Effect from "effect/Effect";
import type { AnyCatalog } from "./Catalog.ts";
import { type DbError, InternalError, InvalidRequest } from "./Errors.ts";
import {
  type OpPrincipal,
  type EffectThunk,
  type RuntimeOp,
  PrefixHalt,
} from "./Operation.ts";
import type { AnyQueryObject } from "./query/index.ts";
import { isEntity, txBuilder, type Entity } from "./Tx.ts";

export interface OpHandleOptions {
  readonly catalog: AnyCatalog;
  readonly db: string;
  readonly principal: OpPrincipal;
  readonly self?: unknown;
  readonly q: (
    input: AnyQueryObject,
    params?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, DbError>;
  readonly pull: (
    subject: unknown,
    pattern: unknown,
  ) => Effect.Effect<unknown, DbError>;
  /**
   * `"halt"` — client prefix: `op.effect` dies with {@link PrefixHalt}
   * (a defect, not a typed failure — the body never names it).
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
  readonly op: RuntimeOp;
  readonly ops: () => readonly unknown[];
}

const wrapSelf = (tx: ReturnType<typeof txBuilder>, self: unknown): Entity => {
  // Worker catalogs are empty; `tx.entity` is catalog-typed. The runtime
  // already accepts eid / tempid / lookup / handle via `resolveEntity`.
  const bind = tx.entity as (id?: unknown) => Effect.Effect<Entity>;
  return Effect.runSync(bind(self));
};

/** Narrow a pull subject to an engine entity ref without a channel cast. */
export const entityRefOf = (
  subject: unknown,
): number | string | [string, unknown] => {
  if (typeof subject === "number" || typeof subject === "string") return subject;
  if (isEntity(subject)) {
    const eid = subject.eid;
    if (typeof eid === "number" || typeof eid === "string") return eid;
    if (Array.isArray(eid) && eid.length === 2 && typeof eid[0] === "string") {
      return [eid[0], eid[1]];
    }
  }
  if (
    Array.isArray(subject) &&
    subject.length === 2 &&
    typeof subject[0] === "string"
  ) {
    return [subject[0], subject[1]];
  }
  throw new InvalidRequest({ message: "bad pull subject" });
};

const missingInstall = (): Effect.Effect<unknown, InternalError> =>
  Effect.fail(
    new InternalError({
      message: "ramose: no databases.install on this runtime",
    }),
  );

export const buildOp = (options: OpHandleOptions): BuiltOp => {
  const tx = txBuilder(options.catalog);
  const self =
    options.self === undefined ? undefined : wrapSelf(tx, options.self);

  const effect = <A, E>(
    _name: string,
    run: EffectThunk<A, E>,
  ): Effect.Effect<A, E | InternalError> => {
    if (options.effects === "halt") {
      return Effect.die(new PrefixHalt());
    }
    const ctx = {
      env: options.effectCtx?.env,
      principal: options.principal,
      databases: options.effectCtx?.databases ?? {
        install: () => missingInstall(),
      },
    };
    const out = run(ctx);
    if (Effect.isEffect(out)) return out;
    return Effect.tryPromise({
      try: () => out,
      catch: (cause) =>
        new InternalError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
  };

  const op: RuntimeOp = {
    ...tx,
    self,
    principal: options.principal,
    db: options.db,
    q: options.q,
    pull: options.pull,
    effect,
  };

  return {
    op,
    ops: () => tx.spec.ops,
  };
};

/** Run a body, treating a {@link PrefixHalt} defect as a successful prefix stop. */
export const runBody = (
  body: (op: RuntimeOp, input: unknown) => Effect.Effect<unknown, unknown>,
  op: RuntimeOp,
  input: unknown,
): Effect.Effect<{ output: unknown; halted: boolean }, unknown> =>
  body(op, input).pipe(
    Effect.map((output) => ({ output, halted: false })),
    Effect.catchDefect((defect) =>
      defect instanceof PrefixHalt
        ? Effect.succeed({ output: undefined, halted: true })
        : Effect.die(defect),
    ),
  );
