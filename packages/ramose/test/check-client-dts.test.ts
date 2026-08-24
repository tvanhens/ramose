/**
 * Pins the `check-client-dts` scan list: `connect.d.ts` is scanned
 * directly and is not on `ALLOWED_HOPS`. An Effect type on
 * `ClientOptions` must match the gate's import regex.
 *
 * After #222 the query hover types sit two hops from the barrel
 * (`query/index.d.ts` → `query/fluent.d.ts` / `query/query.d.ts`). The
 * gate follows hops transitively and lists those files so a leak into
 * `FluentQuery` / `QueryObject` cannot ship undetected.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EFFECT_IMPORT,
  followHops,
  withoutComments,
} from "../../../scripts/check-client-dts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(
  resolve(here, "../../../scripts/check-client-dts.ts"),
  "utf8",
);

const allowedHopsBlock = script.slice(
  script.indexOf("const ALLOWED_HOPS"),
  script.indexOf("const withoutComments"),
);

/** Dist emit ends with an un-newlined sourceMappingURL; the gate strips `//` comments. */
const SOURCEMAP = "//# sourceMappingURL=fixture.d.ts.map";
const EFFECT_LEAK = 'import type { Effect } from "effect/Effect"';

const writeDts = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${body}\n${SOURCEMAP}`);
};

describe("check-client-dts scan list", () => {
  test("connect.d.ts is on the scanned list", () => {
    expect(script).toContain('join(ROOT, "db/connect.d.ts")');
  });

  test("query/fluent.d.ts and query/query.d.ts are on the scanned list", () => {
    expect(script).toContain('join(ROOT, "db/query/fluent.d.ts")');
    expect(script).toContain('join(ROOT, "db/query/query.d.ts")');
  });

  test("connect.d.ts and the hatch are not allowlisted", () => {
    expect(allowedHopsBlock).not.toContain("connect.d.ts");
    expect(allowedHopsBlock).not.toContain("Databases.d.ts");
    expect(allowedHopsBlock).not.toContain("effect.d.ts");
    expect(allowedHopsBlock).not.toContain("factory.d.ts");
  });

  test("query hover declarations are not allowlisted", () => {
    expect(allowedHopsBlock).not.toContain("query/fluent.d.ts");
    expect(allowedHopsBlock).not.toContain("query/query.d.ts");
    expect(allowedHopsBlock).not.toContain("fluent.d.ts");
  });

  test("an Effect type on ClientOptions matches the gate regex", () => {
    const leak =
      'import type { Effect } from "effect/Effect";\nexport interface ClientOptions { token?: Effect.Effect<string>; }\n';
    expect(EFFECT_IMPORT.test(leak)).toBe(true);
    expect(EFFECT_IMPORT.test('export interface ClientOptions { url: string; }\n')).toBe(
      false,
    );
  });
});

describe("check-client-dts two-hop query surface", () => {
  const fixture = mkdtempSync(join(tmpdir(), "check-client-dts-"));
  const dbDist = join(fixture, "db");
  const barrel = join(dbDist, "index.d.ts");
  const queryIndex = join(dbDist, "query/index.d.ts");
  const fluent = join(dbDist, "query/fluent.d.ts");
  const query = join(dbDist, "query/query.d.ts");

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  const writeCleanGraph = (): void => {
    writeDts(barrel, 'export type { FluentQuery, QueryObject } from "./query/index.js";');
    writeDts(
      queryIndex,
      'export type { FluentQuery, WhereEq } from "./fluent.js";\nexport type { QueryObject, Cursor, Page } from "./query.js";',
    );
    writeDts(fluent, "export type FluentQuery = unknown;\nexport type WhereEq = unknown;");
    writeDts(
      query,
      "export type QueryObject = unknown;\nexport type Cursor = unknown;\nexport type Page = unknown;",
    );
  };

  test("query/fluent.d.ts and query/query.d.ts are reached from the barrel", () => {
    writeCleanGraph();
    const { leaks, reached } = followHops([barrel], dbDist);
    expect(leaks).toEqual([]);
    expect(reached.some((file) => file.endsWith("query/fluent.d.ts"))).toBe(true);
    expect(reached.some((file) => file.endsWith("query/query.d.ts"))).toBe(true);
  });

  test("a two-hop Effect leak into fluent.d.ts / query.d.ts fails the gate", () => {
    writeCleanGraph();
    expect(followHops([barrel], dbDist).leaks).toEqual([]);

    // Dist files end with an un-newlined sourceMappingURL. Appending without
    // a leading newline is comment-stripped — prepend a newline.
    writeFileSync(fluent, `${readFileSync(fluent, "utf8")}\n${EFFECT_LEAK}`);
    const fluentLeaks = followHops([barrel], dbDist).leaks;
    expect(fluentLeaks.some((leak) => leak.includes("query/fluent.d.ts"))).toBe(true);

    writeCleanGraph();
    writeFileSync(query, `${readFileSync(query, "utf8")}\n${EFFECT_LEAK}`);
    const queryLeaks = followHops([barrel], dbDist).leaks;
    expect(queryLeaks.some((leak) => leak.includes("query/query.d.ts"))).toBe(true);
  });

  test("mutation text without a leading newline is comment-stripped", () => {
    writeCleanGraph();
    const stripped = withoutComments(`${readFileSync(fluent, "utf8")}${EFFECT_LEAK}`);
    expect(EFFECT_IMPORT.test(stripped)).toBe(false);
    const withNewline = withoutComments(`${readFileSync(fluent, "utf8")}\n${EFFECT_LEAK}`);
    expect(EFFECT_IMPORT.test(withNewline)).toBe(true);
  });
});
