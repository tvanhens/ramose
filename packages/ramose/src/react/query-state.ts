/**
 * The React-shaped reading of one framework-neutral {@link QuerySnapshot}.
 *
 * `ramose/client` publishes a flat record — `status`, `data`, `stale`, `error`
 * — because it has to describe every combination those four can be in. React
 * renders branches, so the adapter narrows the same value into a discriminated
 * union that a component can switch on without ever asking whether `data` is
 * present.
 *
 * The mapping is total, pure, and the whole of what this module owns. There is
 * no state machine here: every input is a value the client already published.
 */

import type { QuerySnapshot } from "../client/database.ts";

/**
 * One query's current answer, as a component reads it.
 *
 * - `pending` — no local value has been derived for this query yet. A cold
 *   start, a candidate replica that the current session has not confirmed, and
 *   a fenced principal all read as `pending`: an incomplete or unauthorized
 *   local value is never exposed as data.
 * - `ready` — `data` is the answer over the local view, confirmed by the
 *   current session.
 * - `stale` — `data` is a complete answer over a local value the current
 *   session has not confirmed: a restored offline replica, a reconnect in
 *   flight, or an unreachable server. It is real data, not a placeholder.
 * - `error` — the query could not be answered against the current local view.
 *
 * `data` is the same value the client published, so it keeps its identity
 * across a `ready` ⇄ `stale` transition: a child memoized on `state.data` is
 * not re-rendered by a reconnect.
 *
 * The issue's union types `error` as `unknown`; the neutral layer guarantees an
 * `Error`, so the adapter narrows rather than widens it. Every other member is
 * exactly as specified.
 */
export type QueryState<A> =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly data: A }
  | { readonly status: "stale"; readonly data: A }
  | { readonly status: "error"; readonly error: Error };

/**
 * The one `pending` value.
 *
 * A frozen singleton so `getSnapshot()` can return it without allocating, and
 * so a component that stayed pending across a re-render is handed the very same
 * object React compared last time.
 */
export const PENDING: QueryState<never> = Object.freeze({
  status: "pending" as const,
});

/**
 * A query the client reported as failed without naming a cause.
 *
 * The neutral layer always sets `error` alongside `status: "error"`, so this is
 * unreachable through `ramose/client`. It exists because the alternative is
 * handing a component `undefined` where its `Error` is declared to be.
 */
const unnamedFailure = (): Error =>
  new Error("ramose/react: the query failed without a reported cause");

/**
 * Narrow one published snapshot into the union a component switches on.
 *
 * | `QuerySnapshot`                    | `QueryState`                   |
 * | ---------------------------------- | ------------------------------ |
 * | `status: "pending"`                | `{ status: "pending" }`        |
 * | `status: "ready"`, `stale: false`  | `{ status: "ready", data }`    |
 * | `status: "ready"`, `stale: true`   | `{ status: "stale", data }`    |
 * | `status: "error"`                  | `{ status: "error", error }`   |
 *
 * `stale` is read only where it changes what a component may conclude. A
 * pending snapshot is stale by construction and has nothing to show either way,
 * and a failed one already says the local view could not answer — reporting
 * that failure twice, once per staleness, would split the error branch for no
 * decision a component could make differently.
 *
 * `previous` is the state this consumer last saw. It is not an optimization
 * detail: two different snapshots can narrow to the same state — a reconnect
 * that flips `stale` under a failed query is one — and returning a new equal
 * object would re-render every consumer for a change React was told did not
 * reach them.
 */
export const toQueryState = <A>(
  snapshot: QuerySnapshot<A>,
  previous?: QueryState<A> | undefined,
): QueryState<A> => {
  switch (snapshot.status) {
    case "pending":
      return PENDING;
    case "error": {
      const error = snapshot.error ?? unnamedFailure();
      return previous !== undefined && previous.status === "error" &&
          previous.error === error
        ? previous
        : Object.freeze({ status: "error" as const, error });
    }
    case "ready": {
      const status = snapshot.stale ? ("stale" as const) : ("ready" as const);
      // `data` identity is the client's, never rebuilt here: it is what makes
      // `React.memo` and `useMemo` over a row set survive a reconnect.
      const data = snapshot.data as A;
      return previous !== undefined && previous.status === status &&
          previous.data === data
        ? previous
        : Object.freeze({ status, data });
    }
  }
};
