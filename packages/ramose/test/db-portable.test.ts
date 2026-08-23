/**
 * Portable entries must not pull the deploy engine.
 *
 * `ramose/db` is the browser entry: no bundler alias, no deploy engine, no
 * dead weight. `ramose/better-auth` (and `/client`) is the mint-plugin pair:
 * an auth Worker that adds the plugin must not bundle Alchemy because a
 * value import of the deploy barrel (`src/index.ts`) re-exports `Server`.
 *
 * Guards, all on the *whole transitive import graph* of each entry:
 *
 *   1. nothing reaches `alchemy` (the deploy engine — `alchemy`,
 *      `alchemy/RuntimeContext`, `alchemy/Binding`, …). Such an import would
 *      force every consumer bundle to carry a bundler alias (or the whole
 *      deploy engine, in a Worker).
 *   2. nothing reaches the engine barrel (`src/internal/core/index.ts`). Deep
 *      imports (`internal/core/json.ts`) are how the codec is taken; the barrel
 *      drags the engine — segment trees, the query planner, the store — into a
 *      browser bundle.
 *   3. every file in the graph is under the entry's allowlist. The server,
 *      the React hooks and the Better Auth plugins are folders in this same
 *      package, so nothing but this assertion stops a stray relative import
 *      from pulling the peer Worker / deploy barrel into a consumer bundle.
 *
 * The walk is static and includes `import type` and JSDoc
 * `{@link import("./X")}`: either is still a coupling this entry is not
 * allowed to have (Auth.ts used to `{@link import("./Server.ts")}`, which
 * pulled the whole deploy engine into `ramose/better-auth`).
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
const BETTER_AUTH = resolve(SRC, "better-auth/index.ts");
const BETTER_AUTH_CLIENT = resolve(SRC, "better-auth/client.ts");
const CORE_BARREL = resolve(SRC, "internal/core/index.ts");
const DEPLOY_BARREL = resolve(SRC, "index.ts");

/** The only two directories the portable `/db` entry is allowed to reach into. */
const ALLOWED = ["packages/ramose/src/db/", "packages/ramose/src/internal/core/"];

/**
 * Mint plugin + client: Auth.ts is the alchemy-free contract; `/db` is
 * already portable; deep `internal/core` is how policy types are taken.
 * The deploy barrel and `Server` / `Database` / … sit next to Auth.ts and
 * are excluded by not listing `src/` itself.
 */
const BETTER_AUTH_ALLOWED = [
  "packages/ramose/src/better-auth/",
  "packages/ramose/src/Auth.ts",
  "packages/ramose/src/db/",
  "packages/ramose/src/internal/core/",
];

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

const alchemyOf = (graph: Graph): string[] =>
  [...graph.bare.keys()].filter(
    (spec) => spec === "alchemy" || spec.startsWith("alchemy/"),
  );

const straysOf = (graph: Graph, allowed: readonly string[]): string[] =>
  [...graph.files]
    .map((file) => relative(repo, file))
    .filter((rel) => !allowed.some((dir) => rel.startsWith(dir)));

const assertPortable = (
  graph: Graph,
  allowed: readonly string[],
  bareOk: (spec: string) => boolean,
) => {
  const blame = (spec: string) =>
    `${spec} (imported by ${relative(repo, graph.bare.get(spec) ?? "?")})`;
  expect(alchemyOf(graph).map(blame)).toEqual([]);
  expect(graph.files.has(CORE_BARREL)).toBe(false);
  expect(graph.files.has(DEPLOY_BARREL)).toBe(false);
  expect(straysOf(graph, allowed)).toEqual([]);
  expect([...graph.bare.keys()].filter((spec) => !bareOk(spec)).map(blame)).toEqual(
    [],
  );
};

const effectBare = (spec: string): boolean =>
  spec === "effect" || spec.startsWith("effect/");

const betterAuthBare = (spec: string): boolean =>
  spec === "better-auth" || spec.startsWith("better-auth/");

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
  test("the Effect hatch is not on the app barrel", async () => {
    const db = await import("../src/db/index.ts");
    const hatch = await import("../src/db/effect.ts");
    expect("layer" in db).toBe(false);
    expect("Databases" in db).toBe(false);
    expect("layer" in hatch).toBe(true);
    expect("Databases" in hatch).toBe(true);
    expect("connect" in hatch).toBe(false);
  });

  test("schema, connecting, and the tagged errors — and nothing else", async () => {
    const db = await import("../src/db/index.ts");
    expect(Object.keys(db).sort()).toEqual(
      [
        // schema
        "Field",
        "Entity",
        "Schema",
        "string",
        "boolean",
        "int",
        "float",
        "timestamp",
        "uuid",
        "bytes",
        "Enum",
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
        "token",
        // the database-name rule (issue #37)
        "DATABASE_NAME_RE",
        "isDatabaseName",
        // operations (issue #160)
        "EntityId",
        "Operation",
        "Operations",
        "PrefixHalt",
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
        "OperationRejected",
        "ParamError",
      ].sort(),
    );
  });
});

describe("ramose/better-auth is portable", () => {
  const graph = walk(BETTER_AUTH);

  test("no module in the graph imports `alchemy` or the deploy barrel", () => {
    assertPortable(
      graph,
      BETTER_AUTH_ALLOWED,
      (spec) => effectBare(spec) || betterAuthBare(spec) || spec === "zod",
    );
  });

  test("the public names are unchanged", async () => {
    const plugin = await import("../src/better-auth/index.ts");
    expect(Object.keys(plugin).sort()).toEqual(
      [
        "classOfRole",
        "ensureDecryptableJwks",
        "orgClassOf",
        "ramoseToken",
      ].sort(),
    );
  });

  test("it bundles without alchemy", async () => {
    const built = await Bun.build({
      entrypoints: [BETTER_AUTH],
      target: "browser",
      external: ["effect", "effect/*", "better-auth", "better-auth/*", "zod"],
    });
    expect(built.logs.filter((l) => l.level === "error")).toEqual([]);
    expect(built.success).toBe(true);
    const bundle = await built.outputs[0]!.text();
    expect(bundle).not.toContain('from "alchemy');
    expect(bundle).not.toContain('require("alchemy');
  });
});

describe("ramose/better-auth/client is portable", () => {
  const graph = walk(BETTER_AUTH_CLIENT);

  test("no module in the graph imports `alchemy` or the deploy barrel", () => {
    assertPortable(
      graph,
      BETTER_AUTH_ALLOWED,
      (spec) => effectBare(spec) || betterAuthBare(spec),
    );
  });

  test("the public names are unchanged", async () => {
    const client = await import("../src/better-auth/client.ts");
    expect(Object.keys(client).sort()).toEqual(["ramoseTokenClient"]);
  });

  test("it bundles for the browser", async () => {
    const built = await Bun.build({
      entrypoints: [BETTER_AUTH_CLIENT],
      target: "browser",
      external: ["effect", "effect/*", "better-auth", "better-auth/*"],
    });
    expect(built.logs.filter((l) => l.level === "error")).toEqual([]);
    expect(built.success).toBe(true);
    const bundle = await built.outputs[0]!.text();
    expect(bundle).not.toContain('from "alchemy');
    expect(bundle).not.toContain('require("alchemy');
  });
});
