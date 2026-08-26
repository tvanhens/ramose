/**
 * Build an `Op` handle: transaction verbs via {@link txBuilder}, plus the
 * injected reads / effect / principal. Shared by the client overlay and
 * the peer Worker so both sides run the same body.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { AnySchema } from "./Schema.ts";
import { type DbError, InternalError, InvalidRequest, isDatabaseError } from "./Errors.ts";
import {
  type AnyOperation,
  type EffectThunk,
  type Op,
  type OpHandle,
  type OpPrincipal,
  type RuntimeOp,
  type RuntimeOpHandle,
  PrefixHalt,
} from "./Operation.ts";
import { asPromise, runSync } from "./promise.ts";
import type { AnyQueryObject } from "./query/index.ts";
import { lowerEntityArg, tempid } from "./entityArg.ts";
import { txBuilder, txOps, type TxHandle } from "./Tx.ts";

export interface OpHandleOptions {
  readonly schema: AnySchema;
  readonly db: string;
  readonly principal: OpPrincipal;
  readonly self?: unknown;
  readonly q: (
    input: AnyQueryObject,
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
        schema: AnySchema,
        name?: string,
      ): Effect.Effect<unknown, DbError>;
    };
  };
}

export interface BuiltOp {
  readonly op: RuntimeOp;
  readonly ops: () => readonly unknown[];
}

const wrapSelf = (tx: ReturnType<typeof txBuilder>, self: unknown): TxHandle => {
  // Worker catalogs are empty; `tx.entity` is catalog-typed. The runtime
  // already accepts eid / tempid / lookup / handle via `resolveEntity`.
  const bind = tx.entity as (id?: unknown) => Effect.Effect<TxHandle>;
  return runSync(bind(self));
};

/** Narrow a pull subject to an engine entity ref without a channel cast. */
export const entityRefOf = (
  subject: unknown,
): number | string | [string, unknown] => {
  const lowered = lowerEntityArg(subject);
  if (typeof lowered === "number" || typeof lowered === "string") return lowered;
  if (
    Array.isArray(lowered) &&
    lowered.length === 2 &&
    typeof lowered[0] === "string"
  ) {
    return [lowered[0], lowered[1]];
  }
  throw new InvalidRequest({ message: "bad pull subject" });
};

const missingInstall = (): Effect.Effect<unknown, InternalError> =>
  Effect.fail(
    new InternalError({
      message: "ramose: no databases.install on this runtime",
    }),
  );

const asEffectCause = <E>(cause: unknown): E | DbError | InternalError => {
  if (isDatabaseError(cause)) return cause;
  if (
    cause !== null &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag: unknown })._tag === "string"
  ) {
    return cause as E;
  }
  return new InternalError({
    message: cause instanceof Error ? cause.message : String(cause),
  });
};

export const buildOp = (options: OpHandleOptions): BuiltOp => {
  const tx = txBuilder(options.schema);
  const self =
    options.self === undefined ? undefined : wrapSelf(tx, options.self);
  const prefix = { halted: false };
  let frozen: readonly unknown[] | undefined;

  const haltPrefix = (): void => {
    if (prefix.halted) return;
    prefix.halted = true;
    frozen = [...txOps(tx)];
  };

  const effect = <A, E>(
    _name: string,
    run: (
      ctx: {
        readonly env: unknown;
        readonly principal: OpPrincipal;
        readonly databases: {
          install(
            schema: AnySchema,
            name?: string,
          ): Effect.Effect<unknown, DbError>;
        };
      },
    ) => Effect.Effect<A, E> | Promise<A>,
  ): Effect.Effect<A, E | DbError | InternalError> => {
    if (options.effects === "halt") {
      haltPrefix();
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
      catch: (cause) => asEffectCause<E>(cause),
    });
  };

  const op: RuntimeOp = {
    self,
    principal: options.principal,
    db: options.db,
    _effects: options.effects,
    _prefix: prefix,
    _haltPrefix: haltPrefix,
    query: options.q,
    pull: options.pull,
    effect,
    entity: tx.entity,
    set: tx.set,
    remove: tx.remove,
    delete: tx.delete,
    put: tx.put,
    update: tx.update,
  };

  return {
    op,
    ops: () => frozen ?? txOps(tx),
  };
};

