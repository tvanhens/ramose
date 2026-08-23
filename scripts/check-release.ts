#!/usr/bin/env bun
/**
 * Pre-flight checks for a release. Run by CI before it publishes anything, and
 * safe to run locally at any time.
 *
 * Verifies, for the published package:
 *   - the workspace root and the package agree on the version
 *   - the git tag being released matches that version, when one is supplied
 *   - it is not still `private: true`
 *   - the metadata npm needs is present
 *   - no dependency is a floating `latest` / `*`, which would make a published
 *     version non-reproducible
 *   - no dependency is left on the `workspace:` protocol, which npm cannot
 *     resolve out of a tarball
 *   - every path named in `exports` actually exists (needs `bun run build`)
 *
 * Usage:
 *   bun run scripts/check-release.ts              # metadata only
 *   bun run scripts/check-release.ts --built      # also verify exports resolve
 *   bun run scripts/check-release.ts --tag v0.2.0 # also verify the tag matches
 */

import { existsSync, readFileSync } from "node:fs";

const PACKAGE_DIR = "packages/ramose";

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

const manifest = JSON.parse(readFileSync(`${PACKAGE_DIR}/package.json`, "utf8")) as Manifest;
const root = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;
const label = manifest.name;
const version = manifest.version;

// --- the workspace root moves in lockstep -----------------------------------
// It is private and never published, but scripts/set-version.ts writes both and
// the release notes read the root. A drift means one of them was hand-edited.
if (root.version !== version) {
  errors.push(`the workspace root is at ${root.version} but ${label} is at ${version}`);
}

// The published alchemy range is a tested 2.x-beta window, bumped per
// release. The workspace root must pin the same tested version (exact) so
// `bun update alchemy` cannot install npm `latest` beside it and split two
// copies of alchemy's types into examples vs packages/ramose.
const packageAlchemy = manifest.dependencies?.alchemy;
const rootAlchemy = root.dependencies?.alchemy;
const alchemyFloor = packageAlchemy?.match(/^>=(\S+) </)?.[1];
if (packageAlchemy === undefined) {
  errors.push(`${label} is missing an alchemy dependency`);
} else if (rootAlchemy !== alchemyFloor) {
  errors.push(
    `the workspace root alchemy is ${JSON.stringify(rootAlchemy)} but ${label} ` +
      `pins ${JSON.stringify(packageAlchemy)} — root must be the exact floor ` +
      `(${JSON.stringify(alchemyFloor)}) so the next bump cannot half-land`,
  );
}

// --- the tag matches --------------------------------------------------------
if (tag) {
  const expected = `v${version}`;
  if (tag !== expected) {
    errors.push(`tag ${tag} does not match the manifest version (expected ${expected})`);
  }
}

// --- metadata ---------------------------------------------------------------
if (manifest.private) {
  errors.push(`${label} is still marked "private": true and cannot be published`);
}

for (const field of REQUIRED_FIELDS) {
  if (manifest[field] === undefined) {
    errors.push(`${label} is missing the "${field}" field`);
  }
}

for (const group of ["dependencies", "peerDependencies"] as const) {
  for (const [dep, range] of Object.entries(manifest[group] ?? {})) {
    // A floating range makes a published version non-reproducible: a consumer
    // installing 0.2.0 a month from now can resolve a different dependency tree.
    if (range === "latest" || range === "*" || range === "") {
      errors.push(`${label} has a floating ${group} range: "${dep}": "${range}"`);
    }
    // `workspace:` is a package-manager protocol, not a version. npm leaves it
    // verbatim in the tarball and the install then fails for everyone.
    if (range.startsWith("workspace:")) {
      errors.push(`${label} has a workspace range npm cannot resolve: "${dep}": "${range}"`);
    }
  }
}

