/**
 * `ramose/react` is a browser package (#479 slice 1).
 *
 * An application that renders with Ramose bundles both entries: `ramose/client`
 * to construct the client, `ramose/react` to read it. That pair is what has to
 * stay free of the deploy engine and the peer Worker, so it is what is built
 * here — bundling the adapter alone would understate the graph, because the
 * hooks reach the client's runtime through the handle the application passes
 * them rather than by importing it.
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

describe("the ramose/react bundle", () => {
  test("bundles for browsers without the deploy engine", async () => {
    const built = await Bun.build({
      entrypoints: [
        resolve(here, "../../src/react/index.ts"),
        resolve(here, "../../src/client/client.ts"),
      ],
      target: "browser",
      external: ["effect", "effect/*", "react"],
    });
    expect(built.success).toBe(true);
    const bundle = (await Promise.all(built.outputs.map((output) => output.text())))
      .join("\n");
    // Proof that the graph is really in here, so the assertion below is about
    // what the bundle contains rather than about how little of it was built.
    expect(bundle.length).toBeGreaterThan(200_000);
    // Alchemy, the peer Worker, and the Cloudflare bindings must not be
    // reachable from anything an application renders with.
    expect(bundle).not.toContain("alchemy");
  });
});
