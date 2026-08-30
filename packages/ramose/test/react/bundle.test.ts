/**
 * `ramose/react` is a browser package (#479 slice 1).
 *
 * The adapter pulls the client's whole graph — the catalog install, the
 * replication session, the storage, the query engine. None of that may drag
 * the deploy engine or the peer Worker into an application's bundle.
 */

import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Loaded, not merely bundled: `Bun.build` resolves this graph's explicit `.ts`
// import extensions only once the test process has imported it, so bundling it
// from a module that never did reports resolution errors that have nothing to
// do with what is being asserted.
import "../../src/react/hooks.ts";

describe("the ramose/react bundle", () => {
  test("bundles for browsers without the deploy engine", async () => {
    // `hooks.ts`, not the barrel: the barrel is re-exports, and bundling it
    // emits a stub that would pass with the deploy engine one import away.
    // This is the module that pulls the adapter's whole graph — the client,
    // the replication session, the storage, the query engine.
    const built = await Bun.build({
      entrypoints: [
        resolve(dirname(fileURLToPath(import.meta.url)), "../../src/react/hooks.ts"),
      ],
      target: "browser",
      external: ["effect", "effect/*", "react"],
    });
    expect(built.success).toBe(true);
    const bundle = await built.outputs[0]!.text();
    // Proof that the graph is really in here, so the assertion below is about
    // what the bundle contains rather than about how little of it was built.
    expect(bundle.length).toBeGreaterThan(200_000);
    // The adapter is a browser package: Alchemy, the peer Worker, and the
    // Cloudflare bindings must not be reachable from it.
    expect(bundle).not.toContain("alchemy");
  });
});
