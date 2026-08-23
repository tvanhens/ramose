#!/usr/bin/env bun
/**
 * Fail if the published client `.d.ts` for `ramose/db` (connect / Db /
 * token) or `ramose/react` imports `effect`. Schema, errors, and the
 * `ramose/db/effect` hatch may still mention Effect.
 *
 * Follows relative imports one hop so a new module cannot smuggle Effect
 * onto the surface. `effect-types` is the allowlisted hatch alias file.
 *
 * Run after `bun run build`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const ROOT = "packages/ramose/dist";
const EFFECT_IMPORT =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?\sfrom\s*["']effect(?:\/[^"']*)?["']|(?:^|\n)\s*import\s*["']effect(?:\/[^"']*)?["']|import\(\s*["']effect(?:\/[^"']*)?["']/;
const RELATIVE_FROM =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?\sfrom\s*["'](\.[^"']+)["']/g;

/** Hatch aliases so `Db.d.ts` can name Effect without importing `effect`. */
const ALLOWED_HOPS = new Set(["effect-types"]);

/** Drop comments so JSDoc samples (`from "effect/Schema"`) are not imports. */
const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

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

const hopFile = (from: string, spec: string): string => {
  const stripped = spec.replace(/\.(js|ts)$/, "");
  return join(dirname(from), `${stripped}.d.ts`);
};

const hopName = (file: string): string =>
  basename(file).replace(/\.d\.ts$/, "");

const leaks: string[] = [];
for (const file of files) {
  const src = withoutComments(readFileSync(file, "utf8"));
  if (EFFECT_IMPORT.test(src)) leaks.push(file);

  // index.d.ts is the schema barrel — it re-exports Operation / errors /
  // Attr, whose declarations name `effect`. Hop-follow is for the client
  // handle types (Db, token, subscription, react), where a new relative
  // module could smuggle Effect onto `db.q` / hooks.
  if (file.endsWith("db/index.d.ts")) continue;

  RELATIVE_FROM.lastIndex = 0;
  for (const match of src.matchAll(RELATIVE_FROM)) {
    const spec = match[1]!;
    const hop = hopFile(file, spec);
    if (!existsSync(hop)) continue;
    if (ALLOWED_HOPS.has(hopName(hop))) continue;
    const hopSrc = withoutComments(readFileSync(hop, "utf8"));
    if (EFFECT_IMPORT.test(hopSrc)) leaks.push(`${file} → ${hop}`);
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
