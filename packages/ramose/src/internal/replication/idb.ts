/**
 * The small IndexedDB primitives every replica store family shares.
 *
 * Extracted so the committed-replica adapter and the mutation queue can hold
 * the *same* promise, abort, and key-range semantics rather than two
 * near-identical copies drifting apart — an aborted enqueue and an aborted
 * install must fail in exactly the same inspectable way.
 */

export const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

/**
 * An aborted transaction carries no error of its own, and the requests it
 * cancels bubble their own failure first, so both endings must be reported as
 * one inspectable exception rather than a bare `null`.
 */
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

/** Abort a transaction because this operation intentionally lost a CAS. */
export const abortTransaction = async (transaction: IDBTransaction): Promise<void> => {
  const done = transactionDone(transaction);
  try {
    transaction.abort();
  } catch {
    // Already finished: there is nothing left to roll back, and waiting for an
    // event that has already fired would never resolve.
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

/**
 * Partition keys are built from opaque identifiers that never contain the
 * separator, so a string prefix selects exactly one scope or one database.
 */
export const prefixRange = (prefix: string): IDBKeyRange =>
  IDBKeyRange.bound(prefix, `${prefix}\uffff`);

export const compoundPrefixRange = (prefix: string): IDBKeyRange =>
  IDBKeyRange.bound([prefix], [`${prefix}\uffff`]);