// --- every exports target actually ships ------------------------------------
// `files` decides what npm puts in the tarball. A target outside it resolves
// in this checkout and is absent from the published package, so the break only
// shows up for a consumer after publishing — and only for whichever resolver
// picks that condition. Bun is the sharp edge: it always applies the `bun`
// condition and does not fall back to `default` when the target is missing, so
// a `bun`-condition path outside `files` makes the tarball unimportable under
// Bun while Node stays perfectly happy. This is a manifest check, not a build
// check: it runs without `--built`.
for (const target of exportTargets(manifest.exports)) {
  if (!shipsInTarball(target, (manifest.files ?? []) as string[])) {
    errors.push(
      `${label} exports "${target}" but "files" does not ship it — ` +
        `the tarball would resolve that specifier to a file that is not there`,
    );
  }
}

// --- exports resolve --------------------------------------------------------
if (checkBuilt) {
  for (const target of exportTargets(manifest.exports)) {
    if (!existsSync(`${PACKAGE_DIR}/${target}`)) {
      errors.push(`${label} exports "${target}" but ${PACKAGE_DIR}/${target} does not exist`);
    }
  }
  // `files` decides what npm puts in the tarball; a missing entry is a broken
  // install that only shows up after publishing.
  for (const file of (manifest.files ?? []) as string[]) {
    if (!existsSync(`${PACKAGE_DIR}/${file}`)) {
      errors.push(`${label} lists "${file}" in "files" but ${PACKAGE_DIR}/${file} does not exist`);
    }
  }

  // The `browser` condition is the claim: `import "ramose"` in a client
  // bundle must land on the portable module, not the deploy barrel. Node's
  // resolver is the one that honors `--conditions=browser`; Bun's checkout
  // `paths` map would hide a broken exports target.
  const browserResolved = resolveRamose(["--conditions=browser"]);
  const defaultResolved = resolveRamose([]);
  if (browserResolved !== undefined && !browserResolved.endsWith("/dist/browser.js")) {
    errors.push(
      `node --conditions=browser import.meta.resolve("ramose") landed on ` +
        `${browserResolved}, expected …/dist/browser.js`,
    );
  }
  if (defaultResolved !== undefined && !defaultResolved.endsWith("/dist/index.js")) {
    errors.push(
      `node import.meta.resolve("ramose") landed on ${defaultResolved}, ` +
        `expected …/dist/index.js`,
    );
  }
}

if (errors.length > 0) {
  console.error("release checks failed:\n");
  for (const error of errors) console.error(`  ✗ ${error}`);
  console.error("");
  process.exit(1);
}

console.log(`release checks passed — ${label} at ${version}${tag ? ` (tag ${tag})` : ""}`);

/**
 * Is `target` inside something `files` ships? npm always includes
 * `package.json` whether or not it is listed, so that one is free.
 */
function shipsInTarball(target: string, files: string[]): boolean {
  const path = target.replace(/^\.\//, "");
  if (path === "package.json") return true;
  return files.some((entry) => {
    const root = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    return path === root || path.startsWith(`${root}/`);
  });
}

/** Resolve `ramose` through Node's package exports, from the repo root. */
function resolveRamose(extra: string[]): string | undefined {
  const result = Bun.spawnSync(
    ["node", ...extra, "-e", 'console.log(import.meta.resolve("ramose"))'],
    { cwd: process.cwd() },
  );
  if (result.exitCode !== 0) {
    errors.push(
      `node ${extra.join(" ")} import.meta.resolve("ramose") failed: ` +
        `${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
    );
    return undefined;
  }
  return result.stdout.toString().trim().replace(/^file:\/\//, "");
}


/** Every concrete file path named in an `exports` map, ignoring `*` patterns. */
function exportTargets(exports: unknown): string[] {
  if (typeof exports === "string") return exports.includes("*") ? [] : [exports];
  if (exports === null || typeof exports !== "object") return [];
  return Object.entries(exports as Record<string, unknown>).flatMap(([key, value]) =>
    key.includes("*") ? [] : exportTargets(value),
  );
}
