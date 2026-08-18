/**
 * `main` is a path, and this is the test that says so.
 *
 * Every doc-comment and every docs page told a standalone app to write
 * `Cloudflare.Worker("Peer", { main: "@ramose/worker" })`. Alchemy does not
 * resolve `main` as a module specifier — it runs it through `fileURLToPath`
 * (when it is a `file://` URL) and then `realpath`, so a bare package name
 * resolves against the working directory and does not exist. Nothing in this
 * repository noticed: every runnable stack points `main` at
 * `./packages/worker/src/index.ts`.
 *
 * The failure was invisible rather than loud. Alchemy's bundle watcher runs in
 * a forked fiber, so under `alchemy dev` the peer's proxy still bound its port
 * and logged `[Peer] ready`; the bundle error was swallowed, no `Started in`
 * line ever followed, and every request to that port hung — including the one
 * `Ramose.Database` makes to install the catalog, which sat in `creating`
 * until the run was torn down and printed a bare `[todos] fail`.
 *
 * So the assertion below is deliberately not "the string looks right": it is
 * Alchemy's own resolution, applied to the value we hand a reader for `main`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { workerEntry } from "../src/workerEntry.ts";

/**
 * `alchemy/src/Bundle/TempRoot.ts#resolveMainPath`, verbatim in shape: try
 * `fileURLToPath`, fall back to the string itself, then `realpath` it.
 */
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
    // …and the module it names is the peer Worker: default export plus the two
    // Durable Object classes the stack binds by name.
    expect(real).toContain("worker");
  });

  test("the bare package name does NOT — this is the bug the helper exists for", () => {
    // The old documented spelling. `realpath("@ramose/worker")` is
    // `<cwd>/@ramose/worker`, which is nothing, so Alchemy's bundler never
    // gets an entry. Kept as a test so the docs can never drift back to it
    // without something going red.
    expect(() => resolveMainPath("@ramose/worker")).toThrow();
  });

  test("what it names really is the peer Worker", () => {
    // Not `import()`: the module reaches `cloudflare:workers`, which only
    // exists inside workerd. The three names the stack binds are visible in
    // the source, and their absence is what a wrong entry would look like.
    const source = readFileSync(resolveMainPath(workerEntry()), "utf8");
    expect(source).toContain("TransactorDO");
    expect(source).toContain("QueryReplicaDO");
    expect(source).toMatch(/export default/);
  });
});
