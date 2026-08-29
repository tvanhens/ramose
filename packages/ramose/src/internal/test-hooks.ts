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

export const MAX_CHECKPOINT_RELEASE_DELAY_MS = 30_000;

export const isCheckpointReleaseDelay = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  value <= MAX_CHECKPOINT_RELEASE_DELAY_MS;

export interface CheckpointArm {
  readonly action: CheckpointAction;
  readonly error?: string | undefined;
  readonly pending: boolean;
}

type Arm = {
  action: CheckpointAction;
  error?: string | undefined;
  releaseAfterMs?: number | undefined;
  wait?: Promise<void>;
  release?: () => void;
  timer?: ReturnType<typeof setTimeout> | undefined;
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
  for (const arm of arms.values()) {
    if (arm.timer !== undefined) clearTimeout(arm.timer);
  }
  arms.clear();
};

export const armCheckpoint = (
  name: string,
  action: CheckpointAction,
  error?: string,
  releaseAfterMs?: number,
): void => {
  enableTestHooks();
  if (action === "wait") {
    if (releaseAfterMs !== undefined && !isCheckpointReleaseDelay(releaseAfterMs)) {
      throw new RangeError(
        `checkpoint releaseAfterMs must be between 0 and ${MAX_CHECKPOINT_RELEASE_DELAY_MS}`,
      );
    }
    arms.set(name, {
      action,
      error,
      ...(releaseAfterMs === undefined ? {} : { releaseAfterMs }),
      pending: false,
    });
    return;
  }
  arms.set(name, { action, error, pending: false });
};

export const releaseCheckpoint = (name: string): void => {
  const arm = arms.get(name);
  if (arm?.timer !== undefined) clearTimeout(arm.timer);
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
  if (arm.action === "wait") {
    arm.pending = true;
    // Construct the waiter in the request context that reaches the boundary,
    // not in the earlier admin request that armed it. Workerd forbids safely
    // resuming a Promise created by a completed request context.
    if (arm.wait === undefined) {
      arm.wait = new Promise<void>((resolve) => {
        arm.release = resolve;
      });
    }
    // A same-isolate timer lets real Worker-boundary tests release the exact
    // arm they reached even when the local runtime dispatches concurrent admin
    // requests to another isolate. It exists only for explicitly armed test
    // hooks and starts after the real boundary is reached.
    if (arm.releaseAfterMs !== undefined) {
      arm.timer = setTimeout(() => releaseCheckpoint(name), arm.releaseAfterMs);
    }
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

/** Injected only by the repository's explicit source-only testing assembly. */
export const testRuntimeBoundaries = Object.freeze({
  checkpoint,
  checkpointSync,
});

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
    const body = (await request.json()) as {
      action?: unknown;
      name?: unknown;
      error?: unknown;
      releaseAfterMs?: unknown;
    };
    const action = typeof body.action === "string" ? body.action : "";
    const name = typeof body.name === "string" ? body.name : "";
    if (action === "status") return json({ ok: true, checkpoints: checkpointStatus() });
    if (name.length === 0) {
      return json({ error: "checkpoint needs name" }, 400);
    }
    if (action === "arm-wait") {
      const releaseAfterMs = body.releaseAfterMs;
      if (
        releaseAfterMs !== undefined &&
        !isCheckpointReleaseDelay(releaseAfterMs)
      ) {
        return json({
          error: `checkpoint releaseAfterMs must be between 0 and ${MAX_CHECKPOINT_RELEASE_DELAY_MS}`,
        }, 400);
      }
      armCheckpoint(name, "wait", undefined, releaseAfterMs as number | undefined);
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
