#!/usr/bin/env bun
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT = join(
  HERE,
  "../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2",
);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4177),
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(HERE, "index.html")));
    }
    if (url.pathname === "/film.js") {
      return new Response(Bun.file(join(HERE, "film.js")), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    if (url.pathname === "/manrope-latin.woff2") {
      return new Response(Bun.file(FONT), {
        headers: { "content-type": "font/woff2" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`film preview  http://127.0.0.1:${server.port}/`);
