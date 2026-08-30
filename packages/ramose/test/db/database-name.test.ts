import { describe, expect, test } from "bun:test";
import { DATABASE_NAME_RE, isDatabaseName } from "../../src/db/index.ts";

const OK = ["a", "movies", "A0", "a.b-c_d", "x".repeat(64)];
const BAD = ["", "-leading", ".leading", "has space", "has/slash", "x".repeat(65)];

describe("database names", () => {
  test("the regex is the server Worker's `validDbName`", () => {
    for (const ok of OK) expect(DATABASE_NAME_RE.test(ok)).toBe(true);
    for (const bad of BAD) expect(DATABASE_NAME_RE.test(bad)).toBe(false);
  });

  test("isDatabaseName is the regex as a predicate", () => {
    for (const name of [...OK, ...BAD]) {
      expect(isDatabaseName(name)).toBe(DATABASE_NAME_RE.test(name));
    }
  });
});
