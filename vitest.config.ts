import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only test/: vitest's default glob would also pick up e2e/*.spec.ts (Playwright's).
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
