import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:5174",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: "3101",
      VITE_PORT: "5174",
      VITE_API_TARGET: "http://127.0.0.1:3101",
      APP_ORIGIN: "http://127.0.0.1:5174",
      DATABASE_PATH: "./work/e2e.sqlite",
    },
  },
  reporter: "list",
});
