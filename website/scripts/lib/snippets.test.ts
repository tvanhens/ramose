import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bodyMatchesExtract,
  comparableLines,
  extractCitation,
  extractTitle,
  parseTitleCitations,
  REPO,
} from "./snippets.mjs";
import {
  dbErrorTags,
  listedFromFrontmatter,
  ramoseReactRuntime,
  runtimeExports,
  statedRequestErrorCounts,
} from "./facts.mjs";

const tmp = join(REPO, ".tmp-snippets-test");

describe("parseTitleCitations", () => {
  test("named marker", () => {
    expect(parseTitleCitations("examples/reef/src/domain/schema.ts#issue-entity")).toEqual([
      { relPath: "examples/reef/src/domain/schema.ts", marker: "issue-entity", start: null, end: null },
    ]);
  });

  test("line range and trailing note", () => {
    expect(parseTitleCitations("examples/todos/schema.ts:1-9 (annotated)")).toEqual([
      { relPath: "examples/todos/schema.ts", marker: null, start: 1, end: 9 },
    ]);
  });

  test("stitched citations", () => {
    const cites = parseTitleCitations(
      "examples/kv-style/app.ts:34-39 · app.ts:131",
    );
    expect(cites).toHaveLength(2);
    expect(cites[1]).toEqual({
      relPath: "app.ts",
      marker: null,
      start: 131,
      end: 131,
    });
  });
});

describe("extractCitation", () => {
  test("named marker excludes the marker lines", () => {
    mkdirSync(tmp, { recursive: true });
    const file = join(tmp, "marked.ts");
    writeFileSync(
      file,
      [
        "const skip = 1;",
        "// docs:demo",
        "export const boxed = 2;",
        "export const also = 3;",
        "// enddocs:demo",
        "const after = 4;",
        "",
      ].join("\n"),
    );
    const rel = file.slice(REPO.length + 1);
    const got = extractCitation({ relPath: rel, marker: "demo", start: null, end: null });
    expect(got.ok).toBe(true);
    expect(got.text).toBe("export const boxed = 2;\nexport const also = 3;");
    expect(got.start).toBe(3);
    expect(got.end).toBe(4);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("missing marker is an error", () => {
    const got = extractCitation({
      relPath: "examples/todos/schema.ts",
      marker: "no-such-marker",
      start: null,
      end: null,
    });
    expect(got.ok).toBe(false);
    expect(got.error).toContain("#no-such-marker");
  });

  test("line range on a real file", () => {
    const got = extractCitation({
      relPath: "examples/todos/schema.ts",
      marker: null,
      start: 3,
      end: 7,
    });
    expect(got.ok).toBe(true);
    expect(got.text).toContain('Ramose.Entity("todo"');
    expect(got.text).toContain("createdAt");
  });
});

describe("extractTitle + compare", () => {
  test("empty body matches any extract", () => {
    const got = extractTitle("examples/todos/schema.ts:1-9");
    expect(got.ok).toBe(true);
    expect(bodyMatchesExtract("", got.text).ok).toBe(true);
  });

  test("transcribed subset must appear in order", () => {
    const extracted = "a\nb\nc\nd";
    expect(bodyMatchesExtract("b\nd", extracted).ok).toBe(true);
    expect(bodyMatchesExtract("d\nb", extracted).ok).toBe(false);
    expect(bodyMatchesExtract("nope", extracted).missing).toEqual(["nope"]);
  });

  test("ellipsis and comment-only extras are tolerated", () => {
    expect(
      bodyMatchesExtract("foo\n// …\n// note\nbar", "foo\nbar").ok,
    ).toBe(true);
  });
});

describe("comparableLines", () => {
  test("drops blanks and ellipsis comments", () => {
    expect(comparableLines("  a  \n\n// …\n  b")).toEqual(["a", "b"]);
  });
});

describe("facts", () => {
  test("DbError is nine tags including OperationRejected", () => {
    const tags = dbErrorTags();
    expect(tags).toHaveLength(9);
    expect(tags).toContain("OperationRejected");
    expect(tags).toContain("TxRejected");
    expect(tags).not.toContain("NotOne");
  });

  test("runtimeExports reads the db barrel", () => {
    const names = runtimeExports(
      `export { all } from "./Pull.ts";\nexport * as Query from "./q.ts";\nexport { type Db, connect } from "./c.ts";`,
    );
    expect(names.has("all")).toBe(true);
    expect(names.has("Query")).toBe(true);
    expect(names.has("connect")).toBe(true);
    expect(names.has("Db")).toBe(false);
  });

  test("statedRequestErrorCounts reads number words", () => {
    const hits = statedRequestErrorCounts("the nine request errors, not eight request errors");
    expect(hits.map((h) => h.n)).toEqual([9, 8]);
  });

  test("listedFromFrontmatter reads backticked names from description", () => {
    const listed = listedFromFrontmatter(
      "title: React hooks\ndescription: Every export of ramose/react — `useDb`, `useLive` — example first.\n",
    );
    expect(listed).toEqual(["useDb", "useLive"]);
    expect(listedFromFrontmatter("title: x\n")).toEqual([]);
  });

  test("listedFromFrontmatter on the real react page is a non-empty subset of the barrel", () => {
    const src = readFileSync(
      join(REPO, "website/src/content/docs/reference/react.mdx"),
      "utf8",
    );
    const fm = src.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const listed = listedFromFrontmatter(fm);
    const runtime = ramoseReactRuntime();
    expect(listed.length).toBeGreaterThan(0);
    for (const name of listed) expect(runtime.has(name)).toBe(true);
  });
});
