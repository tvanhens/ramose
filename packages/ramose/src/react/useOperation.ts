"use client";

/**
 * `useOperation(db, op)` — typed write hook for one operation. `run` matches
 * `db.run`: `(input)` or `(entity, input)`. Always resolves
 * `{ ok: true, value } | { ok: false, error }` so `void run(...)` is safe.
 *
 * Pending / error are per invocation key — contextual ops key on the entity
 * (the number, or `{ id }`), so two buttons on one hook instance can spinner
 * independently. `pending` / `error` are the roll-up (any in flight / last
 * settler), the same shape `useTransact` used to expose as a global count.
 */

import type {
  AnyEntity,
  AnyOperation,
  Db,
  OpReport,
  Operation,
  Schema,
} from "../db/index.ts";
import type { RunArg, RunEntity } from "../db/Operation.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** What `run` resolves — always, so `void run(...)` is safe. */
export type RunResult<A, E = unknown> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E };

export interface OperationHandle<Run, E = unknown> {
  /**
   * Runs the operation. Always resolves — failure lands on `error` /
   * `errorFor` / `onError` and on the rejected half of the result, so
   * `void run(...)` is safe.
   */
  readonly run: Run;
  /** Any invocation from this hook is in flight. */
  readonly pending: boolean;
  /** This invocation key is in flight. Contextual ops key on the entity. */
  readonly pendingFor: (key: unknown) => boolean;
  /**
   * The last-settled failure — cleared when a run settles successfully.
   * Concurrent runs: the last settler wins.
   */
  readonly error: E | undefined;
  readonly errorFor: (key: unknown) => E | undefined;
  readonly clearError: () => void;
}

export type OperationOptions<E = unknown> = {
  onError?: (error: E) => void;
};

type NonContextualRun<
  C extends Schema.Any,
  I,
  O,
  OC extends Schema.Any,
  E,
> = (
  input: RunArg<C, OC, I>,
) => Promise<RunResult<OpReport<O, C>, E>>;

type ContextualRun<
  C extends Schema.Any,
  I,
  O,
  N extends AnyEntity,
  OC extends Schema.Any,
  E,
> = (
  entity: RunArg<C, OC, RunEntity<C, N>>,
  input: I,
) => Promise<RunResult<OpReport<O, C>, E>>;

/** Entity argument → invocation key (number, `{ id }`, or the value). */
const invocationKey = (value: unknown): unknown => {
  if (typeof value === "number") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { id: unknown }).id === "number"
  ) {
    return (value as { id: number }).id;
  }
  return value;
};

export function useOperation<
  C extends Schema.Any,
  I,
  O,
  OC extends Schema.Any = Schema.Any,
  E = unknown,
>(
  db: Db<C>,
  operation: Operation<string, I, O, undefined, OC>,
  options?: OperationOptions<E>,
): OperationHandle<NonContextualRun<C, I, O, OC, E>, E>;
export function useOperation<
  C extends Schema.Any,
  I,
  O,
  N extends AnyEntity,
  OC extends Schema.Any = Schema.Any,
  E = unknown,
>(
  db: Db<C>,
  operation: Operation<string, I, O, N, OC>,
  options?: OperationOptions<E>,
): OperationHandle<ContextualRun<C, I, O, N, OC, E>, E>;
export function useOperation(
  db: Db,
  operation: AnyOperation,
  options?: OperationOptions,
): OperationHandle<
  (a: unknown, b?: unknown) => Promise<RunResult<OpReport<unknown>>>
> {
  const [inFlight, setInFlight] = useState(0);
  const [pendingKeys, setPendingKeys] = useState<ReadonlyMap<unknown, number>>(
    () => new Map(),
  );
  const [error, setError] = useState<unknown>(undefined);
  const [errors, setErrors] = useState<ReadonlyMap<unknown, unknown>>(
    () => new Map(),
  );

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onErrorRef = useRef(options?.onError);
  onErrorRef.current = options?.onError;

  const run = useCallback(
    async (
      a: unknown,
      b?: unknown,
    ): Promise<RunResult<OpReport<unknown>>> => {
      const key = invocationKey(a);
      if (mounted.current) {
        setInFlight((n) => n + 1);
        setPendingKeys((prev) => {
          const next = new Map(prev);
          next.set(key, (next.get(key) ?? 0) + 1);
          return next;
        });
      }
      try {
        const value =
          operation.on !== undefined
            ? await db.run(operation as never, a as never, b as never)
            : await db.run(operation as never, a as never);
        if (mounted.current) {
          setError(undefined);
          setErrors((prev) => {
            if (!prev.has(key)) return prev;
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
        }
        return { ok: true, value };
      } catch (failure) {
        const err = failure;
        if (mounted.current) {
          setError(err);
          setErrors((prev) => {
            const next = new Map(prev);
            next.set(key, err);
            return next;
          });
        }
        onErrorRef.current?.(err);
        return { ok: false, error: err };
      } finally {
        if (mounted.current) {
          setInFlight((n) => n - 1);
          setPendingKeys((prev) => {
            const next = new Map(prev);
            const left = (next.get(key) ?? 1) - 1;
            if (left <= 0) next.delete(key);
            else next.set(key, left);
            return next;
          });
        }
      }
    },
    [db, operation],
  );

  const pendingFor = useCallback(
    (key: unknown) => (pendingKeys.get(key) ?? 0) > 0,
    [pendingKeys],
  );
  const errorFor = useCallback(
    (key: unknown) => errors.get(key),
    [errors],
  );
  const clearError = useCallback(() => {
    setError(undefined);
    setErrors(new Map());
  }, []);

  const pending = inFlight > 0;
  return useMemo(
    () => ({ run, pending, pendingFor, error, errorFor, clearError }),
    [run, pending, pendingFor, error, errorFor, clearError],
  );
}
