#!/usr/bin/env bun
/**
 * Build every publishable package into `packages/<name>/dist`, then stage the
 * files npm needs alongside it (LICENSE, NOTICE, README.md).
 *
 * Build order matters. Each package resolves its `@ramose/*` imports through the
 * dependency's `exports.types` (→ `dist/*.d.ts`), so a dependency has to be
 * built before anything that imports it. ORDER below is a topological sort of
 * the workspace graph; keep it that way when adding a package.
 *
 * The staged LICENSE/NOTICE are generated artifacts — gitignored and rewritten
 * on every build, so the root LICENSE stays the single source of truth. A
 * README is generated only for packages that do not already have a written one;
 * those are committed and left alone. `--clean` also wipes the dist
 * directories, which is what CI does so a stale artifact can never end up in a
 * tarball.
 */

import { existsSync } from "node:fs";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { $ } from "bun";

/** Topological: dependencies before dependents. */
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

const clean = process.argv.includes("--clean");

if (clean) {
  for (const pkg of ORDER) {
    await rm(`packages/${pkg}/dist`, { recursive: true, force: true });
  }
  console.log(`cleaned ${ORDER.length} dist directories`);
}

for (const pkg of ORDER) {
  const started = performance.now();
  await $`bunx tsc -p packages/${pkg}/tsconfig.build.json`;
  const ms = Math.round(performance.now() - started);
  console.log(`built @ramose/${pkg} (${ms}ms)`);
}

// Stage the legal files and a README into each package directory. `files` in
// each manifest lists these, so they have to exist on disk before `npm pack`.
for (const pkg of ORDER) {
  const dir = `packages/${pkg}`;
  await copyFile("LICENSE", `${dir}/LICENSE`);
  await copyFile("NOTICE", `${dir}/NOTICE`);

  // Only generate a README where the package does not already have a written
  // one. A hand-written README is always better than the generated stub, and
  // clobbering it would be silent — it is the package's npm landing page.
  if (!existsSync(`${dir}/README.md`)) {
    const manifest = JSON.parse(await readFile(`${dir}/package.json`, "utf8")) as {
      name: string;
      description: string;
    };
    await writeFile(`${dir}/README.md`, readme(manifest.name, manifest.description));
  }
}

console.log(`\nbuilt ${ORDER.length} packages`);

function readme(name: string, description: string): string {
  return `# ${name}

${description}

Part of [Ramose](https://ramose.ai) — an immutable, Datomic-inspired graph
database for Cloudflare (Workers + Durable Objects + R2), built on Effect.

## Install

\`\`\`sh
npm install ${name}
\`\`\`

\`bun add\` and \`pnpm add\` work the same. Ramose is pre-release: expect the API
to change.

## Docs

Full documentation lives at **[ramose.ai](https://ramose.ai)**. Start with the
[Quickstart](https://ramose.ai/getting-started/quickstart/).

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
`;
}
