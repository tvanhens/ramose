#!/usr/bin/env bun
/**
 * Run a release end to end. This is the one definition of the release
 * sequence — CI calls it too, so local and CI cannot drift apart.
 *
 *   bun run release:dry     # everything, but the publish is a dry run
 *   bun run release         # the real thing
 *
 * The individual steps stay runnable on their own for debugging; see
 * CONTRIBUTING.md. What this adds over running them by hand is ordering and,
 * more importantly, cleanup: pinning the `workspace:*` ranges mutates eight
 * manifests, and a failed publish in the middle of a hand-run sequence leaves
 * them pinned in your working tree. Here the restore is in a `finally`, so it
 * happens whether the publish succeeds, fails, or throws.
 *
 * Flags:
 *   --dry-run       pass --dry-run to npm publish (nothing is uploaded)
 *   --tag <name>    npm dist-tag to publish under (default: latest)
 *   --skip-tests    skip typecheck and tests (CI runs them as separate steps)
 *   --allow-dirty   do not require a clean git working tree
 *   --no-provenance do not request a provenance attestation (needed locally,
 *                   where there is no OIDC issuer to attest against)
 *   --otp <code>    one-time password, if the npm account requires 2FA for
 *                   writes. A token that bypasses 2FA is the better answer for
 *                   anything repeated — see CONTRIBUTING.md.
 */

import { readFileSync } from "node:fs";
import { $ } from "bun";

/**
 * Run a command with the terminal genuinely inherited.
 *
 * Bun's `$` is fine for capturing output, but a child that needs to interact
 * with the user must inherit the real stdio. npm's 2FA flow branches on whether
 * it is attached to an interactive terminal: attached, it opens a browser for
 * the WebAuthn ceremony and waits; not attached, it prints the auth URL and
 * fails with EOTP. Publishing worked by hand and not from here precisely
 * because of that branch, so every step that can reach npm goes through this.
 */
async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd, stdio: ["inherit", "inherit", "inherit"] });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new ExitError(`${cmd.join(" ")} exited with code ${exitCode}`);
  }
}

/** A failure whose diagnostics the child already wrote to stderr. */
class ExitError extends Error {
  override name = "ExitError";
}

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string) => (has(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

const dryRun = has("--dry-run");
const skipTests = has("--skip-tests");
const allowDirty = has("--allow-dirty");
const provenance = !has("--no-provenance");
const otp = valueOf("--otp");
const releaseTag = process.env.RELEASE_TAG;

// A prerelease must not land on `latest`, or every plain
// `npm install @ramose/alchemy` picks it up. Derive the dist-tag from the
// version unless one was given explicitly: 0.2.0 → latest, 0.2.0-alpha.1 →
// next. Getting this wrong is not recoverable by republishing — the dist-tag
// can be moved afterwards, but only after users have already installed it.
const version = (
  JSON.parse(readFileSync("packages/core/package.json", "utf8")) as { version: string }
).version;
const isPrerelease = version.includes("-");
const distTag = valueOf("--tag") ?? (isPrerelease ? "next" : "latest");

type Step = { name: string; run: () => Promise<unknown> };

const steps: Step[] = [];

if (!allowDirty) {
  steps.push({
    name: "check working tree is clean",
    run: async () => {
      const status = (await $`git status --porcelain`.quiet()).stdout.toString().trim();
      if (status) {
        throw new Error(
          `working tree is not clean:\n${status}\n\n` +
            "Release from a committed state so the published artifact matches a commit.\n" +
            "Pass --allow-dirty to override.",
        );
      }
    },
  });
}

// npm 11.5.1 is the floor for trusted publishing (OIDC). It also matters for
// interactive publishes: an account whose 2FA is a passkey or security key
// needs the browser-based WebAuthn ceremony, and older npm has no way to run
// it — it falls back to demanding a TOTP code the account cannot produce and
// fails with EOTP. Checked up front because the failure otherwise lands after
// the build and tests have already run.
steps.push({
  name: "check npm version",
  run: async () => {
    const version = (await $`npm --version`.quiet()).stdout.toString().trim();
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    const ok = major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
    if (!ok) {
      throw new Error(
        `npm ${version} is too old to publish reliably (need >= 11.5.1).\n\n` +
          "  - trusted publishing (OIDC) requires 11.5.1+\n" +
          "  - passkey / security-key 2FA needs the browser WebAuthn ceremony,\n" +
          "    which older npm cannot run — it fails with EOTP instead\n\n" +
          "Upgrade with: npm install -g npm@latest",
      );
    }
    console.log(`npm ${version}`);
  },
});

if (!skipTests) {
  steps.push({ name: "typecheck", run: () => run(["bun", "run", "typecheck"]) });
  steps.push({ name: "test", run: () => run(["bun", "run", "test"]) });
}

steps.push({
  name: "build packages",
  run: () => run(["bun", "run", "scripts/build-packages.ts", "--clean"]),
});

steps.push({
  name: "verify release",
  run: () =>
    run([
      "bun",
      "run",
      "scripts/check-release.ts",
      "--built",
      ...(releaseTag ? ["--tag", releaseTag] : []),
    ]),
});

const total = steps.length + 2;

try {
  for (const [index, step] of steps.entries()) {
    console.log(`\n\x1b[1m[${index + 1}/${total}] ${step.name}\x1b[0m`);
    await step.run();
  }

  // From here the manifests are mutated, so everything is wrapped to guarantee
  // the restore. `prepare-publish` pins `workspace:*` to the release version;
  // leaving that pinned in a working tree would be committed by accident
  // sooner or later.
  console.log(`\n\x1b[1m[${total - 1}/${total}] pin internal dependency ranges\x1b[0m`);
  await run(["bun", "run", "scripts/prepare-publish.ts"]);

  try {
    await run(["bun", "run", "scripts/check-release.ts", "--built"]);

    console.log(`\n\x1b[1m[${total}/${total}] publish\x1b[0m`);
    console.log(
      `${version} → dist-tag "${distTag}"${isPrerelease && !valueOf("--tag") ? " (prerelease, kept off latest)" : ""}`,
    );
    const flags = ["--tag", distTag];
    if (dryRun) flags.push("--dry-run");
    if (provenance) flags.push("--provenance");
    if (otp) flags.push("--otp", otp);
    await run(["bun", "run", "scripts/publish-packages.ts", ...flags]);
  } finally {
    console.log("\n\x1b[2mrestoring workspace ranges\x1b[0m");
    await $`bun run scripts/prepare-publish.ts --restore`.quiet();
  }
} catch (error) {
  // A failed command has already written its own diagnostics to stderr, so only
  // its first line is worth repeating — rethrowing would print the whole nested
  // error on top and bury the real message. Errors raised by the steps in this
  // file carry their explanation in the message itself, so print those in full.
  const childFailure =
    error instanceof Error && (error.name === "ShellError" || error.name === "ExitError");
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n\x1b[31m✗ release failed: ${childFailure ? message.split("\n")[0] : message}\x1b[0m`);
  console.error("\x1b[2mworkspace ranges were restored; nothing is left pinned\x1b[0m");
  process.exit(1);
}

console.log(
  dryRun
    ? "\n\x1b[32m✓ dry run complete — nothing was published\x1b[0m"
    : "\n\x1b[32m✓ release published\x1b[0m",
);
