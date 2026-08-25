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
  test("shows the schema and an inline filtered live query", () => {
    expect(visible).toContain('Entity("todo"');
    expect(visible).toContain("({ title }: { title: string })");
    expect(visible).toContain(
      "useLiveQuery(\n    db,\n    Ramose.Query.from(Todo).where({ title }),\n  )",
    );
    expect(visible).toContain("data?.map");
    expect(visible).not.toContain("const todos");
  });

  test("does not name the site or ship a mark", () => {
    expect(visible).not.toContain("ramose.ai");
    expect(html).not.toContain("viewBox=\"0 0 305 169\"");
  });

  test("does not advertise the retired useLive alias", () => {
    expect(html).not.toMatch(/\buseLive\b/);
  });
});
