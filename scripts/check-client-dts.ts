#!/usr/bin/env bun
/**
 * Fail if the published client `.d.ts` for `ramose/db` (connect / Db /
 * token) or `ramose/react` imports `effect`. Schema, errors, and the
 * `ramose/db/effect` hatch may still mention Effect.
 *
 * Follows relative imports one hop so a new module cannot smuggle Effect
 * onto the surface. Allowed hops are paths relative to `dist/db` — a new
 * file that happens to share a basename (`session.ts` in a subdirectory)
 * is not exempt.
 *
 * Run after `bun run build`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = "packages/ramose/dist";
const DB_DIST = join(ROOT, "db");
const EFFECT_IMPORT =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?\sfrom\s*["']effect(?:\/[^"']*)?["']|(?:^|\n)\s*import\s*["']effect(?:\/[^"']*)?["']|import\(\s*["']effect(?:\/[^"']*)?["']/;
const RELATIVE_FROM =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?\sfrom\s*["'](\.[^"']+)["']/g;

/**
 * Relative modules (paths from `dist/db`) that already mention Effect
 * (schema codecs, tagged errors, session internals, the hatch alias).
 * A *new* relative module is not on this list and fails the gate if it
 * imports `effect`.
 */
const ALLOWED_HOPS = new Set([
  "effect-types.d.ts",
  "Errors.d.ts",
  "Operation.d.ts",
  "session.d.ts",
  "Pull.d.ts",
  "Attribute.d.ts",
  "valueTypes.d.ts",
  // hatch file — `layer` / `Databases` / `makeDatabases`. Its own Effect
  // imports are expected; we still scan *its* hops below.
  "Databases.d.ts",
  // hatch HTTPS transport, reached from Databases.d.ts
  "http.d.ts",
]);

/** Drop comments so JSDoc samples (`from "effect/Schema"`) are not imports. */
const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const hopFile = (from: string, spec: string): string => {
  const stripped = spec.replace(/\.(js|ts)$/, "");
  return join(dirname(from), `${stripped}.d.ts`);
};

const hopKey = (file: string): string =>
  relative(DB_DIST, file).replaceAll("\\", "/");

const files: string[] = [
  join(ROOT, "db/index.d.ts"),
  join(ROOT, "db/Db.d.ts"),
  join(ROOT, "db/token.d.ts"),
  join(ROOT, "db/subscription.d.ts"),
  join(ROOT, "db/connect.d.ts"),
];

const reactDir = join(ROOT, "react");
if (existsSync(reactDir)) {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".d.ts")) files.push(path);
    }
  };
  walk(reactDir);
}

const missing = files.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error("check-client-dts: missing declaration files (run bun run build):");
  for (const file of missing) console.error(`  ${file}`);
  process.exit(1);
}

const hopsOf = (file: string): string[] => {
  const src = withoutComments(readFileSync(file, "utf8"));
  const hops: string[] = [];
  RELATIVE_FROM.lastIndex = 0;
  for (const match of src.matchAll(RELATIVE_FROM)) {
    const hop = hopFile(file, match[1]!);
    if (existsSync(hop)) hops.push(hop);
  }
  return hops;
};

const leaks: string[] = [];
for (const file of files) {
  const src = withoutComments(readFileSync(file, "utf8"));
  if (EFFECT_IMPORT.test(src)) leaks.push(file);
}

// Hop-follow the client handles *and* the schema barrel (so `connect` /
// `ClientOptions` in `connect.d.ts` are not hidden by skipping `index.d.ts`)
// *and* the hatch file's children (`effect-types` is the allowlisted alias).
const hopSources = [...files, join(ROOT, "db/Databases.d.ts")];
const seenHops = new Set<string>();
for (const file of hopSources) {
  if (!existsSync(file)) continue;
  for (const hop of hopsOf(file)) {
    const key = `${file} → ${hop}`;
    if (seenHops.has(key)) continue;
    seenHops.add(key);
    if (ALLOWED_HOPS.has(hopKey(hop))) continue;
    const hopSrc = withoutComments(readFileSync(hop, "utf8"));
    if (EFFECT_IMPORT.test(hopSrc)) leaks.push(key);
  }
}

if (leaks.length > 0) {
  console.error(
    "check-client-dts: these client/react declarations import `effect`:",
  );
  for (const file of leaks) console.error(`  ${file}`);
  process.exit(1);
}

console.log(
  `check-client-dts: ${files.length} files, no effect imports on ramose/db client or ramose/react`,
);
