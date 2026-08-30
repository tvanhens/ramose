
import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../../src/client/client.ts";
import "../../src/Catalog.ts";
import "../../src/Policy.ts";

const here = dirname(fileURLToPath(import.meta.url));

const bundled = async (...entrypoints: readonly string[]): Promise<string> => {
  const built = await Bun.build({
    entrypoints: entrypoints.map((entry) => resolve(here, entry)),
    target: "browser",
    external: ["effect", "effect/*", "react"],
  });
  expect(built.success).toBe(true);
  return (await Promise.all(built.outputs.map((output) => output.text()))).join("\n");
};

const DEPLOY_ONLY = ["alchemy", "cloudflare:workers", "jose", "better-auth"];

describe("the ramose/client bundle", () => {
  test("carries no deploy engine", async () => {
    const client = await bundled("../../src/client/client.ts");
    expect(client.length).toBeGreaterThan(200_000);
    for (const excluded of DEPLOY_ONLY) expect(client).not.toContain(excluded);
  });

  test("still carries none when the application also authors its catalog", async () => {
    const application = await bundled(
      "../../src/client/client.ts",
      "../../src/Catalog.ts",
      "../../src/Policy.ts",
    );
    expect(application.length).toBeGreaterThan(200_000);
    for (const excluded of DEPLOY_ONLY) expect(application).not.toContain(excluded);
  });
});
