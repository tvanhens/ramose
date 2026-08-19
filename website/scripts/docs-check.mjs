#!/usr/bin/env node
// docs-check — the single source of truth for objective facts about this docs site.
//
// Reviewers and writers must cite THIS tool rather than their own counts: hand
// counting produced three different "landing page word count" numbers in one
// review cycle, and disagreements about measurement stop a review loop from
// converging.
//
//   bun website/scripts/docs-check.mjs              human-readable report
//   bun website/scripts/docs-check.mjs --json       machine-readable
//   bun website/scripts/docs-check.mjs --page index every check for one page
//   bun website/scripts/docs-check.mjs --only words|shape|terms|links|images|code
//
// Exit code 1 if any ERROR-severity check fails, 0 otherwise (WARN never fails).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, "..");
const REPO = resolve(SITE, "..");
const DOCS = join(SITE, "src/content/docs");
const PUBLIC = join(SITE, "public");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const onlyPage = args.includes("--page") ? args[args.indexOf("--page") + 1] : null;
const onlyCheck = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

// ── word budgets, from blueprint.md Part 2 (ceilings, include code) ──────────
const BUDGETS = {
  "index": 900,
  "getting-started/introduction": 350,
  // Quickstart + "Build your first app" consolidated into one build-it-from-
  // scratch guide; it carries both former budgets (2300 combined), and it is
  // mostly code. Raised to 2100 after a from-scratch reader test showed the
  // last two sections needed full context, not fragments.
  "getting-started/quickstart": 2100,
  "getting-started/tour-of-reef": 1400,
  "getting-started/compare": 900,
  "guides/catalog": 1100,
  "guides/transactions": 1000,
  "guides/queries": 1100,
  "guides/live-queries": 800,
  "guides/permissions": 1200,
  "guides/sign-in": 1000,
  "guides/workspaces": 900,
  "guides/deploy": 1100,
  "guides/workers": 800,
  "guides/before-production": 1000,
  // Raised for the entries covering the bare-specifier `main` hang, schema-change
  // watching, and the corrected port-collision advice (which used to tell readers
  // to kill an unrelated process). All cost real debugging time to rediscover.
  "guides/troubleshooting": 1250,
  "concepts/data-model": 1000,
  "concepts/architecture": 900,
  "concepts/time-travel": 700,
  "concepts/effect": 800,
  "concepts/glossary": 2200,
  "reference/client-api": 2600,
  "reference/react": 1200,
  "reference/policy": 2000,
  "reference/errors": 900,
  "reference/server": 2400,
};

// Banned in PROSE (allowed inside code fences, and in Reference tables where
// unavoidable). blueprint.md §1.2 rule 7.
const BANNED = [
  "datom", "isolate", "standing query", "standing read", "materialize",
  "datalog", "novelty", "tempid", "EAVT", "AEVT", "AVET", "VAET",
];
// Softer: a legitimate use exists, but only so many. `peer` is allowed exactly
// once per page — the mandated gloss ("Ramose's code calls it the peer") — so
// one occurrence is the rule being followed and two is a leak.
const BANNED_SOFT = { peer: 1, upsert: 0, idempotent: 0, checkpoint: 0, colo: 0, segment: 0 };

const REFERENCE_PAGES = /^reference\//;
const NO_LEARN = new Set([
  "index", "getting-started/introduction", "getting-started/compare",
  "concepts/glossary", "guides/troubleshooting",
]);

let repoFilesCache = null;
const walkFind = (relPath) => {
  if (!repoFilesCache) {
    const skip = new Set(["node_modules", ".git", "dist", ".alchemy", ".astro"]);
    const collect = (dir) => {
      let out = [];
      for (const f of readdirSync(dir)) {
        if (skip.has(f)) continue;
        const p = join(dir, f);
        try {
          if (statSync(p).isDirectory()) out = out.concat(collect(p));
          else out.push(p);
        } catch { /* unreadable */ }
      }
      return out;
    };
    repoFilesCache = collect(REPO);
  }
  return repoFilesCache.find((p) => p.endsWith("/" + relPath));
};

