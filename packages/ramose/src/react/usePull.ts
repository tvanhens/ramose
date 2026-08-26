"use client";

/**
 * `useLivePull` — a live `db.livePull(subject, pattern)` as `Read` state:
 * `data` is the projection or `null` (a retract is an emission, not an end),
 * and a pinned view emits once, completes, and keeps its data.
 *
 * `usePull` — the one-shot twin: one `db.pull` per view / subject / pattern.
 *
 * Three coordinates are structural: the view (`db.asOf(t)`), the `subject`
 * (a branded cell, number, or lookup ref), and the `pattern` (canonical
 * JSON of `lowerPullPattern`). A render-fresh `{ title: Todo.title }` is
 * the same pull as a hoisted one. Changing the subject blanks `data` on
 * the live hook until the new pull lands; the one-shot keeps the previous
 * `data` while the next run is in flight.
 *
 * `initialData` hydrates this key so a server pull can paint on the first
 * client render. `{ suspense: true }` throws until the first answer.
 */

import type {
  Schema,
  DbError,
  EntityRef,
  IdentPullPattern,
  Pull,
  ReadDb,
  ValidatePull,
} from "../db/index.ts";
import { pullPatternKey } from "../db/astKey.ts";
import {
  type Read,
  type ReadOptions,
  type SuspendedRead,
  readT,
} from "./read.ts";
import { seamOf, viewDep, viewKeyOf } from "./seam.ts";
import { useLiveSubscription } from "./useLiveQuery.ts";
import { useOneShot } from "./useOneShot.ts";

/** The pattern a subject accepts — the same rule as `db.pull` / `db.livePull`. */
type PullPattern<C extends Schema.Any, P> = [P] extends [readonly unknown[]]
  ? P & IdentPullPattern<C>
  : ValidatePull<C, P>;

type PullOut<C extends Schema.Any, P> = Pull<C, P> | null;

/**
 * The subject, flattened to the coordinates the wire would see: `{ id }` to
 * the id, a lookup ref to `[ident, value]` whichever way its head is spelled.
 */
const subjectKey = (subject: unknown): string => {
  if (Array.isArray(subject) && subject.length === 2) {
    const head: unknown = subject[0];
    const ident =
      typeof head === "object" && head !== null && "ident" in head
        ? (head as { ident: unknown }).ident
        : head;
    return JSON.stringify([ident, subject[1]]);
  }
  const id = (subject as { id?: unknown } | null)?.id;
  return JSON.stringify(id ?? subject);
};

export function useLivePull<C extends Schema.Any, const P>(
  db: ReadDb<C>,
  subject: EntityRef<C>,
  pattern: PullPattern<C, P>,
  options: ReadOptions<PullOut<C, P>> & { suspense: true },
): SuspendedRead<PullOut<C, P>, DbError>;
export function useLivePull<C extends Schema.Any, const P>(
  db: ReadDb<C>,
  subject: EntityRef<C>,
  pattern: PullPattern<C, P>,
  options?: ReadOptions<PullOut<C, P>>,
): Read<PullOut<C, P>, DbError>;
export function useLivePull<C extends Schema.Any, const P>(
  db: ReadDb<C>,
  subject: EntityRef<C>,
  pattern: PullPattern<C, P>,
  options?: ReadOptions<PullOut<C, P>>,
): Read<PullOut<C, P>, DbError> {
  const view = viewDep(db);
  const key = subjectKey(subject);
  const astKey = pullPatternKey(pattern);
  return useLiveSubscription(
    () => ({
      sub: db.livePull<P>(subject, pattern),
      owned: true,
    }),
    [view, key, astKey],
    [view, key, astKey],
    {
      ...(options?.initialData !== undefined && { initialData: options.initialData }),
      ...(options?.initialT !== undefined && { initialT: options.initialT }),
      ...(options?.suspense !== undefined && { suspense: options.suspense }),
      suspendKey: `live\0${viewKeyOf(db)}\0${key}\0${astKey}`,
      basis: () => readT(db),
      refetch: () => db.pull<P>(subject, pattern),
      seam: {
        generation: () => seamOf(db)?.generation() ?? 0,
        status: () => seamOf(db)?.status() ?? "offline",
        onWake: (cb) => seamOf(db)?.onWake(cb),
      },
    },
  );
}

export function usePull<C extends Schema.Any, const P>(
  db: ReadDb<C>,
  subject: EntityRef<C>,
  pattern: PullPattern<C, P>,
  options: ReadOptions<PullOut<C, P>> & { suspense: true },
): SuspendedRead<PullOut<C, P>, DbError>;
export function usePull<C extends Schema.Any, const P>(
  db: ReadDb<C>,
  subject: EntityRef<C>,
  pattern: PullPattern<C, P>,
  options?: ReadOptions<PullOut<C, P>>,
): Read<PullOut<C, P>, DbError>;
export function usePull<C extends Schema.Any, const P>(
  db: ReadDb<C>,
  subject: EntityRef<C>,
  pattern: PullPattern<C, P>,
  options?: ReadOptions<PullOut<C, P>>,
): Read<PullOut<C, P>, DbError> {
  const view = viewDep(db);
  const key = subjectKey(subject);
  const astKey = pullPatternKey(pattern);
  return useOneShot(
    () => db.pull<P>(subject, pattern),
    () => readT(db),
    [view, key, astKey],
    {
      ...(options?.initialData !== undefined && { initialData: options.initialData }),
      ...(options?.initialT !== undefined && { initialT: options.initialT }),
      ...(options?.suspense !== undefined && { suspense: options.suspense }),
      suspendKey: `one\0${viewKeyOf(db)}\0${key}\0${astKey}`,
    },
  );
}
