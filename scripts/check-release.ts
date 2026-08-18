#!/usr/bin/env bun
/**
 * Pre-flight checks for a release. Run by CI before it publishes anything, and
 * safe to run locally at any time.
 *
 * Verifies, across every publishable package:
 *   - versions are identical (the packages release in lockstep)
 *   - the git tag being released matches that version, when one is supplied
 *   - nothing is still `private: true`
 *   - the metadata npm needs is present
 *   - no dependency is a floating `latest` / `*`, which would make a published
 *     version non-reproducible
 *   - every path named in `exports` actually exists (needs `bun run build`)
 *
 * Usage:
 *   bun run scripts/check-release.ts              # metadata only
 *   bun run scripts/check-release.ts --built      # also verify exports resolve
 *   bun run scripts/check-release.ts --tag v0.1.0 # also verify the tag matches
 */

import { existsSync, readFileSync } from "node:fs";

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

const REQUIRED_FIELDS = ["name", "version", "description", "license", "repository", "exports", "files"] as const;

type Manifest = Record<string, unknown> & {
  name: string;
  version: string;
  private?: boolean;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const argv = process.argv.slice(2);
const checkBuilt = argv.includes("--built");
const tagIndex = argv.indexOf("--tag");
const tag = tagIndex >= 0 ? argv[tagIndex + 1] : process.env.RELEASE_TAG;

const errors: string[] = [];
const manifests = new Map<string, Manifest>();

for (const pkg of PACKAGES) {
  const path = `packages/${pkg}/package.json`;
  manifests.set(pkg, JSON.parse(readFileSync(path, "utf8")) as Manifest);
}

// --- versions agree ---------------------------------------------------------
const versions = new Set([...manifests.values()].map((m) => m.version));
if (versions.size !== 1) {
  const detail = [...manifests].map(([p, m]) => `  @ramose/${p} → ${m.version}`).join("\n");
  errors.push(`packages disagree on version:\n${detail}`);
}
const version = [...versions][0];

// --- the tag matches --------------------------------------------------------
if (tag) {
  const expected = `v${version}`;
  if (tag !== expected) {
    errors.push(`tag ${tag} does not match the manifest version (expected ${expected})`);
  }
}

// --- per-package metadata ---------------------------------------------------
for (const [pkg, manifest] of manifests) {
  const label = `@ramose/${pkg}`;

  if (manifest.private) {
    errors.push(`${label} is still marked "private": true and cannot be published`);
  }

  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined) {
      errors.push(`${label} is missing the "${field}" field`);
    }
  }

  // A floating range makes a published version non-reproducible: a consumer
  // installing 0.1.0 a month from now can resolve a different dependency tree.
  for (const group of ["dependencies", "peerDependencies"] as const) {
    for (const [dep, range] of Object.entries(manifest[group] ?? {})) {
      if (range === "latest" || range === "*" || range === "") {
        errors.push(`${label} has a floating ${group} range: "${dep}": "${range}"`);
      }
    }
  }

  // Internal deps must move in lockstep. Before scripts/prepare-publish.ts runs
  // they are `workspace:*`; after it they are pinned to the release version.
  // Anything else means the two are out of step.
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!dep.startsWith("@ramose/")) continue;
    if (range !== "workspace:*" && range !== version) {
      errors.push(`${label} depends on ${dep} via "${range}"; expected "workspace:*" or "${version}"`);
    }
  }

  if (checkBuilt) {
    for (const target of exportTargets(manifest.exports)) {
      // The `bun` condition points at TypeScript source, which ships too.
      if (!existsSync(`packages/${pkg}/${target}`)) {
        errors.push(`${label} exports "${target}" but packages/${pkg}/${target} does not exist`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error("release checks failed:\n");
  for (const error of errors) console.error(`  ✗ ${error}`);
  console.error("");
  process.exit(1);
}

console.log(`release checks passed — ${PACKAGES.length} packages at ${version}${tag ? ` (tag ${tag})` : ""}`);

/** Every concrete file path named in an `exports` map, ignoring `*` patterns. */
function exportTargets(exports: unknown): string[] {
  if (typeof exports === "string") return exports.includes("*") ? [] : [exports];
  if (exports === null || typeof exports !== "object") return [];
  return Object.entries(exports as Record<string, unknown>).flatMap(([key, value]) =>
    key.includes("*") ? [] : exportTargets(value),
  );
}
