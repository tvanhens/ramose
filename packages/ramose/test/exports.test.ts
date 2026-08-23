/**
 * The published `exports` map, exactly.
 *
 * Wildcard subpaths used to make every file under `src/` a semver-bound
 * entry (`ramose/internal/core`, `ramose/db/internal`, `ramose/query`).
 * The map is now enumerated: a consumer cannot resolve internals or the
 * cut leftover entries. Public barrels still resolve.
 */

import { describe, expect, test } from "bun:test";

const PUBLIC = [
  "ramose",
  "ramose/db",
  "ramose/db/effect",
  "ramose/worker",
  "ramose/react",
  "ramose/better-auth",
  "ramose/better-auth/client",
  "ramose/effect",
] as const;

const CUT = [
  "ramose/internal/core",
  "ramose/internal/core/policy/ast.ts",
  "ramose/internal/core/index.ts",
  "ramose/db/internal",
  "ramose/Source",
  "ramose/ServerRuntime",
  "ramose/query",
  "ramose/schema",
  "ramose/workerEntry",
] as const;

const resolve = (spec: string): string => Bun.resolveSync(spec, import.meta.path);

describe("the `ramose` exports map", () => {
  test("public barrels resolve", () => {
    for (const spec of PUBLIC) {
      expect(() => resolve(spec)).not.toThrow();
    }
  });

  test("ramose/internal/* and cut subpaths cannot resolve from a consumer", () => {
    const failed: string[] = [];
    for (const spec of CUT) {
      try {
        resolve(spec);
        failed.push(spec);
      } catch {
        // expected — package exports do not list these
      }
    }
    expect(failed).toEqual([]);
  });
});
