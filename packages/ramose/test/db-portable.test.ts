/**
 * `ramose/db` is the portable entry: a browser gets it with no bundler alias,
 * no deploy engine and no dead weight.
 *
 * Three guards, all on the *whole transitive import graph* of the barrel:
 *
 *   1. nothing reaches `alchemy` (the deploy engine — `alchemy`,
 *      `alchemy/RuntimeContext`, `alchemy/Binding`, …). Such an import would
 *      force every browser build to carry a bundler alias.
 *   2. nothing reaches the engine barrel (`src/internal/core/index.ts`). Deep
 *      imports (`internal/core/json.ts`) are how the codec is taken; the barrel
 *      drags the engine — segment trees, the query planner, the store — into a
 *      browser bundle.
 *   3. every file in the graph is under `src/db/` or `src/internal/core/`.
 *      The server, the React hooks and the Better Auth plugins are folders in
 *      this same package, so nothing but this assertion stops a stray relative
 *      import from pulling the peer Worker into a browser bundle.
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
const SRC = resolve(here, "../src");
const BARREL = resolve(SRC, "db/index.ts");
const CORE_BARREL = resolve(SRC, "internal/core/index.ts");

/** The only two directories the portable entry is allowed to reach into. */
const ALLOWED = ["packages/ramose/src/db/", "packages/ramose/src/internal/core/"];

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
  // Everything we own is now one package, so every internal edge is relative.
  // A bare specifier is by definition someone else's code and is reported
  // rather than walked: effect/*, alchemy/*, node built-ins.
  if (spec.startsWith(".")) return resolve(dirname(from), spec);
  return undefined;
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

describe("ramose/db is portable", () => {
  const graph = walk(BARREL);
  const blame = (spec: string) =>
    `${spec} (imported by ${relative(repo, graph.bare.get(spec) ?? "?")})`;

  test("no module in the graph imports `alchemy`", () => {
    const engine = [...graph.bare.keys()].filter(
      (spec) => spec === "alchemy" || spec.startsWith("alchemy/"),
    );
    expect(engine.map(blame)).toEqual([]);
  });

  test("no module in the graph reaches the engine barrel", () => {
    expect(graph.files.has(CORE_BARREL)).toBe(false);
  });

  test("the graph is otherwise only `effect` and `src/db` + `src/internal/core`", () => {
    for (const spec of graph.bare.keys()) {
      expect(spec === "effect" || spec.startsWith("effect/")).toBe(true);
    }
    const strays = [...graph.files]
      .map((file) => relative(repo, file))
      .filter((rel) => !ALLOWED.some((dir) => rel.startsWith(dir)));
    expect(strays).toEqual([]);
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
  test("schema, connecting, and the tagged errors — and nothing else", async () => {
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
        // shapes and params
        "all",
        "again",
        "values",
        "params",
        "optional",
        "EidOf",
        // the query language (kernel + pipe surface; issue #149)
        "Q",
        "Query",
        // connecting
        "connect",
        "layer",
        "Databases",
        "token",
        // the database-name rule (issue #37)
        "DATABASE_NAME_RE",
        "isDatabaseName",
        // errors
        "TxRejected",
        "Unavailable",
        "InvalidRequest",
        "DatabaseNotFound",
        "Unauthorized",
        "QueryBudgetExceeded",
        "InternalError",
        "NetworkError",
        // `.oneOrFail()` cardinality — not a DbError (the peer succeeded)
        "NotOne",
        "ParamError",
      ].sort(),
    );
  });
});
