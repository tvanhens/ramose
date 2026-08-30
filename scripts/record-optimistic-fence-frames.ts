#!/usr/bin/env bun

const environment: Record<string, string> = {
  ...(process.env as Record<string, string>),
  RAMOSE_RECORD_FRAMES: "1",
  CI: process.env.CI ?? "1",
  ALCHEMY_STATE: process.env.ALCHEMY_STATE ?? "local",

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
