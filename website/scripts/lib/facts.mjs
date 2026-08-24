// Code facts the docs state as numbers or tables. The source files are the
// source of truth; a drifted count or a listed export that no longer exists
// is an error.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./snippets.mjs";

const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const skipType = (part) => /^\s*type\s/.test(part.trim());

/** Runtime names of `export { … }` / `export const` / `export * as`. */
export const runtimeExports = (src) => {
  const names = new Set();
  for (const m of src.matchAll(
    /export\s+(?:async\s+)?(?:const|function|class|let|var)\s+(\w+)/g,
  )) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s+\*\s+as\s+(\w+)/g)) names.add(m[1]);
  for (const block of src.matchAll(/export\s+\{([^}]+)\}/g)) {
    for (const part of block[1].split(",")) {
      const t = part.trim();
      if (!t || skipType(t)) continue;
      const exported = t.includes(" as ")
        ? t.split(/\bas\b/).pop().trim()
        : t;
      if (exported) names.add(exported);
    }
  }
  return names;
};

export const typeExports = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/export\s+type\s+(?:\{[^}]+\}|(\w+))/g)) {
    if (m[1]) names.add(m[1]);
  }
  for (const block of src.matchAll(/export\s+type\s+\{([^}]+)\}/g)) {
    for (const part of block[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const exported = t.includes(" as ")
        ? t.split(/\bas\b/).pop().trim()
        : t.replace(/^type\s+/, "");
      if (exported) names.add(exported);
    }
  }
  for (const block of src.matchAll(/export\s+\{([^}]+)\}/g)) {
    for (const part of block[1].split(",")) {
      const t = part.trim();
      if (!t.startsWith("type ")) continue;
      const exported = t.slice(5).trim().includes(" as ")
        ? t.slice(5).trim().split(/\bas\b/).pop().trim()
        : t.slice(5).trim();
      if (exported) names.add(exported);
    }
  }
  return names;
};

export const dbErrorTags = () => {
  const src = read("packages/ramose/src/db/Errors.ts");
  const m = src.match(/export type DbError\s*=\s*([\s\S]*?);/);
  if (!m) throw new Error("DbError union not found in Errors.ts");
  return [...m[1].matchAll(/\|\s*(\w+)/g)].map((x) => x[1]);
};

export const ramoseDbRuntime = () =>
  runtimeExports(read("packages/ramose/src/db/index.ts"));

export const ramoseRootRuntime = () => {
  const db = ramoseDbRuntime();
  const root = runtimeExports(read("packages/ramose/src/index.ts"));
  const added = new Set();
  for (const n of root) if (!db.has(n)) added.add(n);
  return { all: new Set([...db, ...root]), added, db };
};

export const ramoseReactRuntime = () =>
  runtimeExports(read("packages/ramose/src/react/index.ts"));

/** Backticked identifiers in a table cell / prose list. */
export const tickNames = (text) =>
  [...text.matchAll(/`([A-Za-z_][A-Za-z0-9]*)`/g)].map((m) => m[1]);

/** Export names the page claims in frontmatter `description:`. */
export const listedFromFrontmatter = (fm) => {
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1] ?? "";
  return tickNames(desc);
};

const COUNT_WORDS = {
  nine: 9,
  eight: 8,
  seven: 7,
  ten: 10,
  six: 6,
  eleven: 11,
};

export const statedRequestErrorCounts = (body) => {
  const out = [];
  const re =
    /\b(nine|eight|seven|ten|six|eleven|\d+)\s+request errors\b/gi;
  for (const m of body.matchAll(re)) {
    const raw = m[1].toLowerCase();
    const n = COUNT_WORDS[raw] ?? Number(raw);
    out.push({ n, text: m[0] });
  }
  return out;
};

export const errorTableTags = (body) => {
  const section = body.split("## What the user sees")[0] ?? body;
  const tags = [];
  for (const m of section.matchAll(/^\|\s*`([A-Za-z]+)`\s*\|/gm)) {
    tags.push(m[1]);
  }
  return tags;
};
