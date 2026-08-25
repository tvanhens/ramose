#!/usr/bin/env bun
// Capture the live-query Twitter cards at 2×.
//
//   bun website/scripts/social/capture.mjs
//   bun website/scripts/social/capture.mjs twitter
//
// Needs system Chrome (`google-chrome`). Output lands in website/public/social/.

import { spawn } from "node:child_process";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../../public/social");
const FONT = join(
  HERE,
  "../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2",
);
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

const ALL = [
  { id: "twitter", file: "live-queries-twitter.png", w: 1600, h: 900 },
  { id: "card", file: "live-queries-card.png", w: 1080, h: 1350 },
];
const only = process.argv.slice(2);
const SHOTS = only.length
  ? ALL.filter((s) => only.includes(s.id) || only.includes(s.file))
  : ALL;
if (!SHOTS.length) {
  console.error(`unknown shot: ${only.join(" ")}`);
  process.exit(1);
}

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

const screenshot = async (url, dest, w, h) => {
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
      `--window-size=${w},${h}`,
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

const html = Bun.file(join(HERE, "live-queries.html"));
const font = Bun.file(FONT);
if (!(await font.exists())) {
  console.error(`Manrope woff2 missing at ${FONT}`);
  process.exit(1);
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/live-queries.html") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/fonts/manrope-latin.woff2") {
      return new Response(font, { headers: { "content-type": "font/woff2" } });
    }
    return new Response("not found", { status: 404 });
  },
});

const base = `http://127.0.0.1:${server.port}/live-queries.html`;
console.log(`serving social cards at ${base}`);

for (const shot of SHOTS) {
  const raw = join(OUT, `.raw-${shot.file}`);
  const dest = join(OUT, shot.file);
  const url = `${base}?shot=${shot.id}`;
  console.log(`→ ${shot.file}  ${shot.w}×${shot.h} @2x`);
  await screenshot(url, raw, shot.w, shot.h);
  const img = sharp(raw);
  const meta = await img.metadata();
  const targetW = shot.w * 2;
  const targetH = shot.h * 2;
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
}

server.stop();
console.log("done");
