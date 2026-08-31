import type { BunRequest } from "bun";
import index from "./index.html";
import { DEV_API_PORT, DEV_PEER_PORT } from "./src/domain/shared.ts";

const proxy = (port: number) => (request: BunRequest): Promise<Response> => {
  const url = new URL(request.url);
  url.protocol = "http:";
  url.hostname = "localhost";
  url.port = String(port);
  return fetch(new Request(url, request));
};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 5173),
  idleTimeout: 0,
  development: { hmr: true },
  routes: {
    "/api/*": proxy(DEV_API_PORT),
    "/db/*": proxy(DEV_PEER_PORT),
    "/*": index,
  },
});

console.log(`reef ui: ${server.url}`);
