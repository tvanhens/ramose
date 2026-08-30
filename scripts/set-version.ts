#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const noCommit = argv.includes("--no-commit");
const version = argv.find((arg) => !arg.startsWith("--"));

if (!version) {
  console.error("usage: bun run release:version <version> [--no-commit]");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`invalid version: ${version} (expected e.g. 0.2.0 or 0.2.0-alpha.1, with no leading "v")`);
  process.exit(1);
}

const manifests = ["package.json", "packages/ramose/package.json"];

let changed = 0;
for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { version: string };
  if (manifest.version === version) continue;
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  changed++;
}

if (changed === 0) {
  console.log(`all ${manifests.length} manifests are already at ${version} — nothing to do`);
  process.exit(0);
}

console.log(`set ${changed} of ${manifests.length} manifests to ${version}`);

if (noCommit) {
  console.log("\n--no-commit: the change is in your working tree, uncommitted");
  process.exit(0);
}

const message = `release: v${version}`;
const add = Bun.spawn({
  cmd: ["git", "add", "--", ...manifests],
  stdio: ["inherit", "inherit", "inherit"],
});
if ((await add.exited) !== 0) {
  console.error("\nfailed to stage the manifests; they are edited but uncommitted");
  process.exit(1);
}

const commit = Bun.spawn({
  cmd: ["git", "commit", "-m", message],
  stdio: ["inherit", "inherit", "inherit"],
});
if ((await commit.exited) !== 0) {
  console.error("\nfailed to commit; the manifests are staged and ready to commit by hand");
  process.exit(1);
}

console.log(`\ncommitted "${message}"`);
console.log(`\nnext:\n  git tag v${version} && git push origin HEAD --tags`);
