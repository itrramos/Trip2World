import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Unit tests only. Integration lives in vitest.integration.config.ts because it
    // requires a real Postgres and Redis.
    include: ["src/**/*.test.ts"],
    exclude: ["src/test/**", "node_modules/**"],
  },
});