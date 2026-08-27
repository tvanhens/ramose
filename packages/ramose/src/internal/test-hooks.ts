/**
 * Test-only checkpoints and admin enablement (issue #390).
 *
 * Inert in production:
 *   - HTTP `/__test__/*` is 404 unless `RAMOSE_TEST_HOOKS=1` and the stage
 *     is not `prod`.
 *   - `checkpoint` / `checkpointSync` are no-ops until a test admin route
 *     arms them in this isolate.
 *
 * Armed checkpoints never invent a successful result. They wait, throw, or
 * pass through to the real operation.
 */

export const TEST_HOOKS_ENV_KEY = "RAMOSE_TEST_HOOKS" as const;

export type TestHooksEnv = {
  readonly RAMOSE_TEST_HOOKS?: string | undefined;
  readonly RAMOSE_STAGE?: string | undefined;
};

export type CheckpointAction = "wait" | "throw";

export type CheckpointScope = "worker" | "transactor" | "replica";

export interface CheckpointArm {
  readonly action: CheckpointAction;
  readonly error?: string | undefined;
  readonly pending: boolean;
}

type Arm = {
  action: CheckpointAction;
  error?: string | undefined;
  wait?: Promise<void>;
  release?: () => void;
  pending: boolean;
};

const arms = new Map<string, Arm>();
let enabled = false;

/** Public `/__test__/*` and isolate enablement. Never true on prod stage. */
export const testHooksEnabled = (env?: TestHooksEnv): boolean => {
  if (env?.RAMOSE_STAGE === "prod") return false;
  return env?.RAMOSE_TEST_HOOKS === "1";
};

/** Turn on checkpoint evaluation in this isolate (called from `/__test__` admin). */
export const enableTestHooks = (): void => {
  enabled = true;
};

export const testHooksArmed = (): boolean => enabled;

export const resetTestHooks = (): void => {
  enabled = false;
  arms.clear();
};

export const armCheckpoint = (
  name: string,
  action: CheckpointAction,
  error?: string,
): void => {
  enableTestHooks();
  if (action === "wait") {
    let release: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    arms.set(name, { action, error, wait, release, pending: false });
    return;
  }
  arms.set(name, { action, error, pending: false });
};

export const releaseCheckpoint = (name: string): void => {
  const arm = arms.get(name);
  arm?.release?.();
  arms.delete(name);
};

export const checkpointStatus = (): Record<string, CheckpointArm> => {
  const out: Record<string, CheckpointArm> = {};
  for (const [name, arm] of arms) {
    out[name] = {
      action: arm.action,
      ...(arm.error !== undefined ? { error: arm.error } : {}),
      pending: arm.pending,
    };
  }
  return out;
};

/**
 * Async barrier. No-op until armed. `wait` parks until `releaseCheckpoint`.
 * `throw` fails the real operation at this boundary.
 */
export const checkpoint = async (name: string): Promise<void> => {
  if (!enabled) return;
  const arm = arms.get(name);
  if (arm === undefined) return;
  if (arm.action === "throw") {
    arms.delete(name);
    throw new Error(arm.error ?? `test checkpoint ${name}`);
  }
  if (arm.action === "wait" && arm.wait !== undefined) {
    arm.pending = true;
    await arm.wait;
  }
};

/**
 * Sync throw-only barrier for `transactionSync` and other sync hosts.
 * `wait` is ignored here — arm `throw` for rollback tests.
 */
export const checkpointSync = (name: string): void => {
  if (!enabled) return;
  const arm = arms.get(name);
  if (arm?.action !== "throw") return;
  arms.delete(name);
  throw new Error(arm.error ?? `test checkpoint ${name}`);
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Isolate-local checkpoint / abort admin for Transactor and Replica DOs.
 * The Worker forwards `/__test__/db/:name/checkpoint|abort` here.
 */
export const handleIsolateTestAdmin = async (
  request: Request,
  path: string,
  abort?: (reason: string) => void,
): Promise<Response | undefined> => {
  if (!path.startsWith("/admin/test/")) return undefined;
  enableTestHooks();
  if (path === "/admin/test/abort" && request.method === "POST") {
    // Drop isolate test state. `ctx.abort` rebuilds the DO instance; miniflare
    // may keep the module, so reset here as well as in the DO constructor.
    resetTestHooks();
    if (abort !== undefined) queueMicrotask(() => abort("test abort"));
    return json({ ok: true, aborted: true });
  }
  if (path === "/admin/test/checkpoint" && request.method === "POST") {
    const body = (await request.json()) as { action?: unknown; name?: unknown; error?: unknown };
    const action = typeof body.action === "string" ? body.action : "";
    const name = typeof body.name === "string" ? body.name : "";
    if (action === "status") return json({ ok: true, checkpoints: checkpointStatus() });
    if (name.length === 0) {
      return json({ error: "checkpoint needs name" }, 400);
    }
    if (action === "arm-wait") {
      armCheckpoint(name, "wait");
      return json({ ok: true, name, action: "wait" });
    }
    if (action === "arm-throw") {
      armCheckpoint(name, "throw", typeof body.error === "string" ? body.error : undefined);
      return json({ ok: true, name, action: "throw" });
    }
    if (action === "release") {
      releaseCheckpoint(name);
      return json({ ok: true, name, action: "release" });
    }
    return json({ error: "checkpoint action must be arm-wait|arm-throw|release|status" }, 400);
  }
  return json({ error: "unknown test admin path" }, 404);
};
