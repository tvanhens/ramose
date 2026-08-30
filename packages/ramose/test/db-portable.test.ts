import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const barrel = resolve(here, "../src/db/index.ts");

describe("ramose/db authoring surface", () => {
  test("bundles for browsers without deploy or transport dependencies", async () => {
    const built = await Bun.build({ entrypoints: [barrel], target: "browser", external: ["effect", "effect/*"] });
    expect(built.success).toBe(true);
    const bundle = await built.outputs[0]!.text();
    expect(bundle).not.toContain("alchemy");
    expect(bundle).not.toContain("WebSocket");
    expect(bundle).not.toContain("fetch(");
  });

  test("exports authoring definitions, not an online database client", async () => {
    const db = await import("../src/db/index.ts");
    for (const name of ["Schema", "Field", "Entity", "Trait", "Graph", "Query", "Operation", "tempid"]) expect(name in db).toBe(true);
    for (const name of ["connect", "Db", "token", "openOverlay", "Subscription", "PrefixHalt"]) expect(name in db).toBe(false);
  });
});