const findings = [];
const add = (sev, check, page, msg, detail) =>
  findings.push({ sev, check, page, msg, detail });

// ── collect pages ───────────────────────────────────────────────────────────
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const pages = walk(DOCS)
  .filter((p) => p.endsWith(".md") || p.endsWith(".mdx"))
  .map((p) => {
    const slug = relative(DOCS, p).replace(/\.mdx?$/, "");
    return { slug, path: p, src: readFileSync(p, "utf8") };
  })
  .filter((p) => (onlyPage ? p.slug === onlyPage : true))
  .sort((a, b) => a.slug.localeCompare(b.slug));

const allSlugs = new Set(
  walk(DOCS).map((p) => relative(DOCS, p).replace(/\.mdx?$/, "")),
);

// ── parsing helpers ─────────────────────────────────────────────────────────
const splitFrontmatter = (src) => {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { fm: m[1], body: src.slice(m[0].length) } : { fm: "", body: src };
};

const codeFence = /^([ \t]*)```([^\n]*)\n([\s\S]*?)^\1```[ \t]*$/gm;

const splitCode = (body) => {
  const blocks = [];
  let prose = body;
  prose = body.replace(codeFence, (m, indent, info, code) => {
    blocks.push({ info, code });
    return "\n";
  });
  return { prose, blocks };
};

