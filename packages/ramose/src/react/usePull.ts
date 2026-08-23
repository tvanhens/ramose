"use client";

/**
 * `usePull` — a standing `db.livePull(subject, pattern)` as `Live` state:
 * `rows` is the projection or `null` (a retract is an emission, not an end),
 * and a pinned view emits once, completes, and keeps its rows.
 *
 * Two rules for callers: the view and the `subject` are structural —
 * `db.asOf(t)` and `{ id: 17 }` written inline are fine — while `pattern`
 * is identity, so hoist it exactly as you hoist a query. Changing the
 * subject blanks `rows` until the new pull lands.
 */

import type {
  Schema,
  SchemaEid,
  Eid,
  IdentPullPattern,
  LookupRef,
  Pull,
  ReadDb,
  ValidatePull,
} from "../db/index.ts";
import { type Live, useLiveSubscription } from "./useLive.ts";
import { viewDep } from "./seam.ts";

/** The pattern a subject accepts — the same rule as `db.pull` / `db.livePull`. */
type PullPattern<C extends Schema.Any, P> = [P] extends [readonly unknown[]]
  ? P & IdentPullPattern<C>
  : ValidatePull<C, P>;

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

export const usePull = <C extends Schema.Any, const P>(
  db: ReadDb<C>,
  subject: Eid<C> | SchemaEid<C> | LookupRef<C>,
  pattern: PullPattern<C, P>,
): Live<Pull<C, P> | null> => {
  const view = viewDep(db);
  const key = subjectKey(subject);
  return useLiveSubscription(
    () => ({
      sub: db.livePull<P>(subject, pattern),
      owned: true,
    }),
    [view, key, pattern],
    [view, key, pattern],
  );
};
