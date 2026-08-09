import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/test/**/*.integration.test.ts"],
    // Suites share one database; running files in parallel would have them deleting each
    // other's fixtures mid-assertion.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});