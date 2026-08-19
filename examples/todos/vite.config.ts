import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No aliases: `ramose/db` is a real `exports` entry and nothing it
// reaches imports the deploy engine, so the workspace package resolves as-is.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
});
