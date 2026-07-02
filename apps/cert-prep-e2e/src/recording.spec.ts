/* eslint-disable playwright/expect-expect */
import { test } from '@playwright/test';
import { apiBaseUrl, devToken, installMockCertPrepApi } from './support/mock-api';
import {
  runMultiPdfIsolationScenario,
  runWrongAnswerAiScenario,
  seedMockApiConfig,
} from './support/practice-flow';

test.use({ video: 'on' });

test('recording practice-complete', async ({ page }) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await runWrongAnswerAiScenario(page, api);
});

test('recording wrong-answer-ai', async ({ page }) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await runWrongAnswerAiScenario(page, api);
});

test('recording multi-pdf-isolation', async ({ page }) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await runMultiPdfIsolationScenario(page, api);
});
