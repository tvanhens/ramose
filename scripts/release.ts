#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { isReleaseVersion, VERSION_FILES } from "./lib/version.ts";

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd, stdio: ["inherit", "inherit", "inherit"] });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new ExitError(`${cmd.join(" ")} exited with code ${exitCode}`);
  }
}

class ExitError extends Error {
  override name = "ExitError";
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean" },
    "skip-tests": { type: "boolean" },
    "allow-dirty": { type: "boolean" },
    "no-provenance": { type: "boolean" },
    "no-tag": { type: "boolean" },
    "no-push": { type: "boolean" },
    tag: { type: "string" },
    otp: { type: "string" },
  },
});
if (positionals.length > 1) throw new Error("expected at most one release version");

const dryRun = values["dry-run"] === true;
const skipTests = values["skip-tests"] === true;
const allowDirty = values["allow-dirty"] === true;
const provenance = !values["no-provenance"];
const shouldTag = !values["no-tag"];
const shouldPush = !values["no-push"];
const otp = values.otp;
const requestedVersion = positionals[0];
const releaseTag = process.env.RELEASE_TAG;

if (requestedVersion && !isReleaseVersion(requestedVersion)) {
  console.error(
    `invalid version: ${requestedVersion} (expected e.g. 0.2.0 or 0.2.0-alpha.1, with no leading "v")`,
  );
  process.exit(1);
}

const manifestVersion = () =>
  (JSON.parse(readFileSync("packages/ramose/package.json", "utf8")) as { version: string }).version;

const versionBefore = manifestVersion();
const version = requestedVersion ?? versionBefore;
const originals = dryRun
  ? VERSION_FILES.map((path) => ({ path, contents: readFileSync(path) }))
  : [];

const isPrerelease = version.split("+", 1)[0]!.includes("-");
const distTag = values.tag ?? (isPrerelease ? "next" : "latest");
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

steps.push({
  name: "check release tag",
  run: async () => {
    if (!shouldTag || dryRun) return;
    const tagged = await $`git rev-list -n 1 ${`refs/tags/${gitTag}`}`.quiet().nothrow();
    if (tagged.exitCode !== 0) return;
    const head = (await $`git rev-parse HEAD`.quiet()).stdout.toString().trim();
    if (tagged.stdout.toString().trim() !== head || versionBefore !== version) {
      throw new Error(`tag ${gitTag} already exists on a different release; choose a new version`);
    }
  },
});

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

steps.push({ name: "check documentation", run: () => run(["bun", "run", "check:docs"]) });

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

  announce("publish");
  console.log(
    `${version} → dist-tag "${distTag}"${isPrerelease && !values.tag ? " (prerelease, kept off latest)" : ""}`,
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

  const childFailure =
    error instanceof Error && (error.name === "ShellError" || error.name === "ExitError");
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n\x1b[31m✗ release failed: ${childFailure ? message.split("\n")[0] : message}\x1b[0m`);
  console.error("\x1b[2minspect the completed steps before retrying a failed release\x1b[0m");
  await restoreManifestsIfDryRun();
  process.exit(1);
}

await restoreManifestsIfDryRun();

console.log(
  dryRun
    ? "\n\x1b[32m✓ dry run complete — nothing was published, committed, tagged or pushed\x1b[0m"
    : `\n\x1b[32m✓ ${version} released\x1b[0m`,
);

async function tagAndPush(): Promise<void> {
  const head = (await $`git rev-parse HEAD`.quiet()).stdout.toString().trim();
  const existing = await $`git rev-parse -q --verify ${`refs/tags/${gitTag}`}`.quiet().nothrow();

  if (existing.exitCode === 0) {
    const tagged = (await $`git rev-list -n 1 ${gitTag}`.quiet()).stdout.toString().trim();
    if (tagged === head) {
      console.log(`tag ${gitTag} already exists on this commit`);
    } else {
      throw new Error(`tag ${gitTag} already exists on ${tagged.slice(0, 8)} (HEAD is ${head.slice(0, 8)})`);
    }
  } else {
    await run(["git", "tag", gitTag]);
    console.log(`tagged ${head.slice(0, 8)} as ${gitTag}`);
  }

  if (!shouldPush) {
    console.log(`--no-push: run \`git push origin HEAD ${gitTag}\` when ready`);
    return;
  }

  const branch = (await $`git rev-parse --abbrev-ref HEAD`.quiet()).stdout.toString().trim();
  await run(["git", "push", "origin", `${branch}`, gitTag]);
  console.log(`pushed ${branch} and ${gitTag}`);
}

async function restoreManifestsIfDryRun(): Promise<void> {
  if (!dryRun) return;
  for (const { path, contents } of originals) writeFileSync(path, contents);
  console.log("\x1b[2mrestored manifests and lockfile\x1b[0m");
}
