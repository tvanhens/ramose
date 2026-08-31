#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractTitle,
  bodyMatchesExtract,
} from "./lib/snippets.mjs";
import {
  dbErrorTags,
  errorTableTags,
  statedRequestErrorCounts,
} from "./lib/facts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, "..");
const REPO = resolve(SITE, "..");
const DOCS = join(SITE, "src/content/docs");
const PUBLIC = join(SITE, "public");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const onlyPage = args.includes("--page") ? args[args.indexOf("--page") + 1] : null;
const onlyCheck = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

const BUDGETS = {
  index: 1000,
  "getting-started/introduction": 400,
  "getting-started/quickstart": 1200,
  "getting-started/connect-an-agent": 900,
  "getting-started/compare": 650,
  "concepts/mental-model": 750,
  "concepts/graph-of-graphs": 700,
  "concepts/data-model": 700,
  "concepts/queries": 600,
  "concepts/operations": 600,
  "concepts/offline": 610,
  "concepts/authorization": 600,
  "concepts/time-travel": 500,
  "concepts/architecture": 600,
  "concepts/effect": 400,
  "concepts/glossary": 900,
  "guides/catalog": 750,
  "guides/subgraphs": 800,
  "guides/queries": 750,
  "guides/transactions": 800,
  "guides/react": 600,
  "guides/permissions": 650,
  "guides/sign-in": 650,
  "guides/mcp": 950,
  "guides/deploy": 650,
  "guides/workers": 550,
  "guides/ssr": 600,
  "guides/before-production": 700,
  "guides/troubleshooting": 900,
  "best-practices/data-modeling": 750,
  "best-practices/graph-boundaries": 750,
  "best-practices/query-performance": 750,
  "best-practices/operations": 750,
  "best-practices/security": 750,
  "reference/schema": 650,
  "reference/client-api": 830,
  "reference/query-language": 600,
  "reference/query-document": 600,
  "reference/operations": 700,
  "reference/react": 630,
  "reference/offline-limits": 860,
  "reference/mcp": 800,
  "reference/policy": 600,
  "reference/errors": 800,
  "reference/server": 700,
};

const BANNED = [
  "datom", "isolate", "standing query", "standing read", "materialize",
  "datalog", "novelty", "tempid", "EAVT", "AEVT", "AVET", "VAET",
];

const BANNED_SOFT = { peer: 0, upsert: 0, idempotent: 0, colo: 0 };

const REFERENCE_PAGES = /^reference\//;
const NO_LEARN = new Set([
  "index", "getting-started/introduction", "getting-started/compare",
  "concepts/glossary", "guides/troubleshooting",
]);

const findings = [];
const add = (sev, check, page, msg, detail) =>
  findings.push({ sev, check, page, msg, detail });

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

