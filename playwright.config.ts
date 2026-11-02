import { defineConfig, devices } from "@playwright/test";

// Two servers, scripted model, no outbound calls:
// - 3891: PayPal mode "fake" (the offline demo, e2e/serve.ts);
// - 3892: PayPal mode "sandbox" as hosted, with the fake behind the REST client and a stand-in buyer
//   checkout on 3893 (e2e/serve-sandbox.ts). Only e2e/sandbox.spec.ts runs against it.
const PORT = 3891;
const SANDBOX_PORT = 3892;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "off",
  },
  projects: [
    { name: "chromium", testIgnore: /sandbox\.spec\.ts$/, use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PORT}` } },
    { name: "sandbox-like", testMatch: /sandbox\.spec\.ts$/, use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${SANDBOX_PORT}` } },
  ],
  webServer: [
    {
      command: "node e2e/serve.ts",
      url: `http://127.0.0.1:${PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 20_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "node e2e/serve-sandbox.ts",
      url: `http://127.0.0.1:${SANDBOX_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 20_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
