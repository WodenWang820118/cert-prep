import { defineConfig, devices } from '@playwright/test';

import { ACTION_TIMEOUT_MS, JOURNEY_TEST_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS } from './src/real-engines/budgets.mts';

const outputDir = process.env['CERT_PREP_REAL_ENGINES_PLAYWRIGHT_OUTPUT'];
const baseURL = process.env['BASE_URL'];

if (!outputDir || !baseURL) {
  throw new Error('The real-engine Playwright config requires BASE_URL and CERT_PREP_REAL_ENGINES_PLAYWRIGHT_OUTPUT.');
}

export default defineConfig({
  testDir: './src/real-engines',
  testMatch: 'real-engines.spec.mts',
  outputDir,
  preserveOutput: 'never',
  timeout: JOURNEY_TEST_TIMEOUT_MS,
  globalTimeout: JOURNEY_TEST_TIMEOUT_MS + 60_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL,
    actionTimeout: ACTION_TIMEOUT_MS,
    navigationTimeout: NAVIGATION_TIMEOUT_MS,
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], browserName: 'chromium' },
    },
  ],
});
