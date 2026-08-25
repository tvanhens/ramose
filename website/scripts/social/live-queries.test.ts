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
  test("shows the schema, the query, and the React hook", () => {
    expect(visible).toContain('Entity("todo"');
    expect(visible).toContain("Query.from");
    expect(visible).toContain("useLiveQuery");
    expect(visible).toContain("data?.map");
  });

  test("does not name the site or ship a mark", () => {
    expect(visible).not.toContain("ramose.ai");
    expect(html).not.toContain("viewBox=\"0 0 305 169\"");
  });

  test("does not advertise the retired useLive alias", () => {
    expect(html).not.toMatch(/\buseLive\b/);
  });
});
