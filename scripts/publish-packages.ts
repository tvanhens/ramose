#!/usr/bin/env bun

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

const proc = Bun.spawn({
  cmd: ["npm", "publish", ...flags],
  cwd: PACKAGE_DIR,
  stdio: ["inherit", "inherit", "inherit"],
});

if ((await proc.exited) !== 0) {

  if (!dryRun && (await alreadyPublished(manifest.name, manifest.version))) {
    console.log(`skip    ${spec} (already on the registry — the publish above was redundant)`);
    process.exit(0);
  }

  console.error(`\nfailed to publish ${spec} — see the npm error above`);
  process.exit(1);
}

console.log(`\n${dryRun ? "dry run: " : ""}published ${spec}`);

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
