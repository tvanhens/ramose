import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluate,
  scanFile,
  type Allowlist,
  type Pattern,
} from "./check-test-doubles.ts";

const scripted: Pattern = {
  id: "scriptedPeer",
  re: /\bscriptedPeer\b/,
  note: "use the local peer",
};

describe("check-test-doubles", () => {
  test("flags a forbidden identifier", () => {
    const dir = mkdtempSync(join(tmpdir(), "doubles-"));
    const file = join(dir, "sample.test.ts");
    writeFileSync(file, 'const peer = scriptedPeer();\n');
    const hits = scanFile(file, [scripted]);
    expect(hits.map((h) => h.id)).toEqual(["scriptedPeer"]);
    expect(hits[0]?.line).toBe(1);
  });

  test("allowlisted files pass; new files fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "doubles-"));
    const allowed = join(dir, "old.test.ts");
    const fresh = join(dir, "new.test.ts");
    writeFileSync(allowed, "scriptedPeer()\n");
    writeFileSync(fresh, "scriptedPeer()\n");
    const hits = [...scanFile(allowed, [scripted]), ...scanFile(fresh, [scripted])].map((h) => ({
      ...h,
      file: h.file.endsWith("old.test.ts") ? "old.test.ts" : "new.test.ts",
    }));
    const allowlist: Allowlist = { files: { "old.test.ts": ["scriptedPeer"] } };
    const result = evaluate(hits, allowlist);
    expect(result.newHits.map((h) => h.file)).toEqual(["new.test.ts"]);
    expect(result.stale).toEqual([]);
  });

  test("stale allowlist entries fail so the list shrinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "doubles-"));
    mkdirSync(dir, { recursive: true });
    const clean = join(dir, "clean.test.ts");
    writeFileSync(clean, "export const ok = 1;\n");
    const hits = scanFile(clean, [scripted]).map((h) => ({ ...h, file: "clean.test.ts" }));
    const result = evaluate(hits, { files: { "clean.test.ts": ["scriptedPeer"] } });
    expect(result.stale).toEqual(["clean.test.ts"]);
  });

  test("does not flag Alchemy in-memory deploy state", () => {
    const dir = mkdtempSync(join(tmpdir(), "doubles-"));
    const file = join(dir, "fixtures.ts");
    writeFileSync(file, 'state: Alchemy.inMemoryState()\n');
    expect(scanFile(file)).toEqual([]);
  });
});
