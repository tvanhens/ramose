import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const barrel = resolve(here, "../src/db/index.ts");

describe("ramose/db authoring surface", () => {
  test("bundles for browsers without deploy or transport dependencies", () => {
    const built = Bun.spawnSync([
      process.execPath, "build", barrel, "--target", "browser",
      "--external", "effect", "--external", "effect/*",
    ]);
    expect(built.exitCode).toBe(0);
    const bundle = new TextDecoder().decode(built.stdout);
    expect(bundle).not.toContain("alchemy");
    expect(bundle).not.toContain("WebSocket");
    expect(bundle).not.toContain("fetch(");
  });

  test("exports authoring definitions, not an online database client", async () => {
    const db = await import("../src/db/index.ts");
    for (const name of ["Schema", "Field", "Entity", "Trait", "Query", "enumeration", "ref"]) expect(name in db).toBe(true);
    for (const name of ["q", "enrich", "refine", "encodeCursor", "decodeCursor"]) expect(name in db.Query).toBe(false);
    for (const name of ["Operation", "Operations", "OwnedOperations", "Q", "Enum", "Ref", "tempid", "connect", "Db", "token", "openOverlay", "Subscription", "PrefixHalt"]) expect(name in db).toBe(false);
  });
});
