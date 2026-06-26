import { expect, test } from '@playwright/test';
import {
  apiBaseUrl,
  devToken,
  expectedSeenPaths,
  installMockCertPrepApi,
} from './support/mock-api';
import {
  createProject,
  expectRuntimeReady,
  seedMockApiConfig,
  startRandomQuiz,
  submitWrongAnswerAndOpenReview,
  uploadDocumentAndExpectDraft,
} from './support/practice-flow';

test('completes the local practice loop with a mocked API', async ({
  page,
}) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await page.goto('/');

  await createProject(page, api);
  await expectRuntimeReady(page);
  await uploadDocumentAndExpectDraft(page, api);
  await startRandomQuiz(page, api);
  expect(api.practiceSessionPayload()).toMatchObject({
    mode: 'random_draw',
    question_count: 1,
  });

  await submitWrongAnswerAndOpenReview(page, api);

  expect(api.seenPaths()).toEqual(expectedSeenPaths(api));
});

test('opens the runtime manager before project creation', async ({ page }) => {
  await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await page.goto('/runtime');

  await expect(
    page.getByRole('heading', { name: 'Manage runtime' }),
  ).toBeVisible();
  await expect(page.getByText('Python backend')).toBeVisible();
  await expect(page.getByText('Select or create a project.')).toBeHidden();
});
