#!/usr/bin/env bun
/**
 * Build the publishable package into `packages/ramose/dist`, then stage the
 * files npm needs alongside it (LICENSE, NOTICE, README.md).
 *
 * There is one package and therefore no build order: `tsc` compiles the whole
 * `src` tree — the four public entries, the `ramose/worker` script and the
 * engine under `src/internal/` — in a single pass.
 *
 * The staged LICENSE/NOTICE are generated artifacts — gitignored and rewritten
 * on every build, so the root LICENSE stays the single source of truth. The
 * README is written by hand and left alone: it is the package's npm landing
 * page.
 *
 * `--clean` also wipes `dist`, which is what CI does so a stale artifact can
 * never end up in a tarball.
 */

import { copyFile, rm } from "node:fs/promises";
import { $ } from "bun";

const PACKAGE = "packages/ramose";

const clean = process.argv.includes("--clean");

if (clean) {
  await rm(`${PACKAGE}/dist`, { recursive: true, force: true });
  console.log(`cleaned ${PACKAGE}/dist`);
}

const started = performance.now();
await $`bunx tsc -p ${PACKAGE}/tsconfig.build.json`;
console.log(`built ramose (${Math.round(performance.now() - started)}ms)`);

// Stage the legal files into the package directory. `files` in the manifest
// lists these, so they have to exist on disk before `npm pack`.
await copyFile("LICENSE", `${PACKAGE}/LICENSE`);
await copyFile("NOTICE", `${PACKAGE}/NOTICE`);
console.log("staged LICENSE and NOTICE");
