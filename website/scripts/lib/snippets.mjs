// Shared snippet extraction for the docs site.
//
// A fence `title` may cite source as:
//   path#marker                  named region in that file
//   path:N                       one line
//   path:N-M                     inclusive line range
//   path#a · other.ts:10-12      several citations, stitched
//
// A later citation may be relative to the first path's directory
// (`app.ts:131` after `examples/kv-style/app.ts#worker-app`).
// Trailing notes in parentheses (`(annotated)`) are ignored.
//
// Named regions in source:
//   // docs:name
//   …lines…
//   // enddocs:name
// JSX/block-comment form `{/* docs:name */}` / `{/* enddocs:name */}`
// is accepted too. Marker lines are not part of the extract.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import deletedCitationAllowlist from "./deleted-citation-allowlist.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
export const SITE = resolve(HERE, "../..");
export const REPO = resolve(SITE, "..");

// Exact paths of known-deleted client files still cited from MDX. Missing
// citations are errors by default; only these paths may skip the body
// check. Shrink-only — do not glob, and do not add a general missing-file
// escape. Removal of entries is owned by #416 / #442.
// Imported so the Astro/Vite build embeds the list instead of looking for a
// sibling JSON in dist/.
const DELETED_CITATION_ALLOWLIST = new Set(deletedCitationAllowlist);

const isAllowlistedDeleted = (relPath) =>
  DELETED_CITATION_ALLOWLIST.has(relPath);

const CITE_RE =
  /([\w./-]+\.(?:ts|tsx|mjs|json|css))(?:#([\w-]+)|:(\d+)(?:-(\d+))?)/g;

const START_RES = [
  /^\s*\/\/\s*docs:([\w-]+)\s*$/,
  /^\s*\{\/\*\s*docs:([\w-]+)\s*\*\/\}\s*$/,
];
const END_RES = [
  /^\s*\/\/\s*enddocs:([\w-]+)\s*$/,
  /^\s*\{\/\*\s*enddocs:([\w-]+)\s*\*\/\}\s*$/,
];

const isMarkerLine = (line) =>
  START_RES.some((re) => re.test(line)) || END_RES.some((re) => re.test(line));

let repoFilesCache = null;

const walkRepo = () => {
  if (repoFilesCache) return repoFilesCache;
  const skip = new Set([
    "node_modules",
    ".git",
    ".claude",
    ".cursor",
    "dist",
    ".alchemy",
    ".astro",
  ]);
  const collect = (dir) => {
    let out = [];
    for (const f of readdirSync(dir)) {
      if (skip.has(f)) continue;
      const p = join(dir, f);
      try {
        if (statSync(p).isDirectory()) out = out.concat(collect(p));
        else out.push(p);
      } catch {
        /* unreadable */
      }
    }
    return out;
  };
  repoFilesCache = collect(REPO);
  return repoFilesCache;
};

export const resolveRepoFile = (relPath, hintDir) => {
  const candidates = [];
  if (hintDir) candidates.push(join(REPO, hintDir, relPath));
  candidates.push(join(REPO, relPath));
  const found = candidates.find(existsSync);
  if (found) return found;
  return walkRepo().find((p) => p.endsWith("/" + relPath));
};

export const parseTitleCitations = (title) => {
  if (!title) return [];
  const stripped = title.replace(/\s*\([^)]*\)\s*$/, "");
  return [...stripped.matchAll(CITE_RE)].map((m) => ({
    relPath: m[1],
    marker: m[2] ?? null,
    start: m[3] ? Number(m[3]) : null,
    end: m[4] ? Number(m[4]) : m[3] ? Number(m[3]) : null,
  }));
};

const markerBounds = (lines, name) => {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    for (const re of START_RES) {
      const m = lines[i].match(re);
      if (m?.[1] === name) {
        start = i + 1;
        break;
      }
    }
    if (start !== -1) break;
  }
  if (start === -1) return null;
  for (let i = start; i < lines.length; i++) {
    for (const re of END_RES) {
      const m = lines[i].match(re);
      if (m?.[1] === name) return { start, end: i }; // end exclusive
    }
  }
  return null;
};

