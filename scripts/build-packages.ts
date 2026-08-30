#!/usr/bin/env bun

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

await copyFile("LICENSE", `${PACKAGE}/LICENSE`);
await copyFile("NOTICE", `${PACKAGE}/NOTICE`);
console.log("staged LICENSE and NOTICE");
