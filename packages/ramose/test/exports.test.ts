/**
 * The published `exports` map, exactly.
 *
 * Wildcard subpaths used to make every file under `src/` a semver-bound
 * entry (`ramose/internal/core`, `ramose/db/internal`, `ramose/query`).
 * The map is now enumerated: a consumer cannot resolve internals or the
 * cut leftover entries. Public barrels still resolve.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(here, "../package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports: Record<string, Record<string, unknown>>;
};

const PUBLIC = [
  "ramose",
  "ramose/db",
  "ramose/worker",
  "ramose/better-auth",
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
  "ramose/RamoseEnv",
  "ramose/worker/errors",
  "ramose/worker/handle",
  "ramose/worker/operation-catalogs",
  "ramose/worker/peer",
  "ramose/worker/public-observation",
  "ramose/worker/storage-test-admin",
  "ramose/worker/test-admin",
  "ramose/worker/testing",
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

  test("root has no production browser-client condition", () => {
    const root = manifest.exports["."];
    expect(root).toBeDefined();
    expect(root!.browser).toBeUndefined();
    expect(root!.bun).toBeUndefined();
    expect(root!.default).toBe("./dist/index.js");
    for (const spec of PUBLIC) {
      const entry = spec === "ramose" ? "." : `.${spec.slice("ramose".length)}`;
      expect(manifest.exports[entry]?.bun).toBeUndefined();
    }
  });

  test("platform-bun/node are gone; zod is an optional peer", () => {
    const deps = manifest.dependencies ?? {};
    expect(deps["@effect/platform-bun"]).toBeUndefined();
    expect(deps["@effect/platform-node"]).toBeUndefined();
    expect(deps.zod).toBeUndefined();
    expect(manifest.peerDependencies?.zod).toBe("^4.3.6");
    expect(manifest.peerDependenciesMeta?.zod?.optional).toBe(true);
  });
});
