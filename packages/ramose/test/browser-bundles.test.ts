import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test.each([
  ["db", ["Schema", "Entity", "string"]],
  ["client", ["createClient"]],
  ["better-auth/client", ["createAuthProvider"]],
  ["react", ["RamoseProvider", "useQuery", "useReceipt"]],
] as const)("the %s browser bundle has usable exports", async (entry, names) => {
  const directory = mkdtempSync(join(tmpdir(), "ramose-browser-bundle-"));
  try {
    const output = join(directory, "index.mjs");
    const built = Bun.spawnSync([
      process.execPath, "build", resolve(import.meta.dir, `../src/${entry.includes("/") ? entry : `${entry}/index`}.ts`),
      "--target", "browser", "--outfile", output,
    ]);
    expect(built.exitCode).toBe(0);
    const bundled = await import(pathToFileURL(output).href);
    for (const name of names) expect(typeof bundled[name]).toBe("function");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
