import { defineConfig } from '@playwright/test';

// lazyclaw acceptance suite. The `tests/phase*` specs exercise the
// CLI, the workflow engine, the providers, the daemon and the web
// demo directly under the `@playwright/test` runner so
// `npx playwright test` covers the published surface end-to-end.

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8080',
    headless: true,
  },
});
