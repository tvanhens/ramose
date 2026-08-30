import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "../../src/react/hooks.ts";
import "../../src/client/index.ts";

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

describe("the ramose/react bundle", () => {
  test("carries no deploy engine into the adapter", async () => {
    const adapter = await bundled("../../src/react/hooks.ts");

    expect(adapter.length).toBeGreaterThan(20_000);

    expect(adapter).not.toContain("alchemy");
  });

  test("carries no deploy engine into an application that renders with Ramose", async () => {
    const application = await bundled(
      "../../src/react/hooks.ts",
      "../../src/client/client.ts",
    );
    expect(application.length).toBeGreaterThan(200_000);
    expect(application).not.toContain("alchemy");
  });
});