// ONE canonical word count. Prose = body minus code fences, minus JSX/HTML
// tags, minus MDX expressions and comments, minus markdown punctuation.
const countProse = (prose) => {
  let t = prose;
  t = t.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");       // {/* mdx comment */}
  t = t.replace(/<[^>]+>/g, " ");                     // tags
  t = t.replace(/\{[^{}]*\}/g, " ");                  // jsx expressions
  t = t.replace(/^import .*$/gm, " ");                // imports
  t = t.replace(/[`*_>#|]/g, " ");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");      // links → their text
  return t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
};
const countCode = (blocks) =>
  blocks.reduce((n, b) => n + b.code.split(/\s+/).filter(Boolean).length, 0);

// github-slugger-compatible enough for our heading set
const slugify = (s) =>
  s
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");

const headings = (body) => {
  const { prose } = splitCode(body);
  const out = [];
  for (const m of prose.matchAll(/^(#{2,4})\s+(.+?)\s*$/gm)) {
    out.push({ level: m[1].length, text: m[2], id: slugify(m[2]) });
  }
  // Components that render an <h2> with a known id
  if (/<Next\b/.test(body)) out.push({ level: 2, text: "Next", id: "next" });
  return out;
};

// index every page's anchors for cross-page link checking
const anchorIndex = new Map();
for (const p of walk(DOCS).map((f) => ({
  slug: relative(DOCS, f).replace(/\.mdx?$/, ""),
  src: readFileSync(f, "utf8"),
}))) {
  const { body } = splitFrontmatter(p.src);
  const ids = new Set(headings(body).map((h) => h.id));
  // explicit id="..." (glossary uses these)
  for (const m of body.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(m[1]);
  for (const m of body.matchAll(/\{#([^}]+)\}/g)) ids.add(m[1]);
  anchorIndex.set(p.slug, ids);
}

const slugForHref = (href) => {
  const clean = href.split("#")[0].replace(/^\/|\/$/g, "");
  if (clean === "") return "index";
  return clean;
};

// ── the checks ──────────────────────────────────────────────────────────────
const run = (name) => !onlyCheck || onlyCheck === name;
const report = [];

for (const page of pages) {
  const { fm, body } = splitFrontmatter(page.src);
  const { prose, blocks } = splitCode(body);
  const row = { slug: page.slug };

  // WORDS
  if (run("words")) {
    const fmProse = countProse(
      (fm.match(/^\s*(title|description|tagline):\s*(.*)$/gm) || []).join(" "),
    );
    const w = countProse(prose);
    const c = countCode(blocks);
    const total = w + c + (page.slug === "index" ? fmProse : 0);
    const budget = BUDGETS[page.slug];
    Object.assign(row, { prose: w, code: c, total, budget });
    if (budget && total > budget) {
      const over = Math.round(((total - budget) / budget) * 100);
      add(over > 15 ? "ERROR" : "WARN", "words", page.slug,
        `${total} words vs budget ${budget} (+${over}%)`,
        `prose ${w} + code ${c}${page.slug === "index" ? ` + hero ${fmProse}` : ""}`);
    }
  }

  // SHAPE
  if (run("shape")) {
    const title = fm.match(/^title:\s*(.+)$/m)?.[1]?.trim();
    const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!title) add("ERROR", "shape", page.slug, "no frontmatter title");
    if (!desc) add("ERROR", "shape", page.slug, "no frontmatter description");
    else if (desc.length > 160)
      add("WARN", "shape", page.slug, `description ${desc.length} chars (>160)`);
    row.desc = desc?.length ?? 0;

    if (page.slug !== "index") {
      const hasNext = /<Next\b/.test(body);
      if (!hasNext) add("ERROR", "shape", page.slug, "no <Next> block");
      else {
        const tail = body.slice(body.lastIndexOf("<Next"));
        const after = tail.replace(/<Next[\s\S]*?\/>/, "").trim();
        if (after.length > 0)
          add("WARN", "shape", page.slug, "<Next> is not the last element",
            after.slice(0, 60));
        const links = (tail.match(/href:/g) || []).length;
        if (links < 2 || links > 3)
          add("WARN", "shape", page.slug, `<Next> has ${links} links (want 2–3)`);
      }
      const hasLearn = /<Learn\b/.test(body);
      const wantLearn = !NO_LEARN.has(page.slug) && !REFERENCE_PAGES.test(page.slug);
      if (wantLearn && !hasLearn)
        add("WARN", "shape", page.slug, "no <Learn> block (blueprint requires one)");
      if (!wantLearn && hasLearn)
        add("WARN", "shape", page.slug, "<Learn> on a page that should not have one");
      if (REFERENCE_PAGES.test(page.slug) && !/New here\?/.test(body))
        add("WARN", "shape", page.slug, 'reference page missing the "New here?" opener');
      row.learn = hasLearn;
      row.next = hasNext;
    }
    // unused imports
    for (const m of body.matchAll(/^import\s+(\w+)\s+from/gm)) {
      const comp = m[1];
      if (comp[0] !== comp[0].toUpperCase()) continue;
      const uses = (body.match(new RegExp(`<${comp}\\b`, "g")) || []).length;
      if (uses === 0)
        add("ERROR", "shape", page.slug, `imports ${comp} but never uses it`);
    }
    // heading order
    let prev = 2;
    for (const h of headings(body)) {
      if (h.level > prev + 1)
        add("WARN", "shape", page.slug, `heading jumps h${prev}→h${h.level}`, h.text);
      prev = h.level;
    }
  }

  // TERMS
  if (run("terms")) {
    // Inline code spans are code, not prose: blueprint rule 7 bans these words
    // in prose only, and reference tables legitimately name wire fields.
    const proseNoCode = prose.replace(/`[^`]*`/g, " ");
    const hay = proseNoCode.toLowerCase();
    for (const w of BANNED) {
      const re = new RegExp(`\\b${w.toLowerCase()}s?\\b`, "g");
      const hits = [...hay.matchAll(re)];
      if (hits.length) {
        // the glossary is allowed to name the banned word it replaces
        // The glossary and the one Datomic-credit page both legitimately name
        // the words they replace (in a mapping table).
        const namesTheOldWord =
          page.slug === "concepts/glossary" || page.slug === "concepts/data-model";
        const sev = namesTheOldWord ? "WARN" : "ERROR";
        add(sev, "terms", page.slug, `banned prose word "${w}" ×${hits.length}`,
          proseNoCode.slice(Math.max(0, hits[0].index - 50), hits[0].index + 50).replace(/\s+/g, " "));
      }
    }
    for (const [w, allowed] of Object.entries(BANNED_SOFT)) {
      const n = [...hay.matchAll(new RegExp(`\\b${w}s?\\b`, "g"))].length;
      if (n > allowed)
        add("WARN", "terms", page.slug,
          `"${w}" ×${n}${allowed ? ` (${allowed} allowed: the first-use gloss)` : ""}`);
    }
    const datomic = [...proseNoCode.matchAll(/datomic/gi)].length;
    if (datomic && page.slug !== "concepts/data-model")
      add("ERROR", "terms", page.slug, `"Datomic" ×${datomic} (allowed only on concepts/data-model)`);
    row.datomic = datomic;
  }

  // LINKS
  if (run("links")) {
    const hrefs = [
      ...body.matchAll(/href=["']([^"']+)["']/g),
      ...body.matchAll(/\]\(([^)\s]+)\)/g),
    ].map((m) => m[1]);
    for (const href of hrefs) {
      if (!href.startsWith("/")) continue;
      const target = slugForHref(href);
      if (!allSlugs.has(target)) {
        add("ERROR", "links", page.slug, `link to unknown page: ${href}`);
        continue;
      }
      const frag = href.split("#")[1];
      if (frag && !anchorIndex.get(target)?.has(frag))
        add("ERROR", "links", page.slug, `link to missing anchor: ${href}`);
    }
  }

  // IMAGES
  if (run("images")) {
    for (const m of body.matchAll(/<(Shot|img)\b([^>]*)>/g)) {
      const attrs = m[2];
      const src = attrs.match(/src=["']([^"']+)["']/)?.[1];
      const alt = attrs.match(/alt=["']([^"']*)["']/)?.[1];
      if (!src) continue;
      if (src.startsWith("/") && !existsSync(join(PUBLIC, src)))
        add("ERROR", "images", page.slug, `image not on disk: ${src}`);
      if (alt === undefined || alt.trim() === "")
        add("ERROR", "images", page.slug, `image with no alt: ${src}`);
      else if (/^(screenshot|image|picture) of/i.test(alt))
        add("WARN", "images", page.slug, `alt starts with "screenshot of": ${src}`);
      if (m[1] === "Shot" && /\bwidth=/.test(attrs))
        add("WARN", "images", page.slug,
          `<Shot> passes width/height; Shot.astro measures the file — remove them`);
    }
  }

  // CODE provenance
  if (run("code")) {
    // `Cloudflare.Worker`'s `main` is a filesystem path, not a module
    // specifier: a bare "ramose/worker" resolves to nothing, and the failure
    // is silent — the server reports ready and every request hangs forever.
    // This spelling shipped in the docs for months. A block may still show it
    // as a counter-example, but only alongside the spelling that works.
    for (const b of blocks) {
      if (/main:\s*["'`]ramose\/worker["'`]/.test(b.code) &&
          !b.code.includes("import.meta.resolve")) {
        add("ERROR", "code", page.slug,
          'main: "ramose/worker" resolves to nothing and hangs silently',
          'use import.meta.resolve("ramose/worker"), or show both to contrast them');
      }
    }
    for (const b of blocks) {
      const title = b.info.match(/title="([^"]+)"/)?.[1];
      if (!title) continue;
      // A title may cite several ranges, e.g.
      //   title="a/queries.ts:66-68 · app/BoardScreen.tsx:230-232 · Board.tsx:216"
      // Collect every citation; a shown line may come from any of them.
      const cites = [...title.matchAll(/([\w./-]+\.(?:ts|tsx|mjs|json|css)):(\d+)(?:-(\d+))?/g)];
      if (!cites.length) continue;
      let cited = [];
      let bad = false;
      const labels = [];
      for (const [, relPath, aStr, bStr] of cites) {
        // later citations in a title are often written relative to the first
        const candidates = [relPath, join(dirname(cites[0][1]), relPath)];
        const found = candidates.map((c) => join(REPO, c)).find(existsSync)
          ?? walkFind(relPath);
        if (!found) {
          add("ERROR", "code", page.slug, `cited file does not exist: ${relPath}`);
          bad = true;
          continue;
        }
        const lines = readFileSync(found, "utf8").split("\n");
        const a = Number(aStr), bEnd = Number(bStr ?? aStr);
        if (bEnd > lines.length) {
          add("ERROR", "code", page.slug,
            `cited range ${relPath}:${a}-${bEnd} exceeds file (${lines.length} lines)`);
          bad = true;
          continue;
        }
        labels.push(`${relPath}:${a}-${bEnd}`);
        cited.push(...lines.slice(a - 1, bEnd).map((l) => l.trim()).filter(Boolean));
      }
      if (bad || !cited.length) continue;
      const a = cites[0][2], bEnd = cites[0][3] ?? cites[0][2];
      const relPath = labels.join(" · ");
      const shown = b.code
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !/^\/\/\s*…$/.test(l) && !/^\/\/\s*\.\.\.$/.test(l));
      // every shown line that is not an "ours" comment must appear, in order
      // Order is only enforced within a single-citation block; a multi-file
      // title stitches ranges together, so membership is the honest test.
      const single = cites.length === 1;
      let i = 0, missing = [];
      for (const line of shown) {
        const at = single ? cited.indexOf(line, i) : cited.indexOf(line);
        if (at === -1) missing.push(line);
        else if (single) i = at + 1;
      }
      // tolerate added explanatory comment lines
      const realMissing = missing.filter((l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
      if (realMissing.length)
        add("ERROR", "code", page.slug,
          `block titled ${relPath} has ${realMissing.length} line(s) not in the cited range(s)`,
          realMissing.slice(0, 3).join(" ⏎ ").slice(0, 160));
    }
  }

  report.push(row);
}

