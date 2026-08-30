import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "../../src");
const workerEntry = join(sourceRoot, "worker/index.ts");
const transpiler = new Bun.Transpiler({ loader: "ts" });

const runtimeModuleSpecifiers = (file: string): readonly string[] => {
  return transpiler
    .scanImports(readFileSync(file, "utf8"))
    .filter((entry) => entry.kind === "import-statement")
    .map((entry) => entry.path);
};

const resolveLocal = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const target = normalize(resolve(dirname(from), specifier));
  for (const candidate of [target, `${target}.ts`, join(target, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${from}`);
};

const runtimeGraph = (entry: string): ReadonlySet<string> => {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeModuleSpecifiers(file)) {
      const target = resolveLocal(file, specifier);
      if (target !== undefined && target.startsWith(sourceRoot)) visit(target);
    }
  };
  visit(entry);
  return seen;
};

const relativeGraph = (entry: string): readonly string[] =>
  [...runtimeGraph(entry)].map((file) => relative(sourceRoot, file)).sort();

describe("production package/build graph", () => {
  test("the default Worker cannot reach mutable hooks or test admin routers", () => {
    const graph = relativeGraph(workerEntry);
    expect(graph).not.toContain("internal/test-hooks.ts");
    expect(graph).not.toContain("internal/replica/replica-do-testing.ts");
    expect(graph).not.toContain("worker/test-admin.ts");
    expect(graph).not.toContain("worker/storage-test-admin.ts");
    expect(graph).not.toContain("worker/testing.ts");
  });

  test("the built production Worker contains no test assembly or hook symbols", () => {
    const outdir = mkdtempSync(join(tmpdir(), "ramose-production-worker-"));
    try {
      const built = Bun.spawnSync([
        process.execPath,
        "build",
        workerEntry,
        "--target",
        "browser",
        "--external",
        "cloudflare:workers",
        "--outdir",
        outdir,
      ]);
      expect(built.exitCode).toBe(0);
      const bundle = readFileSync(join(outdir, "index.js"), "utf8");
      for (const forbidden of [
        "/__test__/",
        "RAMOSE_TEST_HOOKS",
        "RAMOSE_TEST_CAPABILITY",
        "testRuntimeBoundaries",
        "handleTestAdmin",
        "armCheckpoint",
        "checkpointStatus",
        "TEST_SESSION_TOKEN_HEADER",
        "/admin/test/",
        "x-ramose-r2-gets",
        "x-ramose-cache-hits",
        "clearBasisCache",
        "clearSegmentSources",
      ]) {
        expect(bundle).not.toContain(forbidden);
      }
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});