const promiseEntity = (entity: RuntimeOpHandle): OpHandle => ({
  _tag: "TxHandle",
  eid: entity.eid as OpHandle["eid"],
  set: (field, value) => {
    runSync(entity.set(field, value));
  },
  remove: (field, value) => {
    runSync(entity.remove(field, value));
  },
  delete: () => {
    runSync(entity.delete);
  },
});

/** Wrap the Effect runtime handle as the async `Op` a body sees. */
export const asPromiseOp = (op: RuntimeOp): Op<any, any> => {
  const entity = ((id?: unknown) =>
    promiseEntity(
      runSync(id === undefined ? op.entity() : op.entity(id)),
    )) as Op<any, any>["entity"];

  return {
    self: (op.self === undefined
      ? undefined
      : promiseEntity(op.self)) as Op<any, any>["self"],
    principal: op.principal,
    db: op.db,
    entity,
    tempid,
    set: (e, field, value) => {
      runSync(op.set(e, field, value));
    },
    remove: (e, field, value) => {
      runSync(op.remove(e, field, value));
    },
    delete: (e) => {
      runSync(op.delete(e));
    },
    put: ((entity: unknown, a: unknown, b?: unknown) =>
      promiseEntity(
        runSync(
          b === undefined ? op.put(entity, a) : op.put(entity, a, b),
        ),
      )) as Op<any, any>["put"],
    update: ((entity: unknown, a: unknown, b?: unknown) =>
      promiseEntity(
        runSync(
          b === undefined ? op.update(entity, a) : op.update(entity, a, b),
        ),
      )) as Op<any, any>["update"],
    query: ((input: AnyQueryObject) =>
      asPromise(op.query(input))) as Op["query"],
    pull: (subject, pattern) => asPromise(op.pull(subject, pattern)),
    effect: <A>(name: string, run: EffectThunk<A>): Promise<A> => {
      if (op._effects === "halt") {
        op._haltPrefix();
        throw new PrefixHalt();
      }
      return asPromise(
        op.effect(name, (ctx) =>
          Promise.resolve(
            run({
              env: ctx.env,
              principal: ctx.principal,
              databases: {
                install: (catalog, dbName) =>
                  asPromise(ctx.databases.install(catalog, dbName)),
              },
            }),
          ),
        ),
      );
    },
  };
};

/**
 * A throw out of an operation body.
 *
 * `operation.body` is user code, so `cause` holds whatever it threw,
 * untouched — callers classify the original value (a thrown {@link DbError}
 * stays a `DbError`). The wrapper exists so the error channel is typed:
 * `unknown` in the channel meant every caller had to re-discover what it
 * might be, and gave the compiler nothing to check.
 */
export class BodyFailed extends Data.TaggedError("ramose/BodyFailed")<{
  readonly cause: unknown;
}> {}

/** Run a body, treating a {@link PrefixHalt} as a successful prefix stop. */
export const runBody = (
  operation: Pick<AnyOperation, "body">,
  op: RuntimeOp,
  input: unknown,
): Effect.Effect<{ output: unknown; halted: boolean }, BodyFailed> =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation.body(asPromiseOp(op), input)),
    catch: (cause) => new BodyFailed({ cause }),
  }).pipe(
    Effect.map((output) =>
      op._prefix.halted
        ? { output: undefined, halted: true }
        : { output, halted: false },
    ),
    Effect.catch((error) =>
      op._prefix.halted || error.cause instanceof PrefixHalt
        ? Effect.succeed({ output: undefined, halted: true })
        : Effect.fail(error),
    ),
    Effect.catchDefect((defect) =>
      op._prefix.halted || defect instanceof PrefixHalt
        ? Effect.succeed({ output: undefined, halted: true })
        : Effect.die(defect),
    ),
  );
