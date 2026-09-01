import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    setupFiles: [path.join(directory, "src/test/setup.ts")],
  },
  resolve: {
    alias: {
      "@": path.join(directory, "src"),
    },
  },
});
