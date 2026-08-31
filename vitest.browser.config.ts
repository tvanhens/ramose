import { createReadStream, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type Plugin } from "vitest/config";
import {
  EXAMPLE_ROOT,
  PARTITION_PATH,
  TOKEN_PATH,
} from "./test/browser/example-stack.ts";
import { IDENTITY_ORIGIN, PEER_ORIGIN } from "./test/browser/stack.ts";

const replicationFrameFixtures = (root: string): Plugin => ({
  name: "ramose-replication-frame-fixtures",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = (request.url ?? "").split("?", 1)[0] ?? "";

      const match = /^\/db\/([A-Za-z0-9_-]+)\/replicate$/.exec(path);
      if (match === null) return next();
      // The status an expired bearer is answered with, so the browser lane can
      // reach the client's own refusal path over a real response.
      if (match[1] === "refuses-credentials") {
        response.statusCode = 401;
        response.end();
        return;
      }
      // The same status for graph paths only, which leaves a root activation
      // to fail as an unreachable one and its restored value on screen.
      if (match[1] === "refuses-children") {
        const body: Buffer[] = [];
        request.on("data", (chunk: Buffer) => body.push(chunk));
        request.on("end", () => {
          let path: unknown;
          try {
            path = (JSON.parse(Buffer.concat(body).toString()) as {
              readonly graphPath?: unknown;
            }).graphPath;
          } catch {
            path = undefined;
          }
          response.statusCode = Array.isArray(path) && path.length > 0 ? 401 : 404;
          response.end();
        });
        return;
      }
      const file = join(root, "test/browser/frames", `${match[1]!}.ndjson`);
      if (!existsSync(file)) return next();
      response.statusCode = 200;
      response.setHeader("content-type", "application/x-ndjson");
      response.setHeader("cache-control", "no-store");
      createReadStream(file).pipe(response);
    });
  },
});

/**
 * Which principal a forwarded request carries, read from the bearer's own
 * unverified payload. The peer still verifies it; this only says whose wire a
 * partition test asked to cut.
 */
const bearerSubject = (request: IncomingMessage): string => {
  const header = request.headers.authorization;
  const payload = header?.slice("Bearer ".length).split(".")[1];
  if (payload === undefined) return "";
  try {
    return String(
      (JSON.parse(Buffer.from(payload, "base64url").toString()) as {
        readonly sub?: unknown;
      }).sub ?? "",
    );
  } catch {
    return "";
  }
};

/**
 * Bring the `examples/graph` stack up, and give the browser a same-origin path
 * to it.
 *
 * The example owns a real peer Worker, a real Transactor, a real R2 store and
 * the identity Worker that mints its bearers. This lane runs the example's own
 * client against the example's own stack: requests are forwarded verbatim, so
 * what the browser sends is what a deployed peer answers.
 */
const exampleStack = (): Plugin => {
  const forward = async (
    request: IncomingMessage,
    response: ServerResponse,
    target: string,
  ): Promise<void> => {
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks)));
        request.on("error", reject);
      });
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || name === "host" || name === "origin") continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const answered = await fetch(target, {
      method: request.method ?? "GET",
      headers,
      ...(body === undefined || body.length === 0
        ? {}
        : { body: new Uint8Array(body) }),
    });
    response.statusCode = answered.status;
    const type = answered.headers.get("content-type");
    if (type !== null) response.setHeader("content-type", type);
    response.setHeader("cache-control", "no-store");
    if (answered.body === null) {
      response.end();
      return;
    }
    try {
      for await (const chunk of answered.body) {
        if (response.writableEnded) break;
        response.write(chunk);
      }
    } catch {
      // A client that closed a long-lived replication stream aborts the read.
    }
    if (!response.writableEnded) response.end();
  };

  const partitioned = new Set<string>();

  return {
    name: "ramose-example-stack",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "";
        const path = url.split("?", 1)[0] ?? "";
        if (path === PARTITION_PATH) {
          const query = new URLSearchParams(url.slice(path.length + 1));
          const subject = query.get("sub") ?? "";
          if (query.get("offline") === "1") partitioned.add(subject);
          else partitioned.delete(subject);
          response.statusCode = 204;
          response.end();
          return;
        }
        const target = path === TOKEN_PATH
          ? `${IDENTITY_ORIGIN}/token${url.slice(path.length)}`
          : path.startsWith(`/db/${EXAMPLE_ROOT}/`)
          ? `${PEER_ORIGIN}${url}`
          : undefined;
        if (target === undefined) return next();
        if (partitioned.size > 0 && partitioned.has(bearerSubject(request))) {
          request.destroy();
          response.destroy();
          return;
        }
        forward(request, response, target).catch(next);
      });
    },
  };
};

export default defineConfig({
  optimizeDeps: {
    include: ["effect/Data", "effect/Result", "effect/Schema", "react", "react-dom/client"],
  },
  plugins: [
    replicationFrameFixtures(import.meta.dirname),
    exampleStack(),
  ],
  test: {
    globalSetup: ["./test/browser/global-setup.ts"],
    include: ["test/browser/**/*.browser.test.{ts,tsx}"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
