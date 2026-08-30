/**
 * The `QuerySnapshot` → `QueryState` narrowing (#479 slice 1).
 *
 * A total function over four values, so it is stated here over ordinary inputs
 * rather than only where a replica can be persuaded to produce each one. React
 * is not involved and is not needed: this is the whole of what the adapter
 * decides.
 */

import { describe, expect, test } from "bun:test";
import type { QuerySnapshot } from "../../src/client/database.ts";
import { PENDING, toQueryState } from "../../src/react/query-state.ts";

const snapshot = <A>(
  overrides: Partial<QuerySnapshot<A>>,
): QuerySnapshot<A> => ({
  status: "pending",
  data: undefined,
  stale: true,
  error: undefined,
  ...overrides,
});

const rows = [{ title: "first" }, { title: "second" }];

describe("toQueryState", () => {
  test("maps every published snapshot onto exactly one branch", () => {
    expect(toQueryState(snapshot({}))).toEqual({ status: "pending" });
    expect(toQueryState(snapshot({ status: "ready", data: rows, stale: false })))
      .toEqual({ status: "ready", data: rows });
    expect(toQueryState(snapshot({ status: "ready", data: rows, stale: true })))
      .toEqual({ status: "stale", data: rows });
    const error = new Error("no");
    expect(toQueryState(snapshot({ status: "error", stale: false, error })))
      .toEqual({ status: "error", error });
    // A failed query says the local view could not answer it. Splitting that
    // by staleness would offer a component a distinction it cannot act on.
    expect(toQueryState(snapshot({ status: "error", stale: true, error })))
      .toEqual({ status: "error", error });
  });

  test("reads `status`, never the presence of `data`", () => {
    // `.one()` answers a legitimate miss with `undefined`, which is data, not
    // an absent answer. Keying the branch on `data !== undefined` would report
    // it as pending forever.
    const state = toQueryState(
      snapshot<undefined>({ status: "ready", data: undefined, stale: false }),
    );
    expect(state).toEqual({ status: "ready", data: undefined });
  });

  test("hands back the client's own `data`, so a memo survives a stale flip", () => {
    const ready = toQueryState(
      snapshot({ status: "ready", data: rows, stale: false }),
    );
    const stale = toQueryState(
      snapshot({ status: "ready", data: rows, stale: true }),
      ready,
    );
    expect(stale.status).toBe("stale");
    // The client reuses `data` across a stale flip; nothing here rebuilds it,
    // so `React.memo` on the rows is not invalidated by a reconnect.
    expect((stale as { data: unknown }).data).toBe(rows);
  });

  test("returns the previous state when two snapshots narrow to the same one", () => {
    const error = new Error("no");
    const first = toQueryState(snapshot({ status: "error", stale: true, error }));
    // A reconnect flipped `stale` under a failed query: a new published
    // snapshot, and nothing a component could render differently.
    expect(toQueryState(snapshot({ status: "error", stale: false, error }), first))
      .toBe(first);
    const ready = toQueryState(snapshot({ status: "ready", data: rows, stale: false }));
    expect(toQueryState(snapshot({ status: "ready", data: rows, stale: false }), ready))
      .toBe(ready);
    // And a real change is still a new value.
    expect(toQueryState(snapshot({ status: "ready", data: rows, stale: true }), ready))
      .not.toBe(ready);
  });

  test("pending is one frozen singleton", () => {
    expect(toQueryState(snapshot({}))).toBe(PENDING);
    expect(toQueryState(snapshot({}), PENDING)).toBe(PENDING);
    expect(Object.isFrozen(PENDING)).toBe(true);
  });

  test("names an error the client somehow did not", () => {
    // Unreachable through `ramose/client`, which always sets one. The branch
    // exists so a component is never handed `undefined` where its declared
    // `Error` belongs.
    const state = toQueryState(snapshot({ status: "error", stale: false }));
    expect(state.status).toBe("error");
    expect((state as { error: Error }).error).toBeInstanceOf(Error);
  });
});
