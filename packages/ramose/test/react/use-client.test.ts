/**
 * `ramose/react` is a Client Component module.
 *
 * Without `"use client"` on the published entry, `import { useLiveQuery } from
 * "ramose/react"` in a Next App Router or React Router server component is
 * a hard build error: the hooks use client-only React APIs and the package
 * never said so. `initialData` / Suspense live on the read hooks; this
 * file only pins the directive so a later edit cannot drop it. Deep
 * imports via the `*` export map can land on a hook module directly, so
 * each of those files carries it too.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REACT = resolve(here, "../../src/react");

/**
 * The published entry plus every module that calls a React hook. `errors.ts`
 * and `seam.ts` stay unmarked: they are pure helpers, not a client boundary.
 */
const CLIENT_MODULES = [
  "index.ts",
  "hooks.ts",
  "RamoseProvider.tsx",
  "useLiveQuery.ts",
  "useQuery.ts",
  "usePull.ts",
  "useOneShot.ts",
  "useBasis.ts",
  "useOperation.ts",
  "usePrincipal.ts",
  "useConnectionStatus.ts",
] as const;

/** First statement after a BOM, comments, and whitespace — the RSC rule. */
const firstStatement = (source: string): string | undefined => {
  const stripped = source
    .replace(/^\uFEFF/, "")
    .replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
  const match = /^["']([^"']*)["']/.exec(stripped);
  return match?.[1];
};

describe("`ramose/react` is a client module", () => {
  test.each([...CLIENT_MODULES])("%s opens with \"use client\"", (file) => {
    const source = readFileSync(resolve(REACT, file), "utf8");
    expect(firstStatement(source)).toBe("use client");
  });

  test("tsc emit keeps the directive on the published entry", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ramose-ts-emit-"));
    try {
      execFileSync(resolve(here, "../../../../node_modules/.bin/tsc"), [
        resolve(REACT, "index.ts"),
        "--ignoreConfig",
        "--module",
        "preserve",
        "--target",
        "es2022",
        "--noResolve",
        "--noCheck",
        "--outDir",
        outDir,
      ]);
      expect(firstStatement(readFileSync(resolve(outDir, "index.js"), "utf8"))).toBe(
        "use client",
      );
    } finally {
      rmSync(outDir, { recursive: true });
    }
  });
});
