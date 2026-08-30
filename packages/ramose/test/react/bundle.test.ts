/**
 * `ramose/react` is a browser package (#479 slice 1).
 *
 * Two builds, because one would not be honest on its own.
 *
 * `src/react/index.ts` is not usable as the subject: it is pure re-exports, so
 * a bundler collapses it to a stub (82 bytes here) and every byte examined
 * would come from whatever else was built alongside it — an `alchemy` import
 * added to the adapter would pass unnoticed. `hooks.ts` is the module that
 * actually carries the adapter's graph, so that is what the adapter's own
 * assertion is made against.
 *
 * And the adapter alone is not the whole claim either: an application that
 * renders with Ramose bundles `ramose/client` too, and the hooks reach the
 * client's runtime through the handle they are passed rather than by importing
 * it. So the pair is built as well, at the size an application really ships.
 */

import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Loaded, not merely bundled: `Bun.build` resolves this graph's explicit `.ts`
// import extensions only once the test process has imported it, so bundling it
// from a module that never did reports resolution errors that have nothing to
// do with what is being asserted.
import "../../src/react/hooks.ts";
import "../../src/client/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Everything one browser build emits, as one string. */
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
    // Real graph rather than a collapsed re-export stub, so the assertion below
    // is about what the adapter reaches. The floor is deliberately far under
    // what it measures: how much of the client survives tree-shaking through
    // the hooks varies by bundler version, and none of that is the subject.
    expect(adapter.length).toBeGreaterThan(20_000);
    // Alchemy, the peer Worker, and the Cloudflare bindings must not be
    // reachable from `ramose/react`.
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
