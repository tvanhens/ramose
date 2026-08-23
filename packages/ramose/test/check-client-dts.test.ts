/**
 * Pins the `check-client-dts` scan list: `connect.d.ts` is scanned
 * directly and is not on `ALLOWED_HOPS`. An Effect type on
 * `ClientOptions` must match the gate's import regex.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(
  resolve(here, "../../../scripts/check-client-dts.ts"),
  "utf8",
);

const allowedHopsBlock = script.slice(
  script.indexOf("const ALLOWED_HOPS"),
  script.indexOf("const withoutComments"),
);

describe("check-client-dts scan list", () => {
  test("connect.d.ts is on the scanned list", () => {
    expect(script).toContain('join(ROOT, "db/connect.d.ts")');
  });

  test("connect.d.ts and the hatch are not allowlisted", () => {
    expect(allowedHopsBlock).not.toContain("connect.d.ts");
    expect(allowedHopsBlock).not.toContain("Databases.d.ts");
    expect(allowedHopsBlock).not.toContain("effect.d.ts");
    expect(allowedHopsBlock).not.toContain("factory.d.ts");
  });

  test("an Effect type on ClientOptions matches the gate regex", () => {
    const match = script.match(/const EFFECT_IMPORT =\s*([^;]+);/);
    expect(match).not.toBeNull();
    const EFFECT_IMPORT = new Function(`return ${match![1]}`)() as RegExp;
    const leak =
      'import type { Effect } from "effect/Effect";\nexport interface ClientOptions { token?: Effect.Effect<string>; }\n';
    expect(EFFECT_IMPORT.test(leak)).toBe(true);
    expect(EFFECT_IMPORT.test('export interface ClientOptions { url: string; }\n')).toBe(
      false,
    );
  });
});
