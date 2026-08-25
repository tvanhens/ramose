import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "live-queries.html"),
  "utf8",
);

const visible = html.replace(/<[^>]+>/g, "");

describe("live-query social card", () => {
  test("ships the public live-query spelling", () => {
    expect(visible).toContain("useLiveQuery");
    expect(visible).toContain("Query.from");
    expect(visible).toContain(".where");
    expect(visible).toContain(".select");
    expect(visible).toContain(".orderBy");
    expect(visible).toContain("db.live");
    expect(visible).toContain("useLivePull");
    expect(visible).toContain("db.query");
    expect(visible).toContain("db.asOf");
  });

  test("does not advertise the retired useLive alias", () => {
    expect(html).not.toMatch(/\buseLive\b/);
  });
});
