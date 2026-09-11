import type { AstroIntegration } from "astro";
import { fileURLToPath } from "node:url";
import { close, createIndex } from "pagefind";

export const localSearch = (integration: AstroIntegration): AstroIntegration => ({
  ...integration,
  hooks: {
    ...integration.hooks,
    "astro:build:done": async ({ dir, logger }) => {
      try {
        const created = await createIndex();
        if (created.errors.length > 0 || created.index === undefined) {
          throw new Error(`search index creation failed: ${created.errors.join("; ")}`);
        }
        const indexed = await created.index.addDirectory({ path: fileURLToPath(dir) });
        if (indexed.errors.length > 0 || indexed.page_count === 0) {
          throw new Error(`search indexing failed: ${indexed.errors.join("; ")}`);
        }
        const written = await created.index.writeFiles({ outputPath: fileURLToPath(new URL("pagefind/", dir)) });
        if (written.errors.length > 0) throw new Error(written.errors.join("; "));
        logger.info(`Indexed ${indexed.page_count} pages for search`);
      } finally {
        await close();
      }
    },
  },
});
