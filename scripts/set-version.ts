#!/usr/bin/env bun
/**
 * Set the version on the root manifest and all publishable packages at once.
 *
 * The packages release in lockstep, so their versions must never drift —
 * scripts/check-release.ts fails the release if they do. This is the supported
 * way to move them.
 *
 * It only edits manifests. Committing and tagging stay manual, because pushing
 * a tag is what triggers the actual publish:
 *
 *   bun run scripts/set-version.ts 0.2.0
 *   git commit -am "release: v0.2.0"
 *   git tag v0.2.0 && git push origin master --tags
 */

import { readFileSync, writeFileSync } from "node:fs";

const PACKAGES = [
  "core",
  "storage",
  "alchemy",
  "transactor",
  "replica",
  "worker",
  "react",
  "better-auth",
] as const;

const version = process.argv[2];

if (!version) {
  console.error("usage: bun run scripts/set-version.ts <version>");
  process.exit(1);
}

// Semver, optionally with a prerelease tag (0.2.0-alpha.1) — a leading "v" is a
// common slip and produces a version npm will reject, so catch it here.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`invalid version: ${version} (expected e.g. 0.2.0 or 0.2.0-alpha.1, with no leading "v")`);
  process.exit(1);
}

for (const path of ["package.json", ...PACKAGES.map((p) => `packages/${p}/package.json`)]) {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { version: string };
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`set ${PACKAGES.length + 1} manifests to ${version}`);
console.log(`\nnext:\n  git commit -am "release: v${version}"\n  git tag v${version}\n  git push origin HEAD --tags`);
