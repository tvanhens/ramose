/**
 * Loaded Worker / Transactor bindings for the in-process peer harness.
 *
 * Kept in its own module so it is not a `cloudflare:workers` dependent.
 * `mock.module("cloudflare:workers")` in `harness.ts` invalidates that
 * graph and re-enters the harness; this file keeps the in-flight load, so
 * a hoisted `makePeer` can `await` it instead of reading a TDZ `const`.
 */

type TransactorDoMod = typeof import("../../src/internal/transactor/transactor-do.ts");
type WorkerMod = typeof import("../../src/worker/index.ts");

export type WorkerGraph = {
  transactor: TransactorDoMod;
  worker: WorkerMod;
};

let pending: Promise<WorkerGraph> | undefined;

export const loadWorkerGraph = (): Promise<WorkerGraph> =>
  (pending ??= Promise.all([
    import("../../src/internal/transactor/transactor-do.ts"),
    import("../../src/worker/index.ts"),
  ]).then(([transactor, worker]) => ({ transactor, worker })));
