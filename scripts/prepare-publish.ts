#!/usr/bin/env bun
/**
 * Rewrite the internal `workspace:*` dependency ranges to the concrete version
 * being released, so the published tarballs are installable.
 *
 * This has to be explicit. `bun pm pack` rewrites the workspace protocol on its
 * own but `npm pack` / `npm publish` does not — it leaves `"@ramose/core":
 * "workspace:*"` in the tarball, which npm cannot resolve, and a version
 * published that way is broken permanently (npm will not let you reuse it).
 * Since the release workflow publishes with npm (trusted publishing and
 * provenance both require the npm CLI), we do the rewrite ourselves rather than
 * depend on any packer's behaviour.
 *
 * Ranges are pinned exactly (`0.1.0`, not `^0.1.0`): the packages release in
 * lockstep and are only tested as a matched set.
 *
 * Usage:
 *   bun run scripts/prepare-publish.ts            # workspace:* → <version>
 *   bun run scripts/prepare-publish.ts --restore  # <version> → workspace:*
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

const restore = process.argv.includes("--restore");

const version = (JSON.parse(readFileSync("packages/core/package.json", "utf8")) as { version: string }).version;

let rewrites = 0;

for (const pkg of PACKAGES) {
  const path = `packages/${pkg}/package.json`;
  const raw = readFileSync(path, "utf8");
  const manifest = JSON.parse(raw) as Record<string, Record<string, string> | unknown>;

  for (const group of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = manifest[group] as Record<string, string> | undefined;
    if (!deps) continue;

    for (const [dep, range] of Object.entries(deps)) {
      if (!dep.startsWith("@ramose/")) continue;

      if (restore) {
        if (range !== "workspace:*") {
          deps[dep] = "workspace:*";
          rewrites++;
        }
      } else if (range.startsWith("workspace:")) {
        deps[dep] = version;
        rewrites++;
      }
    }
  }

  // Preserve the trailing newline convention of the original file.
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

const direction = restore ? "restored to workspace:*" : `pinned to ${version}`;
console.log(`${rewrites} internal dependency ranges ${direction}`);
