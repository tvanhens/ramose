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

    expect(toQueryState(snapshot({ status: "error", stale: true, error })))
      .toEqual({ status: "error", error });
  });

  test("reads `status`, never the presence of `data`", () => {

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

    expect((stale as { data: unknown }).data).toBe(rows);
  });

  test("returns the previous state when two snapshots narrow to the same one", () => {
    const error = new Error("no");
    const first = toQueryState(snapshot({ status: "error", stale: true, error }));

    expect(toQueryState(snapshot({ status: "error", stale: false, error }), first))
      .toBe(first);
    const ready = toQueryState(snapshot({ status: "ready", data: rows, stale: false }));
    expect(toQueryState(snapshot({ status: "ready", data: rows, stale: false }), ready))
      .toBe(ready);

    expect(toQueryState(snapshot({ status: "ready", data: rows, stale: true }), ready))
      .not.toBe(ready);
  });

  test("pending is one frozen singleton", () => {
    expect(toQueryState(snapshot({}))).toBe(PENDING);
    expect(toQueryState(snapshot({}), PENDING)).toBe(PENDING);
    expect(Object.isFrozen(PENDING)).toBe(true);
  });

  test("names an error the client somehow did not", () => {

    const state = toQueryState(snapshot({ status: "error", stale: false }));
    expect(state.status).toBe("error");
    expect((state as { error: Error }).error).toBeInstanceOf(Error);
  });
});
