/**
 * `@ripple/alchemy/db` is the portable entry: a browser gets it with no
 * bundler alias, no deploy engine and no dead weight.
 *
 * Two guards, both on the *whole transitive import graph* of the barrel:
 *
 *   1. nothing reaches `alchemy` (the deploy engine — `alchemy`,
 *      `alchemy/RuntimeContext`, `alchemy/Binding`, …). That import is what
 *      forced the old `@ripple/alchemy/schema` Vite alias.
 *   2. nothing reaches the `@ripple/core` *barrel*. Deep imports
 *      (`@ripple/core/json.ts`) are how the codec is taken; the barrel drags
 *      the engine — segment trees, the query planner, the store — into a
 *      browser bundle.
 *
 * The walk is static and includes `import type`: a type-only edge to `alchemy`
 * is still a coupling this entry is not allowed to have.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const BARREL = resolve(here, "../src/db/index.ts");

/** Bare specifiers that resolve to source we own and therefore keep walking. */
const CORE = "@ripple/core";

/** `import … from "x"`, `export … from "x"`, `import("x")` — one regex each. */
const SPECIFIERS = [
  /(?:^|\n)\s*(?:import|export)[\s\S]*?\sfrom\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

const specifiersOf = (source: string): string[] => {
  const out: string[] = [];
  for (const re of SPECIFIERS) {
    re.lastIndex = 0;
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      if (m[1] !== undefined) out.push(m[1]);
    }
  }
  return out;
};

const resolveLocal = (from: string, spec: string): string | undefined => {
  if (spec.startsWith(".")) return resolve(dirname(from), spec);
  if (spec === CORE) return undefined; // the barrel — reported, not walked
  if (spec.startsWith(`${CORE}/`)) {
    return resolve(repo, "packages/core/src", spec.slice(CORE.length + 1));
  }
  return undefined; // effect/*, alchemy/*, node built-ins: not ours to walk
};

interface Graph {
  readonly files: ReadonlySet<string>;
  /** `specifier` → the file that imported it, for a legible failure. */
  readonly bare: ReadonlyMap<string, string>;
}

const walk = (entry: string): Graph => {
  const files = new Set<string>();
  const bare = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!existsSync(file)) throw new Error(`unresolved import: ${file}`);
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      const next = resolveLocal(file, spec);
      if (next === undefined) {
        if (!bare.has(spec)) bare.set(spec, file);
      } else {
        queue.push(next);
      }
    }
  }
  return { files, bare };
};

describe("@ripple/alchemy/db is portable", () => {
  const graph = walk(BARREL);
  const blame = (spec: string) =>
    `${spec} (imported by ${relative(repo, graph.bare.get(spec) ?? "?")})`;

  test("no module in the graph imports `alchemy`", () => {
    const engine = [...graph.bare.keys()].filter(
      (spec) => spec === "alchemy" || spec.startsWith("alchemy/"),
    );
    expect(engine.map(blame)).toEqual([]);
  });

  test("no module in the graph imports the `@ripple/core` barrel", () => {
    const barrel = [...graph.bare.keys()].filter((spec) => spec === CORE);
    expect(barrel.map(blame)).toEqual([]);
    expect(graph.files.has(resolve(repo, "packages/core/src/index.ts"))).toBe(
      false,
    );
  });

  test("the graph is otherwise only `effect` and our own source", () => {
    for (const spec of graph.bare.keys()) {
      expect(spec === "effect" || spec.startsWith("effect/")).toBe(true);
    }
    for (const file of graph.files) {
      const rel = relative(repo, file);
      expect(
        rel.startsWith("packages/alchemy/src/") ||
          rel.startsWith("packages/core/src/"),
      ).toBe(true);
    }
  });

  test("it bundles for the browser", async () => {
    const built = await Bun.build({
      entrypoints: [BARREL],
      target: "browser",
      external: ["effect", "effect/*"],
    });
    expect(built.logs.filter((l) => l.level === "error")).toEqual([]);
    expect(built.success).toBe(true);
    const bundle = await built.outputs[0]!.text();
    expect(bundle).not.toContain('from "alchemy');
    expect(bundle).not.toContain('require("alchemy');
  });
});

describe("the `/db` barrel's public names", () => {
  test("schema, connecting, and the eight errors — and nothing else", async () => {
    const db = await import("../src/db/index.ts");
    expect(Object.keys(db).sort()).toEqual(
      [
        // schema
        "Attr",
        "Namespace",
        "Catalog",
        "Instant",
        "Uuid",
        "UuidString",
        "Ref",
        "Long",
        "Bytes",
        // navigational query (issue #18)
        "query",
        "or",
        "not",
        // connecting
        "layer",
        "Databases",
        // errors
        "TxRejected",
        "Unavailable",
        "InvalidRequest",
        "DatabaseNotFound",
        "Unauthorized",
        "QueryBudgetExceeded",
        "InternalError",
        "NetworkError",
      ].sort(),
    );
  });
});
