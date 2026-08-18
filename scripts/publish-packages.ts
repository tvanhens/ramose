#!/usr/bin/env bun
/**
 * Publish every package to npm, in dependency order.
 *
 * Assumes `bun run build` and `scripts/prepare-publish.ts` have already run —
 * the release workflow chains all three. Run `scripts/check-release.ts` first;
 * this script deliberately does no validation of its own beyond skipping work
 * that is already done.
 *
 * Idempotent: a version already on the registry is skipped rather than retried,
 * so a release that fails partway (a flaky network, an expired token) can be
 * re-run without hand-editing anything. npm refuses to overwrite a published
 * version anyway — this just turns that hard error into a skip.
 *
 * Auth is whatever the environment provides. In CI with `id-token: write`, npm
 * uses trusted publishing (OIDC) for any package configured for it and falls
 * back to NODE_AUTH_TOKEN otherwise; `--provenance` works with either.
 *
 * If the account has 2FA set to "auth and writes", an interactive publish needs
 * a one-time password. `--otp` passes one through, but note that a TOTP code is
 * only valid for ~30s and eight publishes can outlast it — if it expires
 * partway, re-run with a fresh code and the already-published packages are
 * skipped. An automation or granular access token avoids the problem entirely
 * and is what CI uses.
 *
 * Usage:
 *   bun run scripts/publish-packages.ts --dry-run
 *   bun run scripts/publish-packages.ts --provenance
 *   bun run scripts/publish-packages.ts --otp 123456
 */

import { readFileSync } from "node:fs";
import { $ } from "bun";

/** Topological: a package is published after everything it depends on. */
const ORDER = [
  "core",
  "storage",
  "alchemy",
  "transactor",
  "replica",
  "worker",
  "react",
  "better-auth",
] as const;

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const provenance = argv.includes("--provenance");
const tag = argv.includes("--tag") ? argv[argv.indexOf("--tag") + 1] : "latest";
const otp = argv.includes("--otp") ? argv[argv.indexOf("--otp") + 1] : process.env.NPM_OTP;

const published: string[] = [];
const skipped: string[] = [];

for (const pkg of ORDER) {
  const manifest = JSON.parse(readFileSync(`packages/${pkg}/package.json`, "utf8")) as {
    name: string;
    version: string;
  };
  const spec = `${manifest.name}@${manifest.version}`;

  if (await alreadyPublished(manifest.name, manifest.version)) {
    console.log(`skip    ${spec} (already on the registry)`);
    skipped.push(spec);
    continue;
  }

  const flags = ["--access", "public", "--tag", tag];
  if (provenance) flags.push("--provenance");
  if (dryRun) flags.push("--dry-run");
  if (otp) flags.push("--otp", otp);

  console.log(`publish ${spec}${dryRun ? " (dry run)" : ""}`);

  // Spawn npm directly with inherited stdio rather than going through Bun's
  // `$`. npm's 2FA flow checks whether it is attached to an interactive
  // terminal: if it is, it opens a browser for the WebAuthn ceremony and waits;
  // if it is not, it prints the auth URL and fails with EOTP. Through `$` — and
  // especially nested a few processes deep, as it is when release.ts drives
  // this — npm took the non-interactive branch, so publishing worked by hand
  // but not from the scripts.
  const proc = Bun.spawn({
    cmd: ["npm", "publish", ...flags],
    cwd: `packages/${pkg}`,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // npm has already explained itself on stderr; repeating it just buries it.
    console.error(`\nfailed to publish ${spec} — see the npm error above`);
    if (published.length > 0) {
      console.error(`already published this run: ${published.join(", ")}`);
      console.error("re-running skips those, so it is safe to fix and retry");
    }
    process.exit(1);
  }
  published.push(spec);
}

console.log(
  `\n${dryRun ? "dry run: " : ""}${published.length} published, ${skipped.length} skipped`,
);

/**
 * True when this exact version is already on the registry. Any error — the
 * package has never been published, the registry is unreachable — is treated as
 * "not published" so the publish itself decides, rather than this check.
 */
async function alreadyPublished(name: string, version: string): Promise<boolean> {
  const result = await $`npm view ${`${name}@${version}`} version`.quiet().nothrow();
  return result.exitCode === 0 && result.stdout.toString().trim() === version;
}
