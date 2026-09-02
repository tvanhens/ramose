import type { AuthoritativeOperationInvocation } from "../internal/authorization/index.ts";
import { MAX_INVOKE_BATCH, type InvokeOutcome } from "../internal/transactor/transactor.ts";

export type InvokeDispatch = (
  invocations: readonly AuthoritativeOperationInvocation[],
) => Promise<readonly InvokeOutcome[]>;

type Waiter = {
  readonly invocation: AuthoritativeOperationInvocation;
  settled: boolean;
  outcome?: InvokeOutcome;
  failure?: unknown;
};

type Lane = {
  readonly waiters: Waiter[];
  dispatched: boolean;
};

export const DEFAULT_COALESCE_WINDOW_MS = 2;
const MAX_WAIT_MS = 30_000;

const lanes = new Map<string, Lane>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const settleAll = (waiters: readonly Waiter[], apply: (waiter: Waiter, index: number) => void): void => {
  waiters.forEach((waiter, index) => {
    apply(waiter, index);
    waiter.settled = true;
  });
};

const flushLane = async (key: string, lane: Lane, dispatch: InvokeDispatch): Promise<void> => {
  lane.dispatched = true;
  if (lanes.get(key) === lane) lanes.delete(key);
  const waiters = lane.waiters;
  try {
    const outcomes = await dispatch(waiters.map((w) => w.invocation));
    if (outcomes.length !== waiters.length) {
      throw new Error("transactor returned a mismatched invocation batch");
    }
    settleAll(waiters, (waiter, index) => {
      waiter.outcome = outcomes[index]!;
    });
  } catch (cause) {
    settleAll(waiters, (waiter) => {
      waiter.failure = cause;
    });
  }
};

const settled = (waiter: Waiter): InvokeOutcome => {
  if (waiter.failure !== undefined) throw waiter.failure;
  return waiter.outcome!;
};

export const coalesceInvocation = async (
  key: string,
  invocation: AuthoritativeOperationInvocation,
  dispatch: InvokeDispatch,
  windowMs = DEFAULT_COALESCE_WINDOW_MS,
): Promise<InvokeOutcome> => {
  let lane = lanes.get(key);
  if (lane === undefined || lane.dispatched) {
    lane = { waiters: [], dispatched: false };
    lanes.set(key, lane);
  }
  const waiter: Waiter = { invocation, settled: false };
  lane.waiters.push(waiter);
  if (lane.waiters.length >= MAX_INVOKE_BATCH) {
    await flushLane(key, lane, dispatch);
    return settled(waiter);
  }
  const deadline = Date.now() + MAX_WAIT_MS;
  while (true) {
    await sleep(Math.max(1, windowMs));
    if (waiter.settled) return settled(waiter);
    if (!lane.dispatched) {
      await flushLane(key, lane, dispatch);
      return settled(waiter);
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for a coalesced operation batch");
    }
  }
};
