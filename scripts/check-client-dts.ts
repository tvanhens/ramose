#!/usr/bin/env bun
/**
 * Fail if the published client `.d.ts` for `ramose/db` (connect / Db /
 * token) or `ramose/react` imports `effect`. Schema, errors, and the
 * `ramose/db/effect` hatch may still mention Effect.
 *
 * Run after `bun run build`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "packages/ramose/dist";
const EFFECT_IMPORT =
  /from\s+["']effect(?:\/[^"']*)?["']|import\(\s*["']effect(?:\/[^"']*)?["']/;

const files: string[] = [
  join(ROOT, "db/index.d.ts"),
  join(ROOT, "db/Db.d.ts"),
  join(ROOT, "db/token.d.ts"),
  join(ROOT, "db/subscription.d.ts"),
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

const leaks: string[] = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (EFFECT_IMPORT.test(src)) leaks.push(file);
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
