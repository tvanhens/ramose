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

import { $ } from "bun";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string) => (has(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

const dryRun = has("--dry-run");
const skipTests = has("--skip-tests");
const allowDirty = has("--allow-dirty");
const provenance = !has("--no-provenance");
const distTag = valueOf("--tag") ?? "latest";
const otp = valueOf("--otp");
const releaseTag = process.env.RELEASE_TAG;

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

if (!skipTests) {
  steps.push({ name: "typecheck", run: () => $`bun run typecheck` });
  steps.push({ name: "test", run: () => $`bun run test` });
}

steps.push({ name: "build packages", run: () => $`bun run scripts/build-packages.ts --clean` });

steps.push({
  name: "verify release",
  run: () =>
    releaseTag
      ? $`bun run scripts/check-release.ts --built --tag ${releaseTag}`
      : $`bun run scripts/check-release.ts --built`,
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
  await $`bun run scripts/prepare-publish.ts`;

  try {
    await $`bun run scripts/check-release.ts --built`;

    console.log(`\n\x1b[1m[${total}/${total}] publish\x1b[0m`);
    const flags = ["--tag", distTag];
    if (dryRun) flags.push("--dry-run");
    if (provenance) flags.push("--provenance");
    if (otp) flags.push("--otp", otp);
    await $`bun run scripts/publish-packages.ts ${flags}`;
  } finally {
    console.log("\n\x1b[2mrestoring workspace ranges\x1b[0m");
    await $`bun run scripts/prepare-publish.ts --restore`.quiet();
  }
} catch (error) {
  // The failing command has already written its own diagnostics to stderr.
  // Rethrowing would make Bun print the whole nested ShellError on top of
  // that, which buries the actual message, so report and exit instead.
  const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
  console.error(`\n\x1b[31m✗ release failed: ${message}\x1b[0m`);
  console.error("\x1b[2mworkspace ranges were restored; nothing is left pinned\x1b[0m");
  process.exit(1);
}

console.log(
  dryRun
    ? "\n\x1b[32m✓ dry run complete — nothing was published\x1b[0m"
    : "\n\x1b[32m✓ release published\x1b[0m",
);
