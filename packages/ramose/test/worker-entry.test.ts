import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { workerEntry } from "../src/workerEntry.ts";

const resolveMainPath = (main: string): string => {
  let asPath: string;
  try {
    asPath = fileURLToPath(main);
  } catch {
    asPath = main;
  }
  return realpathSync(asPath);
};

describe("the entry a standalone app passes as `main`", () => {
  test("resolves the way Alchemy resolves `main` — to a file that exists", () => {
    const entry = workerEntry();
    const real = resolveMainPath(entry);
    expect(real).toMatch(/index\.(ts|js)$/);

    expect(real).toContain("worker");
  });

  test("the bare specifier does NOT — this is the bug the helper exists for", () => {

    expect(() => resolveMainPath("ramose/worker")).toThrow();
  });

  test("what it names really is the peer Worker", () => {

    const source = readFileSync(resolveMainPath(workerEntry()), "utf8");
    expect(source).toContain("TransactorDO");
    expect(source).toContain("QueryReplicaDO");
    expect(source).toMatch(/export default/);
  });
});
