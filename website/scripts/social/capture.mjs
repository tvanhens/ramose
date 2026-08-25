#!/usr/bin/env bun
// Capture the live-query Twitter card at 2×.
//
//   bun website/scripts/social/capture.mjs
//
// Needs system Chrome (`google-chrome`). Output lands in website/public/social/.

import { spawn } from "node:child_process";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../../public/social");
const W = 1600;
const H = 900;
const FILE = "live-queries-twitter.png";
const CHROME =
  process.env.CHROME ??
  ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/local/bin/google-chrome"].find(
    (p) => {
      try {
        return Bun.file(p).size > 0;
      } catch {
        return false;
      }
    },
  ) ??
  "google-chrome";

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });

const waitForFile = async (path, timeoutMs = 20_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await Bun.file(path).exists()) {
      const size = Bun.file(path).size;
      if (size > 1000) return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${path}`);
};

const screenshot = async (url, dest) => {
  const profile = join(OUT, `.chrome-${process.pid}-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-extensions",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-features=Translate,PaintHolding",
      "--force-device-scale-factor=2",
      "--virtual-time-budget=4000",
      `--user-data-dir=${profile}`,
      `--window-size=${W},${H}`,
      `--screenshot=${dest}`,
      url,
    ],
    { stdio: "inherit" },
  );
  try {
    await waitForFile(dest);
  } finally {
    child.kill("SIGTERM");
    await Bun.sleep(200);
    if (child.exitCode === null) child.kill("SIGKILL");
    await run("rm", ["-rf", profile]);
  }
};

mkdirSync(OUT, { recursive: true });

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/live-queries.html") {
      return new Response(Bun.file(join(HERE, "live-queries.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const dest = join(OUT, FILE);
const raw = join(OUT, `.raw-${FILE}`);
const page = `http://127.0.0.1:${server.port}/live-queries.html`;
console.log(`→ ${FILE}  ${W}×${H} @2x`);
await screenshot(page, raw);

const img = sharp(raw);
const meta = await img.metadata();
const targetW = W * 2;
const targetH = H * 2;
let pipeline = img;
if ((meta.width ?? 0) > targetW || (meta.height ?? 0) > targetH) {
  pipeline = pipeline.extract({
    left: 0,
    top: 0,
    width: Math.min(targetW, meta.width ?? targetW),
    height: Math.min(targetH, meta.height ?? targetH),
  });
}
await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(dest);
unlinkSync(raw);
const outMeta = await sharp(dest).metadata();
console.log(`   ${outMeta.width}×${outMeta.height}  ${outMeta.channels}-channel`);

server.stop();
console.log("done");
