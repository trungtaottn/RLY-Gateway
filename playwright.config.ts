import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: "list",
  use: {
    browserName: "chromium",
    screenshot: "off",
    video: "off",
    trace: "off",
  },
});
