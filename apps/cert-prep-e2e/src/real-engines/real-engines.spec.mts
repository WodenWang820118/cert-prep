import { expect, test } from '@playwright/test';

import { ACTION_TIMEOUT_MS, JOURNEY_TEST_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS } from './budgets.mts';
import { runRealEnginesJourney } from './journey.mts';

test.describe.configure({ mode: 'serial', timeout: JOURNEY_TEST_TIMEOUT_MS });

test('proves Capture engines on the dev server', async ({ page }) => {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  const report = await runRealEnginesJourney(page);
  expect(report.passed).toBe(true);
  expect(report.phases.map((phase) => phase.phase)).toEqual([
    'provision',
    'pdf-ocr',
    'image-ocr',
    'speech',
    'question-generation',
  ]);
});
