import { test as baseTest } from "vitest";

export interface BrowserFixture {
  readonly root: HTMLElement;
  readonly uniqueId: string;
}

/** Ordinary per-test browser setup shared by later real-browser suites. */
export const browserTest = baseTest.extend<{ browser: BrowserFixture }>({
  browser: async ({}, use) => {
    const root = document.createElement("div");
    root.dataset.testRoot = crypto.randomUUID();
    document.body.appendChild(root);

    try {
      await use({ root, uniqueId: crypto.randomUUID() });
    } finally {
      root.remove();
    }
  },
});
