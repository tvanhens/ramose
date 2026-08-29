import { expect } from "vitest";
import { browserTest } from "./fixtures.ts";

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });

browserTest("runs against the browser's IndexedDB implementation", async ({ browser }) => {
  expect(window).toBe(globalThis);
  expect(indexedDB).toBeInstanceOf(IDBFactory);
  expect(browser.root.isConnected).toBe(true);

  const databaseName = `ramose-browser-smoke-${browser.uniqueId}`;
  const open = indexedDB.open(databaseName, 1);
  open.addEventListener("upgradeneeded", () => {
    open.result.createObjectStore("records", { keyPath: "id" });
  });

  const database = await requestResult(open);
  try {
    const write = database.transaction("records", "readwrite");
    write.objectStore("records").put({ id: "tiny", value: "committed" });
    write.commit();
    await transactionComplete(write);

    const read = database.transaction("records", "readonly");
    const record = await requestResult<{ id: string; value: string } | undefined>(
      read.objectStore("records").get("tiny"),
    );
    await transactionComplete(read);

    expect(record).toEqual({ id: "tiny", value: "committed" });
  } finally {
    database.close();
    await requestResult(indexedDB.deleteDatabase(databaseName));
  }
});
