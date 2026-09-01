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
      if (match[1] === "refuses-credentials") {
        response.statusCode = 401;
        response.end();
        return;
      }
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

const exampleStack = (): Plugin => {
  const held = new Map<string, Set<AbortController>>();

  const hold = (subject: string, connection: AbortController): (() => void) => {
    const open = held.get(subject) ?? new Set<AbortController>();
    open.add(connection);
    held.set(subject, open);
    return () => {
      open.delete(connection);
      if (open.size === 0) held.delete(subject);
    };
  };

  const cut = (subject: string): void => {
    for (const connection of held.get(subject) ?? []) connection.abort();
    held.delete(subject);
  };

  const forward = async (
    request: IncomingMessage,
    response: ServerResponse,
    target: string,
    subject: string,
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
    const connection = new AbortController();
    const release = hold(subject, connection);
    try {
      const answered = await fetch(target, {
        method: request.method ?? "GET",
        headers,
        signal: connection.signal,
        ...(body === undefined || body.length === 0
          ? {}
          : { body: new Uint8Array(body) }),
      });
      response.statusCode = answered.status;
      const type = answered.headers.get("content-type");
      if (type !== null) response.setHeader("content-type", type);
      response.setHeader("cache-control", "no-store");
      if (answered.body !== null) {
        for await (const chunk of answered.body) {
          if (response.writableEnded) break;
          response.write(chunk);
        }
      }
    } catch {
      response.destroy();
    } finally {
      release();
      if (!response.writableEnded && !response.destroyed) response.end();
    }
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
          if (query.get("offline") === "1") {
            partitioned.add(subject);
            cut(subject);
          } else {
            partitioned.delete(subject);
          }
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
        const subject = bearerSubject(request);
        if (partitioned.has(subject)) {
          request.destroy();
          response.destroy();
          return;
        }
        forward(request, response, target, subject).catch(next);
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
