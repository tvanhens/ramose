#!/usr/bin/env bun
/**
 * Set the version on the workspace root and the published package, then commit
 * that change with a standard message.
 *
 * The root is private and never ships, but it carries the version the release
 * notes read, so the two must never drift — scripts/check-release.ts fails the
 * release if they do. This is the supported way to move them.
 *
 *   bun run release:version 0.2.0
 *   git tag v0.2.0 && git push origin HEAD --tags
 *
 * Only those two manifests are staged, by path. A blanket `git commit -a` would
 * sweep up whatever else happens to be in the working tree, and a release
 * commit should contain the version bump and nothing else.
 *
 * Tagging stays manual on purpose. The two release paths want it at different
 * moments: publishing from CI means the tag is the trigger and comes before
 * the publish, while publishing locally means the tag marks a release that has
 * already happened. Deciding that here would be wrong half the time.
 *
 * Flags:
 *   --no-commit   edit the manifests and stop, leaving the change unstaged
 */

import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const noCommit = argv.includes("--no-commit");
const version = argv.find((arg) => !arg.startsWith("--"));

if (!version) {
  console.error("usage: bun run release:version <version> [--no-commit]");
  process.exit(1);
}

// Semver, optionally with a prerelease tag (0.2.0-alpha.1) — a leading "v" is a
// common slip and produces a version npm will reject, so catch it here.
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

// Inherited stdio: a commit can still need the terminal — a GPG or SSH signing
// key with a passphrase prompts here, and a piped stdio would fail silently.
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
