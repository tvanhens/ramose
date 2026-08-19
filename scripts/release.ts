#!/usr/bin/env bun
/**
 * Run a release end to end. This is the one definition of the release
 * sequence — CI calls it too, so local and CI cannot drift apart.
 *
 *   bun run release 0.2.0       # bump, commit, publish, tag, push
 *   bun run release             # same, at whatever version the manifests say
 *   bun run release:dry 0.2.0   # the whole sequence with no side effects
 *
 * Every step is idempotent, so a run that dies halfway can simply be run
 * again:
 *
 *   - the version bump is skipped when the manifests already say that version
 *   - publishing skips versions already on the registry
 *   - the tag is left alone if it already exists
 *   - pushing an already-pushed tag is a no-op
 *
 * Two things are deliberately not idempotent-by-overwriting: an existing tag
 * is never moved, and an already-published version is never republished. Both
 * would rewrite history someone may already have consumed.
 *
 * Flags:
 *   --dry-run       no side effects at all: nothing is uploaded, committed,
 *                   tagged or pushed, and the manifests are put back
 *   --tag <name>    npm dist-tag (default: latest, or next for a prerelease)
 *   --no-tag        publish without creating or pushing a git tag
 *   --no-push       create the git tag but do not push it
 *   --skip-tests    skip typecheck and tests (CI runs them as separate steps)
 *   --allow-dirty   do not require a clean git working tree
 *   --no-provenance skip the provenance attestation (required locally, where
 *                   there is no OIDC issuer to attest against)
 *   --otp <code>    one-time password, for a TOTP-based npm account
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
 * fails with EOTP. The same applies to git when a signing key needs a
 * passphrase.
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

const VALUE_FLAGS = new Set(["--tag", "--otp"]);

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string) => (has(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

/** The lone positional argument, skipping values that belong to a flag. */
function positional(): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return undefined;
}

const dryRun = has("--dry-run");
const skipTests = has("--skip-tests");
const allowDirty = has("--allow-dirty");
const provenance = !has("--no-provenance");
const shouldTag = !has("--no-tag");
const shouldPush = !has("--no-push");
const otp = valueOf("--otp");
const requestedVersion = positional();
const releaseTag = process.env.RELEASE_TAG;

if (requestedVersion && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(requestedVersion)) {
  console.error(
    `invalid version: ${requestedVersion} (expected e.g. 0.2.0 or 0.2.0-alpha.1, with no leading "v")`,
  );
  process.exit(1);
}

const manifestVersion = () =>
  (JSON.parse(readFileSync("packages/ramose/package.json", "utf8")) as { version: string }).version;

const versionBefore = manifestVersion();
const version = requestedVersion ?? versionBefore;

// A prerelease must not land on `latest`, or every plain `npm install ramose`
// picks it up. Derive the dist-tag from the version unless one was given
// explicitly: 0.2.0 → latest, 0.2.0-alpha.1 → next. The dist-tag can be moved
// afterwards, but only once people have already installed what it pointed at.
const isPrerelease = version.includes("-");
const distTag = valueOf("--tag") ?? (isPrerelease ? "next" : "latest");
const gitTag = `v${version}`;

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
    const npmVersion = (await $`npm --version`.quiet()).stdout.toString().trim();
    const [major = 0, minor = 0, patch = 0] = npmVersion.split(".").map(Number);
    const ok = major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
    if (!ok) {
      throw new Error(
        `npm ${npmVersion} is too old to publish reliably (need >= 11.5.1).\n\n` +
          "  - trusted publishing (OIDC) requires 11.5.1+\n" +
          "  - passkey / security-key 2FA needs the browser WebAuthn ceremony,\n" +
          "    which older npm cannot run — it fails with EOTP instead\n\n" +
          "Upgrade with: npm install -g npm@latest",
      );
    }
    console.log(`npm ${npmVersion}`);
  },
});

if (requestedVersion) {
  steps.push({
    name: `set version to ${version}`,
    run: async () => {
      if (versionBefore === version) {
        console.log(`manifests are already at ${version}`);
        return;
      }
      // --no-commit in a dry run: the manifests still have to move so the rest
      // of the sequence validates the version being released, but a dry run
      // must not leave a commit behind. They are restored at the end.
      await run([
        "bun",
        "run",
        "scripts/set-version.ts",
        version,
        ...(dryRun ? ["--no-commit"] : []),
      ]);
    },
  });
}

