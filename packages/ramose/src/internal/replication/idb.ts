export const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

export const transactionFailure = (transaction: IDBTransaction): DOMException =>
  transaction.error ?? new DOMException("transaction aborted", "AbortError");

export const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transactionFailure(transaction)), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(transactionFailure(transaction)), {
      once: true,
    });
  });

export const commitTransaction = async (transaction: IDBTransaction): Promise<void> => {
  transaction.commit();
  await transactionDone(transaction);
};

export const abortTransaction = async (transaction: IDBTransaction): Promise<void> => {
  const done = transactionDone(transaction);
  try {
    transaction.abort();
  } catch {
    return;
  }
  try {
    await done;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
  }
};

export const abortWithSignal = (
  transaction: IDBTransaction,
  signal: AbortSignal | undefined,
): (() => void) => {
  if (signal === undefined) return () => undefined;
  const abort = (): void => transaction.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
};

export const prefixRange = (prefix: string): IDBKeyRange =>
  IDBKeyRange.bound(prefix, `${prefix}\uffff`);

export const compoundPrefixRange = (prefix: string): IDBKeyRange =>
  IDBKeyRange.bound([prefix], [`${prefix}\uffff`]);
