#!/usr/bin/env bun

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

if (root.version !== version) {
  errors.push(`the workspace root is at ${root.version} but ${label} is at ${version}`);
}

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

if (tag) {
  const expected = `v${version}`;
  if (tag !== expected) {
    errors.push(`tag ${tag} does not match the manifest version (expected ${expected})`);
  }
}

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

    if (range === "latest" || range === "*" || range === "") {
      errors.push(`${label} has a floating ${group} range: "${dep}": "${range}"`);
    }

    if (range.startsWith("workspace:")) {
      errors.push(`${label} has a workspace range npm cannot resolve: "${dep}": "${range}"`);
    }
  }
}

for (const target of exportTargets(manifest.exports)) {
  if (!shipsInTarball(target, (manifest.files ?? []) as string[])) {
    errors.push(
      `${label} exports "${target}" but "files" does not ship it — ` +
        `the tarball would resolve that specifier to a file that is not there`,
    );
  }
}

if (checkBuilt) {
  for (const target of exportTargets(manifest.exports)) {
    if (!existsSync(`${PACKAGE_DIR}/${target}`)) {
      errors.push(`${label} exports "${target}" but ${PACKAGE_DIR}/${target} does not exist`);
    }
  }

  for (const file of (manifest.files ?? []) as string[]) {
    if (!existsSync(`${PACKAGE_DIR}/${file}`)) {
      errors.push(`${label} lists "${file}" in "files" but ${PACKAGE_DIR}/${file} does not exist`);
    }
  }

  const defaultResolved = resolveRamose([]);
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

function shipsInTarball(target: string, files: string[]): boolean {
  const path = target.replace(/^\.\//, "");
  if (path === "package.json") return true;
  return files.some((entry) => {
    const root = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    return path === root || path.startsWith(`${root}/`);
  });
}

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

function exportTargets(exports: unknown): string[] {
  if (typeof exports === "string") return exports.includes("*") ? [] : [exports];
  if (exports === null || typeof exports !== "object") return [];
  return Object.entries(exports as Record<string, unknown>).flatMap(([key, value]) =>
    key.includes("*") ? [] : exportTargets(value),
  );
}
