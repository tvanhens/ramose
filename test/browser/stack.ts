import { spawn, type ChildProcess } from "node:child_process";

export const PEER_PORT = 1341;
export const IDENTITY_PORT = 1342;

export const PEER_ORIGIN = `http://127.0.0.1:${PEER_PORT}`;
export const IDENTITY_ORIGIN = `http://127.0.0.1:${IDENTITY_PORT}`;

const READY_TIMEOUT_MS = 240_000;
const READY_POLL_MS = 250;

const serving = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const body = await response.text();
    return response.ok && body.length > 0;
  } catch {
    return false;
  }
};

const awaitReady = async (child: ChildProcess): Promise<void> => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `ramose: the example stack exited with code ${child.exitCode} before it was ready`,
      );
    }
    if (
      await serving(`${IDENTITY_ORIGIN}/jwks`) &&
      await serving(`${PEER_ORIGIN}/health`)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error("ramose: the example stack did not become reachable");
};

export type ExampleStack = { readonly stop: () => Promise<void> };

export const startExampleStack = async (root: string): Promise<ExampleStack> => {
  const child = spawn("bun", ["run", "dev:graph"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const transcript: string[] = [];
  const remember = (chunk: Buffer): void => {
    transcript.push(chunk.toString());
    if (transcript.length > 200) transcript.shift();
  };
  child.stdout?.on("data", remember);
  child.stderr?.on("data", remember);

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  };

  try {
    await awaitReady(child);
  } catch (cause) {
    await stop();
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)}\n${transcript.join("")}`,
    );
  }
  return { stop };
};
