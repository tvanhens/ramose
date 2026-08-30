import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * Serve a *recorded replication frame fixture* over the real network path.
 *
 * The subject of the browser lane is the client: the real `ReplicationSession`,
 * the real NDJSON decoder, real IndexedDB, and the real observation fence. The
 * existing suites already feed literal `ReplicationFrame` values to that real
 * storage; this delivers the identical fixture bytes through the real
 * `fetch` + streaming-decode path instead, which is what lets one test prove
 * the whole session → hook → durable-fence join rather than only its types.
 *
 * It is deliberately not a peer. There is no protocol state machine, no
 * request parsing, no per-call scripting and no conditional behavior: one
 * committed file is streamed verbatim, chosen by the database name already in
 * the URL, exactly as an ordinary static file server would. Nothing here can
 * invent a successful transact, query, or frame that is not committed in
 * `test/browser/frames/`.
 */
const replicationFrameFixtures = (root: string): Plugin => ({
  name: "ramose-replication-frame-fixtures",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = (request.url ?? "").split("?", 1)[0] ?? "";
      const match = /^\/db\/([^/]+)\/replicate$/.exec(path);
      if (match === null) return next();
      const file = join(root, "test/browser/frames", `${decodeURIComponent(match[1]!)}.ndjson`);
      if (!existsSync(file)) return next();
      response.statusCode = 200;
      response.setHeader("content-type", "application/x-ndjson");
      response.setHeader("cache-control", "no-store");
      createReadStream(file).pipe(response);
    });
  },
});

export default defineConfig({
  optimizeDeps: {
    include: ["effect/Data", "effect/Result", "effect/Schema"],
  },
  plugins: [replicationFrameFixtures(import.meta.dirname)],
  test: {
    include: ["test/browser/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
