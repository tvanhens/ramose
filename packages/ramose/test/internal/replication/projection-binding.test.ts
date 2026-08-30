import { describe, expect, test } from "bun:test";
import type { AnyOptimisticProjection } from "../../../src/db/Projection.ts";
import type { CatalogId, OwnerRef } from "../../../src/internal/authorization/identities.ts";
import {
  makeClientProjectionCatalog,
  projectionIdentity,
  projectionOperationKey,
  resolveProjectionBinding,
  sameProjectionIdentity,
  type ClientProjectionCatalog,
  type InstalledProjection,
} from "../../../src/internal/replication/projection-binding.ts";
import type { QueuedOperation } from "../../../src/internal/replication/outbox.ts";

const owner: OwnerRef = { kind: "entity", name: "Issue" };
const move: QueuedOperation = {
  catalog: "reef" as CatalogId,
  owner,
  localName: "move",
};
const archive: QueuedOperation = { ...move, localName: "archive" };

const noop: AnyOptimisticProjection = () => {};
const other: AnyOptimisticProjection = () => {};

const catalog = (
  build: string,
  ...installed: readonly InstalledProjection[]
): ClientProjectionCatalog => makeClientProjectionCatalog(build, installed);

const withProjection = (
  operation: QueuedOperation,
  revision: number,
  run: AnyOptimisticProjection = noop,
): InstalledProjection => ({ operation, projection: { revision, run } });

describe("operation keys", () => {
  test("two owners that differ only by a separator do not collide", () => {
    const left = projectionOperationKey({
      ...move,
      owner: { kind: "entity", name: "a\u0000b" },
    });
    const right = projectionOperationKey({
      ...move,
      owner: { kind: "entity", name: "a" },
      localName: "b",
    });
    expect(left).not.toBe(right);
  });

  test("the same operation always keys the same", () => {
    expect(projectionOperationKey(move)).toBe(projectionOperationKey({ ...move }));
  });
});

describe("identity", () => {
  test("a build identity must survive a durable key", () => {
    expect(projectionIdentity("app@1", 2)).toEqual({ revision: 2, build: "app@1" });
    expect(projectionIdentity("app@1")).toEqual({ revision: 1, build: "app@1" });
    const withNul = `a${String.fromCharCode(0)}b`;
    for (const bad of ["", withNul, "x".repeat(257), 3, null]) {
      expect(() => projectionIdentity(bad)).toThrow(/build identity/);
    }
  });

  test("equality is both halves", () => {
    const base = projectionIdentity("app@1", 2);
    expect(sameProjectionIdentity(base, projectionIdentity("app@1", 2))).toBe(true);
    expect(sameProjectionIdentity(base, projectionIdentity("app@2", 2))).toBe(false);
    expect(sameProjectionIdentity(base, projectionIdentity("app@1", 3))).toBe(false);
  });
});

describe("catalog assembly", () => {
  test("pairs the inert descriptor with the original callback", () => {
    const installed = catalog("app@1", withProjection(move, 1), {
      operation: archive,
      projection: undefined,
    });
    expect(installed.build).toBe("app@1");
    expect(installed.entries.get(projectionOperationKey(move))?.projection?.run)
      .toBe(noop);
    expect(installed.entries.get(projectionOperationKey(archive))?.projection)
      .toBeUndefined();
  });

  test("refuses two operations with one identity", () => {
    expect(() => catalog("app@1", withProjection(move, 1), withProjection(move, 2)))
      .toThrow(/share the identity/);
  });

  test("refuses a projection that is not a function, or a bad revision", () => {
    expect(() =>
      catalog("app@1", {
        operation: move,
        projection: { revision: 1, run: "tx" as never },
      })
    ).toThrow(/not a function/);
    expect(() => catalog("app@1", withProjection(move, 0))).toThrow(
      /positive integer/,
    );
  });
});

describe("the decision table", () => {
  const installed = catalog("app@2", withProjection(move, 2, other));

  test("a record queued without a projection reconstructs none", () => {
    expect(resolveProjectionBinding(installed, { operation: move, projection: null }))
      .toEqual({ type: "none" });

    expect(
      resolveProjectionBinding(installed, { operation: archive, projection: null }),
    ).toEqual({ type: "none" });
  });

  test("an operation the bundle no longer declares is update-required", () => {
    expect(
      resolveProjectionBinding(installed, {
        operation: archive,
        projection: projectionIdentity("app@2", 2),
      }),
    ).toEqual({ type: "update-required", reason: "operation-missing" });
  });

  test("an operation that dropped its projection is update-required", () => {
    const dropped = catalog("app@2", { operation: move, projection: undefined });
    expect(
      resolveProjectionBinding(dropped, {
        operation: move,
        projection: projectionIdentity("app@1", 2),
      }),
    ).toEqual({ type: "update-required", reason: "projection-missing" });
  });

  test("revision drift is update-required, never executed", () => {
    expect(
      resolveProjectionBinding(installed, {
        operation: move,
        projection: projectionIdentity("app@2", 1),
      }),
    ).toEqual({ type: "update-required", reason: "projection-revision" });
  });

  test("a matching identity binds the installed callback", () => {
    expect(
      resolveProjectionBinding(installed, {
        operation: move,
        projection: projectionIdentity("app@2", 2),
      }),
    ).toEqual({
      type: "bound",
      identity: { revision: 2, build: "app@2" },
      rebound: false,
      run: other,
    });
  });

  test("build drift alone rebinds, because a redeploy is not drift", () => {

    const binding = resolveProjectionBinding(installed, {
      operation: move,
      projection: projectionIdentity("app@1", 2),
    });
    expect(binding).toEqual({
      type: "bound",
      identity: { revision: 2, build: "app@2" },
      rebound: true,
      run: other,
    });
  });
});
