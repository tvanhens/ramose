#!/usr/bin/env bun
/**
 * CI guard for issue #390: reject newly introduced test doubles.
 *
 * Allowed instrumentation records, blocks, releases, closes, restarts, or
 * corrupts a real implementation. It must not invent HTTP/WebSocket
 * responses, substitute R2/SQLite/Cache/auth, or mock `cloudflare:workers`.
 *
 * Existing violations live in `scripts/test-double-allowlist.json`. Shrink
 * that file to `{}` as migrations merge. Do not add new entries.
 *
 *   bun run scripts/check-test-doubles.ts
 *   bun run scripts/check-test-doubles.ts --write-allowlist
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ALLOWLIST_PATH = join(import.meta.dir, "test-double-allowlist.json");

export type PatternId =
  | "mock.module"
  | "scriptedPeer"
  | "FakeSocket"
  | "fakeDispatch"
  | "FakeAnalytics"
  | "fakeEnv"
  | "fakeDataset"
  | "MemoryBucket"
  | "MemCache"
  | "memoryAdapter"
  | "inProcessPeer"
  | "happy-dom"
  | "WebSocketImpl"
  | "bun:sqlite"
  | "TestClock";

export interface Pattern {
  readonly id: PatternId;
  readonly re: RegExp;
  readonly note: string;
}

/** Forbidden infrastructure-double markers. Domain fixtures and docs are out of scope. */
export const PATTERNS: readonly Pattern[] = [
  {
    id: "mock.module",
    re: /\bmock\.module\s*\(/,
    note: "do not mock cloudflare:workers or other platform modules",
  },
  {
    id: "scriptedPeer",
    re: /\bscriptedPeer\b/,
    note: "use the Alchemy local peer plus a forwarding recorder",
  },
  {
    id: "FakeSocket",
    re: /\bFakeSocket\b/,
    note: "close or record a real WebSocket",
  },
  {
    id: "fakeDispatch",
    re: /\bfakeDispatch\b/,
    note: "dispatch through the real Worker / replica",
  },
  {
    id: "FakeAnalytics",
    re: /\bFakeAnalytics\b/,
    note: "keep column mapping as pure tests; live analytics stay on the local stack or cloud e2e",
  },
  {
    id: "fakeEnv",
    re: /\bfakeEnv\s*\(/,
    note: "do not invent Durable Object namespaces",
  },
  {
    id: "fakeDataset",
    re: /\bfakeDataset\s*\(/,
    note: "do not invent Analytics Engine datasets",
  },
  {
    id: "MemoryBucket",
    re: /\bMemoryBucket\b/,
    note: "use the local R2 binding; corrupt via /__test__ admin if needed",
  },
  {
    id: "MemCache",
    re: /\bMemCache\b/,
    note: "use the local Cache API",
  },
  {
    id: "memoryAdapter",
    re: /\bmemoryAdapter\b/,
    note: "use a locally deployed auth Worker and real backing store",
  },
  {
    id: "inProcessPeer",
    re: /\binProcessPeer\b/,
    note: "use the shared Alchemy local stack",
  },
  {
    id: "happy-dom",
    re: /happy-dom|GlobalRegistrator/,
    note: "run browser/React lifecycle tests in a real browser",
  },
  {
    id: "WebSocketImpl",
    re: /\bWebSocketImpl\b/,
    note: "inject a recording wrapper around the real WebSocket, not a scripted one",
  },
  {
    id: "bun:sqlite",
    re: /from\s+["']bun:sqlite["']/,
    note: "do not stand bun:sqlite in for Durable Object SQLite",
  },
  {
    id: "TestClock",
    re: /\b(?:TestClock|runWithTestClock)\b/,
    note: "keep timestamp decisions as pure functions; live cache uses real time",
  },
];

const SCAN_ROOTS = [
  "packages/ramose/test",
  "test",
  "scripts",
] as const;

const SKIP_DIR = new Set(["node_modules", "dist", ".alchemy", ".git"]);
const SKIP_FILE = new Set([
  "scripts/check-test-doubles.ts",
  "scripts/check-test-doubles.test.ts",
  "scripts/test-double-allowlist.json",
]);

const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

export interface Hit {
  readonly file: string;
  readonly id: PatternId;
  readonly line: number;
  readonly text: string;
}

export interface Allowlist {
  readonly comment?: string;
  readonly files: Record<string, PatternId[]>;
}

const walk = (dir: string, out: string[]): void => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
};

const rel = (abs: string): string => relative(ROOT, abs).replaceAll("\\", "/");

export const scanFile = (abs: string, patterns: readonly Pattern[] = PATTERNS): Hit[] => {
  const file = rel(abs);
  if (SKIP_FILE.has(file)) return [];
  if (![...TEXT_EXT].some((ext) => file.endsWith(ext))) return [];
  const raw = readFileSync(abs, "utf8");
  // Keep line numbers; blank out block comments so docs can name the
  // forbidden identifiers without counting as a double.
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  const hits: Hit[] = [];
  const original = raw.split(/\r?\n/);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\/\/.*$/, "");
    if (line.trim().length === 0) continue;
    for (const p of patterns) {
      p.re.lastIndex = 0;
      if (p.re.test(line)) {
        hits.push({ file, id: p.id, line: i + 1, text: (original[i] ?? line).trim() });
      }
    }
  }
  return hits;
};

export const scanRoots = (root = ROOT, patterns: readonly Pattern[] = PATTERNS): Hit[] => {
  const files: string[] = [];
  for (const dir of SCAN_ROOTS) {
    const abs = join(root, dir);
    if (existsSync(abs)) walk(abs, files);
  }
  return files.flatMap((f) => scanFile(f, patterns));
};

export const loadAllowlist = (path = ALLOWLIST_PATH): Allowlist => {
  if (!existsSync(path)) return { files: {} };
  return JSON.parse(readFileSync(path, "utf8")) as Allowlist;
};

export const hitsByFile = (hits: Hit[]): Map<string, Set<PatternId>> => {
  const map = new Map<string, Set<PatternId>>();
  for (const h of hits) {
    const set = map.get(h.file) ?? new Set<PatternId>();
    set.add(h.id);
    map.set(h.file, set);
  }
  return map;
};

export interface CheckResult {
  readonly newHits: Hit[];
  readonly stale: string[];
  readonly missingIds: { file: string; id: PatternId }[];
}

export const evaluate = (hits: Hit[], allowlist: Allowlist): CheckResult => {
  const byFile = hitsByFile(hits);
  const newHits: Hit[] = [];
  const missingIds: { file: string; id: PatternId }[] = [];
  const stale: string[] = [];

  for (const h of hits) {
    const allowed = allowlist.files[h.file];
    if (allowed === undefined || !allowed.includes(h.id)) newHits.push(h);
  }

  for (const [file, ids] of Object.entries(allowlist.files)) {
    const present = byFile.get(file);
    if (present === undefined) {
      stale.push(file);
      continue;
    }
    for (const id of ids) {
      if (!present.has(id)) missingIds.push({ file, id });
    }
  }

  return { newHits, stale, missingIds };
};

const writeAllowlist = (hits: Hit[]): void => {
  const files: Record<string, PatternId[]> = {};
  for (const [file, ids] of [...hitsByFile(hits).entries()].sort(([a], [b]) => a.localeCompare(b))) {
    files[file] = [...ids].sort();
  }
  const body: Allowlist = {
    comment:
      "Existing #390 test-double violations. Shrink to empty as migrations merge. Do not add new entries.",
    files,
  };
  writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(body, null, 2)}\n`);
};

const main = (): number => {
  const write = process.argv.includes("--write-allowlist");
  const hits = scanRoots();
  if (write) {
    writeAllowlist(hits);
    console.log(`wrote ${hitsByFile(hits).size} allowlisted files (${hits.length} hits)`);
    return 0;
  }
  const result = evaluate(hits, loadAllowlist());
  const errors: string[] = [];
  if (result.newHits.length > 0) {
    errors.push("new test doubles (not on the #390 allowlist):");
    for (const h of result.newHits) {
      const pat = PATTERNS.find((p) => p.id === h.id);
      errors.push(`  ${h.file}:${h.line}  ${h.id}  ${pat?.note ?? ""}`);
      errors.push(`    ${h.text}`);
    }
  }
  if (result.stale.length > 0) {
    errors.push("allowlisted files with no remaining violations (remove them):");
    for (const f of result.stale) errors.push(`  ${f}`);
  }
  if (result.missingIds.length > 0) {
    errors.push("allowlisted pattern ids that no longer appear (remove them):");
    for (const m of result.missingIds) errors.push(`  ${m.file}  ${m.id}`);
  }
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    console.error(
      `\n#390: do not add infrastructure doubles. Record/forward the real local stack, ` +
        `test the reaction as pure logic, or leave the claim to cloud e2e.`,
    );
    return 1;
  }
  const remaining = Object.keys(loadAllowlist().files).length;
  console.log(`test-double guard ok (${remaining} allowlisted files remaining)`);
  return 0;
};

if (import.meta.main) {
  process.exit(main());
}
