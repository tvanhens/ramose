export const REQUEST_DEADLINE_MS = 45_000;

export const withRequestDeadline = async <A>(
  exchange: (signal: AbortSignal) => Promise<A>,
  label: string,
  deadlineMs: number = REQUEST_DEADLINE_MS,
): Promise<A> => {
  const controller = new AbortController();
  let expired: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = new Error(`${label} did not answer within ${deadlineMs}ms`);
      controller.abort(expired);
      reject(expired);
    }, deadlineMs);
  });
  try {
    return await Promise.race([

      exchange(controller.signal).catch((error) => {
        throw expired ?? error;
      }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export type CancellableStream = {
  readonly cancelTransport?: () => Promise<void>;
};

const CLOSE_DEADLINE_MS = 5_000;

export const closeObservedStream = async (
  iterator:
    & Partial<Pick<AsyncIterator<unknown>, "return">>
    & CancellableStream,
  deadlineMs: number = CLOSE_DEADLINE_MS,
): Promise<void> => {
  const closed = (async () => {
    await iterator.cancelTransport?.();
    await iterator.return?.(undefined);
  })().then(() => undefined, () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandoned = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  try {
    await Promise.race([closed, abandoned]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
