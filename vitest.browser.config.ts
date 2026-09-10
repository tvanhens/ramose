import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type Plugin } from "vitest/config";

const HELD_SUFFIX = "-held";

const replicationFrameFixtures = (root: string): Plugin => ({
  name: "ramose-replication-frame-fixtures",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = (request.url ?? "").split("?", 1)[0] ?? "";

      const match = /^\/db\/([A-Za-z0-9_-]+)\/replicate$/.exec(path);
      if (match === null) return next();
      if (match[1] === "refuses-credentials") {
        response.statusCode = 401;
        response.end();
        return;
      }
      const held = match[1]!.endsWith(HELD_SUFFIX);
      const recording = held
        ? match[1]!.slice(0, -HELD_SUFFIX.length)
        : match[1]!;
      const file = join(root, "test/browser/frames", `${recording}.ndjson`);
      const replays = existsSync(file);
      if (!replays && !held) return next();
      response.statusCode = 200;
      response.setHeader("content-type", "application/x-ndjson");
      response.setHeader("cache-control", "no-store");
      if (!held) {
        createReadStream(file).pipe(response);
        return;
      }
      request.on("close", () => response.destroy());
      if (replays) createReadStream(file).pipe(response, { end: false });
    });
  },
});

export default defineConfig({
  optimizeDeps: {
    include: ["effect/Data", "effect/Result", "effect/Schema", "react", "react-dom/client"],
  },
  plugins: [
    replicationFrameFixtures(import.meta.dirname),
  ],
  test: {
    include: ["test/browser/**/*.browser.test.{ts,tsx}"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