export const extractCitation = (cite, hintDir) => {
  const found = resolveRepoFile(cite.relPath, hintDir);
  if (!found) {
    const error = `cited file does not exist: ${cite.relPath}`;
    if (isAllowlistedDeleted(cite.relPath)) {
      return { ok: false, skipped: true, error };
    }
    return { ok: false, error };
  }
  const rel = relative(REPO, found).replaceAll("\\", "/");
  const lines = readFileSync(found, "utf8").split("\n");
  // Drop a trailing empty line from the split so "last line" is honest.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  if (cite.marker) {
    const bounds = markerBounds(lines, cite.marker);
    if (!bounds) {
      if (isAllowlistedDeleted(`${cite.relPath}#${cite.marker}`)) {
        return {
          ok: false,
          skipped: true,
          error: `marker #${cite.marker} does not exist anymore in ${rel}`,
          rel,
        };
      }
      return {
        ok: false,
        error: `marker #${cite.marker} not found in ${rel}`,
        rel,
      };
    }
    const text = lines
      .slice(bounds.start, bounds.end)
      .filter((l) => !isMarkerLine(l))
      .join("\n");
    return {
      ok: true,
      rel,
      start: bounds.start + 1,
      end: bounds.end,
      text,
      label: `${rel}#${cite.marker}`,
    };
  }

  const a = cite.start;
  const b = cite.end ?? cite.start;
  if (a == null || b == null) {
    return { ok: false, error: `citation is missing a marker or line range: ${cite.relPath}`, rel };
  }
  if (a < 1 || b < a) {
    return { ok: false, error: `invalid range ${rel}:${a}-${b}`, rel };
  }
  if (b > lines.length) {
    return {
      ok: false,
      error: `cited range ${rel}:${a}-${b} exceeds file (${lines.length} lines)`,
      rel,
    };
  }
  return {
    ok: true,
    rel,
    start: a,
    end: b,
    text: lines.slice(a - 1, b).join("\n"),
    label: `${rel}:${a}-${b}`,
  };
};

export const extractTitle = (title) => {
  const cites = parseTitleCitations(title);
  if (!cites.length) return { ok: true, extracted: false, text: "", labels: [] };
  const parts = [];
  const labels = [];
  let hintDir = null;
  let any = false;
  let skippedSome = false;
  for (const cite of cites) {
    const got = extractCitation(cite, hintDir);
    if (got.skipped) {
      skippedSome = true;
      continue;
    }
    if (!got.ok) return { ok: false, extracted: true, error: got.error, labels };
    if (!hintDir) hintDir = dirname(got.rel);
    parts.push(got.text);
    labels.push(got.label);
    any = true;
  }
  // Allowlisted-deleted citations are not errors. The fence stays as
  // written (`extracted: false`) so docs-check and the Astro remark
  // plugin skip replacement instead of failing the build. A
  // non-allowlisted missing path already returned as an error above.
  if (skippedSome) {
    return { ok: true, extracted: false, skipped: true, text: parts.join("\n\n"), labels };
  }
  if (!any) return { ok: true, extracted: false, text: "", labels: [] };
  return { ok: true, extracted: true, text: parts.join("\n\n"), labels };
};

/** Lines that participate in a provenance comparison. */
export const comparableLines = (src) =>
  src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\/\/\s*…$/.test(l) && !/^\/\/\s*\.\.\.$/.test(l));

export const bodyMatchesExtract = (body, extracted) => {
  const shown = comparableLines(body);
  if (!shown.length) return { ok: true, empty: true, missing: [] };
  const cited = comparableLines(extracted);
  let i = 0;
  const missing = [];
  for (const line of shown) {
    const at = cited.indexOf(line, i);
    if (at === -1) missing.push(line);
    else i = at + 1;
  }
  const realMissing = missing.filter(
    (l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"),
  );
  return { ok: realMissing.length === 0, empty: false, missing: realMissing };
};
