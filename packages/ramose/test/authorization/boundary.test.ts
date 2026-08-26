import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const SRC = resolve(here, "../../src");
const RUNTIME = resolve(SRC, "internal/authorization/index.ts");
const AUTHORING = resolve(SRC, "authorization");
const BROWSER = resolve(SRC, "browser.ts");

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

const walk = (entry: string): Set<string> => {
  const files = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!existsSync(file)) continue;
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      queue.push(resolve(dirname(file), spec));
    }
  }
  return files;
};

describe("module boundaries", () => {
  test("runtime kernel does not import authoring modules", () => {
    const files = [...walk(RUNTIME)].map((file) => relative(repo, file));
    expect(files.some((file) => file.startsWith("packages/ramose/src/authorization/"))).toBe(
      false,
    );
    expect(files.some((file) => file.includes("src/authorization/"))).toBe(false);
  });

  test("browser exports do not include compiler, parser, or installer", () => {
    const files = [...walk(BROWSER)].map((file) => relative(repo, file));
    expect(files.some((file) => file.startsWith("packages/ramose/src/authorization/"))).toBe(
      false,
    );
    const browser = readFileSync(BROWSER, "utf8");
    expect(browser).not.toContain("authorization/index");
    expect(browser).not.toContain("compileAuthoring");
    expect(browser).not.toContain("bindAuthorization");
  });

  test("authoring exists as a deploy-time module", () => {
    expect(existsSync(resolve(AUTHORING, "index.ts"))).toBe(true);
    expect(existsSync(resolve(AUTHORING, "compile.ts"))).toBe(true);
    expect(existsSync(resolve(AUTHORING, "bind.ts"))).toBe(true);
  });
});
