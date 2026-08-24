#!/usr/bin/env bun
/**
 * Fail if the published client `.d.ts` for `ramose/db` (connect / Db /
 * token) or `ramose/react` imports `effect`. Schema, errors, and the
 * `ramose/db/effect` hatch may still mention Effect.
 *
 * `connect.d.ts` is on the scanned list with **no** allowlist exemption —
 * a leak into `connect` / `ClientOptions` themselves fails the gate.
 * Mutation: adding `import type { Effect } from "effect/Effect"` to
 * `connect.ts` (or any exported type there) must fail this script.
 *
 * Follows relative imports **transitively** so a new module cannot smuggle
 * Effect onto the surface. After #222 the query hover types sit two hops
 * from the barrel (`query/index.d.ts` → `query/fluent.d.ts` /
 * `query/query.d.ts`); one hop missed them. `query/fluent.d.ts` and
 * `query/query.d.ts` are also on the scanned list so a leak into
 * `FluentQuery` / `QueryObject` is not hidden if the barrel hop is edited.
 * Allowed hops are paths relative to `dist/db` — a new file that happens
 * to share a basename (`session.ts` in a subdirectory) is not exempt.
 *
 * Run after `bun run build`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = "packages/ramose/dist";
const DB_DIST = join(ROOT, "db");
export const EFFECT_IMPORT =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?\sfrom\s*["']effect(?:\/[^"']*)?["']|(?:^|\n)\s*import\s*["']effect(?:\/[^"']*)?["']|import\(\s*["']effect(?:\/[^"']*)?["']/;
const RELATIVE_FROM =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?\sfrom\s*["'](\.[^"']+)["']/g;

/**
 * Relative modules (paths from `dist/db`) that already mention Effect
 * (schema codecs, tagged errors, session internals, the hatch alias).
 * A *new* relative module is not on this list and fails the gate if it
 * imports `effect`.
 *
 * App-surface modules (`connect`, `Db`, `token`, `index`, the query
 * hover files) are not on this list — they are scanned directly.
 */
export const ALLOWED_HOPS = new Set([
  "effect-types.d.ts",
  "Errors.d.ts",
  "Operation.d.ts",
  "session.d.ts",
  "Pull.d.ts",
  "Field.d.ts",
  "Entity.d.ts",
  "Schema.d.ts",
  "valueTypes.d.ts",
  // HTTPS transport, reached from Db / factory hops
  "http.d.ts",
]);

/** Drop comments so JSDoc samples (`from "effect/Schema"`) are not imports. */
export const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const hopFile = (from: string, spec: string): string => {
  const stripped = spec.replace(/\.(js|ts)$/, "");
  return join(dirname(from), `${stripped}.d.ts`);
};

export const hopKey = (file: string, dbDist: string = DB_DIST): string =>
  relative(dbDist, file).replaceAll("\\", "/");

/** App-surface declarations — scanned directly, no exemption. */
const files: string[] = [
  join(ROOT, "db/index.d.ts"),
  join(ROOT, "db/Db.d.ts"),
  join(ROOT, "db/token.d.ts"),
  join(ROOT, "db/subscription.d.ts"),
  join(ROOT, "db/connect.d.ts"),
  // Two hops from the barrel; listed so FluentQuery / QueryObject cannot
  // slip the scan if someone later edits the query/index re-exports.
  join(ROOT, "db/query/fluent.d.ts"),
  join(ROOT, "db/query/query.d.ts"),
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

export const hopsOf = (file: string): string[] => {
  const src = withoutComments(readFileSync(file, "utf8"));
  const hops: string[] = [];
  RELATIVE_FROM.lastIndex = 0;
  for (const match of src.matchAll(RELATIVE_FROM)) {
    const hop = hopFile(file, match[1]!);
    if (existsSync(hop)) hops.push(hop);
  }
  return hops;
};

/**
 * Follow relative imports from `roots` through every reached
 * non-allowlisted `.d.ts`. Allowlisted hops are terminals — they may
 * mention Effect, and walking through them would scan implementation
 * internals, not the hover surface.
 */
export const followHops = (
  roots: readonly string[],
  dbDist: string = DB_DIST,
  allowed: ReadonlySet<string> = ALLOWED_HOPS,
): { leaks: string[]; reached: string[] } => {
  const leaks: string[] = [];
  const reached: string[] = [];
  const seenHops = new Set<string>();
  const seenFiles = new Set<string>(roots);
  const queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i]!;
    for (const hop of hopsOf(file)) {
      const key = `${file} → ${hop}`;
      if (seenHops.has(key)) continue;
      seenHops.add(key);
      if (allowed.has(hopKey(hop, dbDist))) continue;
      reached.push(hop);
      const hopSrc = withoutComments(readFileSync(hop, "utf8"));
      if (EFFECT_IMPORT.test(hopSrc)) leaks.push(key);
      if (!seenFiles.has(hop)) {
        seenFiles.add(hop);
        queue.push(hop);
      }
    }
  }
  return { leaks, reached };
};

const run = (): void => {
  const missing = files.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    console.error("check-client-dts: missing declaration files (run bun run build):");
    for (const file of missing) console.error(`  ${file}`);
    process.exit(1);
  }

  const leaks: string[] = [];
  for (const file of files) {
    const src = withoutComments(readFileSync(file, "utf8"));
    if (EFFECT_IMPORT.test(src)) leaks.push(file);
  }

  // Hop-follow every scanned file transitively. `connect.d.ts` is in `files`
  // so a leak into `connect` / `ClientOptions` is not hidden by skipping
  // `index.d.ts`. `query/fluent.d.ts` / `query/query.d.ts` are reached even
  // if they are dropped from `files`.
  const { leaks: hopLeaks } = followHops(files);
  leaks.push(...hopLeaks);

  // Mutation probe: the regex must catch an Effect type on ClientOptions.
  const MUTATION = 'import type { Effect } from "effect/Effect";\nexport interface ClientOptions { token?: Effect.Effect<string>; }\n';
  if (!EFFECT_IMPORT.test(MUTATION)) {
    console.error(
      "check-client-dts: EFFECT_IMPORT regex failed its mutation probe (a ClientOptions Effect leak would pass)",
    );
    process.exit(1);
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
};

if (import.meta.main) {
  run();
}