// unused images (whole-site check, skipped when scoped to one page)
if (run("images") && !onlyPage) {
  const referenced = new Set();
  for (const p of walk(DOCS)) {
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/src=["'](\/[^"']+\.(?:png|gif|jpg|svg))["']/g))
      referenced.add(m[1]);
  }
  // og.png and the favicon are referenced from <head>, not from an <img>.
  const HEAD_ASSETS = new Set(["/og.png", "/favicon.svg"]);
  const onDisk = walk(PUBLIC)
    .map((p) => "/" + relative(PUBLIC, p))
    .filter((p) => /\.(png|gif|jpg)$/.test(p) && !p.startsWith("/brand") && !HEAD_ASSETS.has(p));
  // One consolidated line, not one warning per file: these are kept on purpose
  // (alternate crops, the GIF's source frames) and seven separate warnings
  // drown out the findings that need action.
  const unused = onDisk
    .filter((img) => !referenced.has(img))
    .map((img) => ({ img, kb: Math.round(statSync(join(PUBLIC, img)).size / 1024) }));
  if (unused.length) {
    const kb = unused.reduce((n, u) => n + u.kb, 0);
    add("WARN", "images", "(site)",
      `${unused.length} unused asset(s), ${kb} KB — they still ship`,
      unused.map((u) => `${u.img} (${u.kb} KB)`).join(", "));
  }
}

