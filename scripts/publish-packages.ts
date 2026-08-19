#!/usr/bin/env bun
/**
 * Publish `ramose` to npm.
 *
 * Assumes `bun run build` has already run — the release workflow chains them.
 * Run `scripts/check-release.ts` first; this script deliberately does no
 * validation of its own beyond skipping work that is already done.
 *
 * Idempotent: a version already on the registry is skipped rather than retried,
 * so a release that fails partway (a flaky network, an expired token) can be
 * re-run without hand-editing anything. npm refuses to overwrite a published
 * version anyway — this just turns that hard error into a skip.
 *
 * Auth is whatever the environment provides. In CI with `id-token: write`, npm
 * uses trusted publishing (OIDC) when the package is configured for it and
 * falls back to NODE_AUTH_TOKEN otherwise; `--provenance` works with either.
 *
 * If the account has 2FA set to "auth and writes", an interactive publish needs
 * the browser WebAuthn ceremony (or `--otp` for a TOTP account).
 *
 * Usage:
 *   bun run scripts/publish-packages.ts --dry-run
 *   bun run scripts/publish-packages.ts --provenance
 *   bun run scripts/publish-packages.ts --otp 123456
 */

import { readFileSync } from "node:fs";
import { $ } from "bun";

const PACKAGE_DIR = "packages/ramose";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const provenance = argv.includes("--provenance");
const tag = argv.includes("--tag") ? argv[argv.indexOf("--tag") + 1] : "latest";
const otp = argv.includes("--otp") ? argv[argv.indexOf("--otp") + 1] : process.env.NPM_OTP;

const manifest = JSON.parse(readFileSync(`${PACKAGE_DIR}/package.json`, "utf8")) as {
  name: string;
  version: string;
};
const spec = `${manifest.name}@${manifest.version}`;

if (await alreadyPublished(manifest.name, manifest.version)) {
  console.log(`skip    ${spec} (already on the registry)`);
  process.exit(0);
}

const flags = ["--access", "public", "--tag", tag];
if (provenance) flags.push("--provenance");
if (dryRun) flags.push("--dry-run");
if (otp) flags.push("--otp", otp);

console.log(`publish ${spec}${dryRun ? " (dry run)" : ""}`);

// Spawn npm directly with inherited stdio rather than going through Bun's `$`.
// npm's 2FA flow checks whether it is attached to an interactive terminal: if
// it is, it opens a browser for the WebAuthn ceremony and waits; if it is not,
// it prints the auth URL and fails with EOTP. Through `$` — and especially
// nested a few processes deep, as it is when release.ts drives this — npm took
// the non-interactive branch, so publishing worked by hand but not from the
// scripts.
const proc = Bun.spawn({
  cmd: ["npm", "publish", ...flags],
  cwd: PACKAGE_DIR,
  stdio: ["inherit", "inherit", "inherit"],
});

if ((await proc.exited) !== 0) {
  // A publish can fail purely because the version is already on the registry:
  // it was published by hand, or the pre-check above raced registry
  // propagation, whose read path trails a write by a few seconds. npm reports
  // that as E403 "cannot publish over the previously published versions".
  // Re-check before treating the failure as fatal — the goal is that re-running
  // a release is always safe.
  if (!dryRun && (await alreadyPublished(manifest.name, manifest.version))) {
    console.log(`skip    ${spec} (already on the registry — the publish above was redundant)`);
    process.exit(0);
  }

  // npm has already explained itself on stderr; repeating it just buries it.
  console.error(`\nfailed to publish ${spec} — see the npm error above`);
  process.exit(1);
}

console.log(`\n${dryRun ? "dry run: " : ""}published ${spec}`);

/**
 * True when this exact version is already on the registry.
 *
 * Queries the packument rather than the `name@version` spec: immediately after
 * a publish the spec form can still 404 while the package document already
 * lists the version, because the registry's read path trails its write path.
 * Any error — never published, registry unreachable — is treated as "not
 * published" so the publish itself decides, rather than this check.
 */
async function alreadyPublished(name: string, version: string): Promise<boolean> {
  const result = await $`npm view ${name} versions --json`.quiet().nothrow();
  if (result.exitCode !== 0) return false;
  try {
    const versions = JSON.parse(result.stdout.toString()) as string[] | string;
    return Array.isArray(versions) ? versions.includes(version) : versions === version;
  } catch {
    return false;
  }
}