const countProse = (prose) => {
  let t = prose;
  t = t.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/\{[^{}]*\}/g, " ");
  t = t.replace(/^import .*$/gm, " ");
  t = t.replace(/[`*_>#|]/g, " ");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  return t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
};
const countCode = (blocks) =>
  blocks.reduce((n, b) => {
    const title = b.info.match(/title="([^"]+)"/)?.[1];
    const extracted = title ? extractTitle(title) : null;
    const src =
      extracted?.ok && extracted.extracted && !b.code.trim()
        ? extracted.text
        : b.code;
    return n + src.split(/\s+/).filter(Boolean).length;
  }, 0);

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

  if (/<Next\b/.test(body)) out.push({ level: 2, text: "Next", id: "next" });
  return out;
};

const anchorIndex = new Map();
for (const p of walk(DOCS).map((f) => ({
  slug: relative(DOCS, f).replace(/\.mdx?$/, ""),
  src: readFileSync(f, "utf8"),
}))) {
  const { body } = splitFrontmatter(p.src);
  const ids = new Set(headings(body).map((h) => h.id));

  for (const m of body.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(m[1]);
  for (const m of body.matchAll(/\{#([^}]+)\}/g)) ids.add(m[1]);
  anchorIndex.set(p.slug, ids);
}

const slugForHref = (href) => {
  const clean = href.split("#")[0].replace(/^\/|\/$/g, "");
  if (clean === "") return "index";
  return clean;
};

const run = (name) => !onlyCheck || onlyCheck === name;
const report = [];

for (const page of pages) {
  const { fm, body } = splitFrontmatter(page.src);
  const { prose, blocks } = splitCode(body);
  const row = { slug: page.slug };

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

    for (const m of body.matchAll(/^import\s+(\w+)\s+from/gm)) {
      const comp = m[1];
      if (comp[0] !== comp[0].toUpperCase()) continue;
      const uses = (body.match(new RegExp(`<${comp}\\b`, "g")) || []).length;
      if (uses === 0)
        add("ERROR", "shape", page.slug, `imports ${comp} but never uses it`);
    }

    let prev = 2;
    for (const h of headings(body)) {
      if (h.level > prev + 1)
        add("WARN", "shape", page.slug, `heading jumps h${prev}→h${h.level}`, h.text);
      prev = h.level;
    }
  }

  if (run("terms")) {

    const proseNoCode = prose.replace(/`[^`]*`/g, " ");
    const hay = proseNoCode.toLowerCase();
    for (const w of BANNED) {
      const re = new RegExp(`\\b${w.toLowerCase()}s?\\b`, "g");
      const hits = [...hay.matchAll(re)];
      if (hits.length) {

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

  if (run("images")) {
    for (const m of body.matchAll(/<img\b([^>]*)>/g)) {
      const attrs = m[1];
      const src = attrs.match(/src=["']([^"']+)["']/)?.[1];
      const alt = attrs.match(/alt=["']([^"']*)["']/)?.[1];
      if (!src) continue;
      if (src.startsWith("/") && !existsSync(join(PUBLIC, src)))
        add("ERROR", "images", page.slug, `image not on disk: ${src}`);
      if (alt === undefined || alt.trim() === "")
        add("ERROR", "images", page.slug, `image with no alt: ${src}`);
      else if (/^(screenshot|image|picture) of/i.test(alt))
        add("WARN", "images", page.slug, `alt starts with "screenshot of": ${src}`);
    }
  }

  if (run("code")) {

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
      const got = extractTitle(title);
      if (!got.extracted) continue;
      if (got.skipped) continue;
      if (!got.ok) {
        add("ERROR", "code", page.slug, got.error);
        continue;
      }
      const match = bodyMatchesExtract(b.code, got.text);
      if (!match.ok) {
        add("ERROR", "code", page.slug,
          `block titled ${got.labels.join(" · ")} has ${match.missing.length} line(s) not in the extract`,
          match.missing.slice(0, 3).join(" ⏎ ").slice(0, 160));
      }
    }
  }

  report.push(row);
}

if (run("facts") && !onlyPage) {
  const tags = dbErrorTags();
  for (const page of pages) {
    const { body } = splitFrontmatter(page.src);
    for (const hit of statedRequestErrorCounts(body)) {
      if (hit.n !== tags.length) {
        add("ERROR", "facts", page.slug,
          `says "${hit.text}" but DbError has ${tags.length} members`,
          tags.join(", "));
      }
    }
    if (page.slug === "reference/errors") {
      const table = errorTableTags(body);
      for (const tag of tags) {
        if (!table.includes(tag))
          add("ERROR", "facts", page.slug, `DbError member ${tag} missing from the errors table`);
      }
    }
    if (/select-less `Query\.from`.{0,80}Ramose\.all\(/s.test(body) &&
        /select-less `Query\.from` returns the full entity/.test(body)) {
      add("ERROR", "facts", page.slug,
        "select-less Query.from is EntityRow (friendly keys), not Ramose.all(N)");
    }
  }
}

if (run("images") && !onlyPage) {
  const referenced = new Set();
  for (const p of walk(DOCS)) {
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/src=["'](\/[^"']+\.(?:png|gif|jpg|svg))["']/g))
      referenced.add(m[1]);
  }

  const HEAD_ASSETS = new Set(["/og.png", "/favicon.svg"]);
  const onDisk = walk(PUBLIC)
    .map((p) => "/" + relative(PUBLIC, p))
    .filter((p) => /\.(png|gif|jpg)$/.test(p) && !p.startsWith("/brand") && !HEAD_ASSETS.has(p));

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

if (run("demos") && !onlyPage) {
  const demos = join(PUBLIC, "demos");
  for (const path of walk(demos).filter((p) => p.endsWith(".html"))) {
    const src = readFileSync(path, "utf8");
    const page = `/demos/${relative(demos, path)}`;
    for (const type of [
      "__bundler/manifest",
      "__bundler/page_order",
      "__bundler/template",
    ]) {
      const marker = `<script type="${type}">`;
      const start = src.indexOf(marker);
      const end = start < 0 ? -1 : src.indexOf("</script>", start + marker.length);
      if (start < 0 || end < 0) {
        add("ERROR", "demos", page, `missing ${type} payload`);
        continue;
      }
      const payload = src.slice(start + marker.length, end).trim();
      try {
        JSON.parse(payload);
      } catch (error) {
        add("ERROR", "demos", page, `${type} payload is not valid JSON`,
          error instanceof Error ? error.message : String(error));
      }
    }
  }
}

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
