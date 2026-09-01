import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type Plugin } from "vitest/config";

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
      const held = /^(.+)-held$/.exec(match[1]!);
      const file = join(root, "test/browser/frames", `${held?.[1] ?? match[1]!}.ndjson`);
      if (!existsSync(file)) return next();
      response.statusCode = 200;
      response.setHeader("content-type", "application/x-ndjson");
      response.setHeader("cache-control", "no-store");
      createReadStream(file).pipe(response, { end: held === null });
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
