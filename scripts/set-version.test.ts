import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("version changes update both manifests and the frozen lockfile", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ramose-version-"));
  try {
    mkdirSync(join(cwd, "packages/ramose"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "release-fixture", private: true, version: "0.1.0", workspaces: ["packages/*"],
    }));
    writeFileSync(join(cwd, "packages/ramose/package.json"), JSON.stringify({ name: "ramose", version: "0.1.0" }));
    const initial = Bun.spawnSync([process.execPath, "install", "--lockfile-only", "--ignore-scripts"], { cwd });
    expect(initial.exitCode).toBe(0);
    const result = Bun.spawnSync([
      process.execPath, join(import.meta.dir, "set-version.ts"), "0.2.0-rc.1", "--no-commit",
    ], { cwd });
    expect(result.exitCode).toBe(0);
    for (const path of ["package.json", "packages/ramose/package.json"]) {
      expect(JSON.parse(readFileSync(join(cwd, path), "utf8")).version).toBe("0.2.0-rc.1");
    }
    const lock = Bun.JSONC.parse(readFileSync(join(cwd, "bun.lock"), "utf8")) as {
      workspaces: Record<string, { version: string }>;
    };
    expect(lock.workspaces["packages/ramose"].version).toBe("0.2.0-rc.1");
    const frozen = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], { cwd });
    expect(frozen.exitCode).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.each(["release.ts", "set-version.ts", "publish-packages.ts", "check-release.ts"])(
  "%s rejects misspelled options before starting work", (script) => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, script), "--dry-rnu"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Unknown option");
  },
);