// ── output ──────────────────────────────────────────────────────────────────
const errors = findings.filter((f) => f.sev === "ERROR");
const warns = findings.filter((f) => f.sev === "WARN");

if (asJson) {
  console.log(JSON.stringify({ pages: report, findings }, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log("\n  page                                    prose  code  total  budget");
  console.log("  " + "─".repeat(70));
  for (const r of report) {
    const over = r.budget && r.total > r.budget;
    console.log(
      `  ${pad(r.slug, 38)} ${pad(r.prose ?? "", 5)} ${pad(r.code ?? "", 5)} ` +
      `${pad(r.total ?? "", 6)} ${pad(r.budget ?? "—", 6)}${over ? "  OVER" : ""}`,
    );
  }
  const totalWords = report.reduce((n, r) => n + (r.total || 0), 0);
  console.log("  " + "─".repeat(70));
  console.log(`  ${pad("TOTAL", 38)} ${pad("", 5)} ${pad("", 5)} ${pad(totalWords, 6)}\n`);

  const group = (list, label) => {
    if (!list.length) return;
    console.log(`  ${label} (${list.length})`);
    for (const f of list)
      console.log(`   • [${f.check}] ${f.page}: ${f.msg}${f.detail ? `\n       ${f.detail}` : ""}`);
    console.log("");
  };
  group(errors, "ERRORS");
  group(warns, "WARNINGS");
  console.log(`  ${errors.length} error(s), ${warns.length} warning(s)\n`);
}

process.exit(errors.length ? 1 : 0);
