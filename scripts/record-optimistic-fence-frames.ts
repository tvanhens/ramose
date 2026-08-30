#!/usr/bin/env bun
/**
 * Regenerate `test/browser/frames/optimistic-fence.*` from the real local stack.
 *
 * This is the only way that fixture may change. It deploys the ordinary Alchemy
 * local stack, seeds a real conformance world, opens one authenticated
 * `/db/:name/replicate` activation, and writes the verbatim wire lines the real
 * Worker produced — so the browser lane replays real server output rather than
 * anything a person wrote by hand, and a protocol change shows up here as a
 * diff instead of surviving unnoticed in a stale file.
 *
 *   bun run record:frames
 *
 * Then review the diff and commit it. Never edit the fixture directly.
 */

const environment: Record<string, string> = {
  ...(process.env as Record<string, string>),
  RAMOSE_RECORD_FRAMES: "1",
  CI: process.env.CI ?? "1",
  ALCHEMY_STATE: process.env.ALCHEMY_STATE ?? "local",
  // The emulator insists on credential-shaped values; nothing is uploaded.
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ??
    "0123456789abcdef0123456789abcdef",
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? "x",
};

const recording = Bun.spawn({
  cmd: ["bun", "test", "--parallel=1", "test/local/record-frames.test.ts"],
  env: environment,
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await recording.exited);