if (!skipTests) {
  steps.push({ name: "typecheck", run: () => run(["bun", "run", "typecheck"]) });
  steps.push({ name: "test", run: () => run(["bun", "run", "test"]) });
}

steps.push({
  name: "build the package",
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

const total = steps.length + 1 + (shouldTag && !dryRun ? 1 : 0);
let stepNumber = 0;
const announce = (name: string) => console.log(`\n\x1b[1m[${++stepNumber}/${total}] ${name}\x1b[0m`);

try {
  for (const step of steps) {
    announce(step.name);
    await step.run();
  }

  // Nothing mutates the manifests between here and the publish: collapsing the
  // eight packages into one removed every internal `workspace:*` range, which
  // is what the old pin/restore dance existed for. `check-release.ts` fails the
  // release if a workspace range ever comes back.
  announce("publish");
  console.log(
    `${version} → dist-tag "${distTag}"${isPrerelease && !valueOf("--tag") ? " (prerelease, kept off latest)" : ""}`,
  );
  const flags = ["--tag", distTag];
  if (dryRun) flags.push("--dry-run");
  if (provenance) flags.push("--provenance");
  if (otp) flags.push("--otp", otp);
  await run(["bun", "run", "scripts/publish-packages.ts", ...flags]);

  if (shouldTag && !dryRun) {
    announce(`tag ${gitTag}`);
    await tagAndPush();
  } else if (shouldTag && dryRun) {
    console.log(`\n\x1b[2mdry run: would tag ${gitTag}${shouldPush ? " and push it" : ""}\x1b[0m`);
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
  console.error("\x1b[2mevery step is idempotent — fix the cause and run the same command again\x1b[0m");
  await restoreManifestsIfDryRun();
  process.exit(1);
}

await restoreManifestsIfDryRun();

console.log(
  dryRun
    ? "\n\x1b[32m✓ dry run complete — nothing was published, committed, tagged or pushed\x1b[0m"
    : `\n\x1b[32m✓ ${version} released\x1b[0m`,
);

/**
 * Create the git tag and push it, skipping whatever is already done.
 *
 * An existing tag is never moved. If it points somewhere other than HEAD it is
 * because it marks the commit that was actually released, and a later rerun
 * from a newer HEAD should not drag it forward.
 */
async function tagAndPush(): Promise<void> {
  const head = (await $`git rev-parse HEAD`.quiet()).stdout.toString().trim();
  const existing = await $`git rev-parse -q --verify ${`refs/tags/${gitTag}`}`.quiet().nothrow();

  if (existing.exitCode === 0) {
    const tagged = (await $`git rev-list -n 1 ${gitTag}`.quiet()).stdout.toString().trim();
    if (tagged === head) {
      console.log(`tag ${gitTag} already exists on this commit`);
    } else {
      console.log(
        `tag ${gitTag} already exists on ${tagged.slice(0, 8)} (HEAD is ${head.slice(0, 8)})\n` +
          "leaving it where it is — it marks the commit that was released",
      );
    }
  } else {
    await run(["git", "tag", gitTag]);
    console.log(`tagged ${head.slice(0, 8)} as ${gitTag}`);
  }

  if (!shouldPush) {
    console.log(`--no-push: run \`git push origin HEAD ${gitTag}\` when ready`);
    return;
  }

  // Push the branch alongside the tag. A tag whose commit is on no remote
  // branch is reachable but orphaned in every UI that lists branches.
  const branch = (await $`git rev-parse --abbrev-ref HEAD`.quiet()).stdout.toString().trim();
  await run(["git", "push", "origin", `${branch}`, gitTag]);
  console.log(`pushed ${branch} and ${gitTag}`);
}

/** A dry run moves the manifests without committing; put them back. */
async function restoreManifestsIfDryRun(): Promise<void> {
  if (!dryRun || !requestedVersion || versionBefore === version) return;
  await $`bun run scripts/set-version.ts ${versionBefore} --no-commit`.quiet().nothrow();
  console.log(`\x1b[2mrestored manifests to ${versionBefore}\x1b[0m`);
}
