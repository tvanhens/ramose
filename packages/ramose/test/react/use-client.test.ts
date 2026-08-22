/**
 * `ramose/react` is a Client Component module.
 *
 * Without `"use client"` on the published entry, `import { useLive } from
 * "ramose/react"` in a Next App Router or React Router server component is
 * a hard build error: the hooks use client-only React APIs and the package
 * never said so. The remaining SSR work (`initialData`, Suspense) is not
 * this file's job — this only pins the one-line unblock so a later edit
 * cannot drop the directive. Deep imports via the `*` export map can land
 * on a hook module directly, so each of those files carries it too.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
  "useLive.ts",
  "useQuery.ts",
  "usePull.ts",
  "useBasis.ts",
  "useTransact.ts",
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
    const source = readFileSync(resolve(REACT, "index.ts"), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: "index.ts",
    });
    expect(firstStatement(outputText)).toBe("use client");
  });
});
