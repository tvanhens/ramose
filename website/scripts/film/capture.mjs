#!/usr/bin/env bun
// Render How a query is made to H.264 via headed-less Chrome + ffmpeg.
//
//   bun website/scripts/film/capture.mjs
//   bun website/scripts/film/capture.mjs --preview   # 8 keyframes only
//
// Needs system Chrome and ffmpeg. Output: website/scripts/film/out/

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CHROME = process.env.CHROME ?? "google-chrome";
const FPS = 24;
const PREVIEW = process.argv.includes("--preview");
const PORT = 4188;
const DEBUG = 9224;

const FONT = join(
  HERE,
  "../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2",
);

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = Bun.serve({
  port: PORT,
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

mkdirSync(OUT, { recursive: true });
const profile = join(OUT, `.chrome-${process.pid}`);
mkdirSync(profile, { recursive: true });

const chrome = spawn(
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
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${DEBUG}`,
    `--user-data-dir=${profile}`,
    "--window-size=1920,1080",
    `http://127.0.0.1:${PORT}/?record=1`,
  ],
  { stdio: "ignore" },
);

const waitJson = async (url, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // chrome still booting
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${url}`);
};

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }
}

const targets = await waitJson(`http://127.0.0.1:${DEBUG}/json/list`);
const page = targets.find((t) => t.type === "page") ?? targets[0];
if (!page?.webSocketDebuggerUrl) throw new Error("no chrome page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
const cdp = new Cdp(ws);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

const waitReady = async () => {
  for (let i = 0; i < 80; i++) {
    const res = await cdp.send("Runtime.evaluate", {
      expression: "window.filmReady === true",
      returnByValue: true,
    });
    if (res.result?.value === true) return;
    await sleep(100);
  }
  throw new Error("film did not become ready");
};
await waitReady();

const durationRes = await cdp.send("Runtime.evaluate", {
  expression: "Film.duration",
  returnByValue: true,
});
const duration = durationRes.result.value;
const frames = PREVIEW
  ? [0.8, 4.6, 7.8, 11.4, 16.4, 20.8, 24.2, 29.2, 34.2]
  : Array.from({ length: Math.round(duration * FPS) + 1 }, (_, i) => i / FPS);

console.log(
  PREVIEW
    ? `capturing ${frames.length} preview stills`
    : `capturing ${frames.length} frames @ ${FPS}fps (${duration}s)`,
);

const grab = async (time) => {
  await cdp.send("Runtime.evaluate", {
    expression: `Film.seek(${time})`,
    returnByValue: true,
  });
  const shot = await cdp.send("Runtime.evaluate", {
    expression: "Film.frameJPEG(0.93)",
    returnByValue: true,
  });
  const dataUrl = shot.result.value;
  return Buffer.from(dataUrl.split(",")[1], "base64");
};

if (PREVIEW) {
  for (const time of frames) {
    const buf = await grab(time);
    const name = `frame-${String(time).replace(".", "p")}.jpg`;
    writeFileSync(join(OUT, name), buf);
    console.log(`→ ${name}`);
  }
} else {
  const dest = join(OUT, "how-a-query-is-made.mp4");
  const ff = spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-framerate",
      String(FPS),
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "16",
      "-preset",
      "medium",
      "-movflags",
      "+faststart",
      dest,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  let n = 0;
  for (const time of frames) {
    const buf = await grab(time);
    if (!ff.stdin.write(buf)) {
      await new Promise((r) => ff.stdin.once("drain", r));
    }
    n++;
    if (n % 24 === 0) console.log(`   ${n}/${frames.length}`);
  }
  ff.stdin.end();
  await new Promise((resolve, reject) => {
    ff.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
    );
  });
  console.log(`wrote ${dest}`);
}

ws.close();
chrome.kill("SIGTERM");
await sleep(200);
if (chrome.exitCode === null) chrome.kill("SIGKILL");
await run("rm", ["-rf", profile]);
server.stop();
console.log("done");
