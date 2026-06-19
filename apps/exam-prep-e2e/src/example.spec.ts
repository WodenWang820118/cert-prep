import { expect, test } from '@playwright/test';
import {
  apiBaseUrl,
  devToken,
  expectedSeenPaths,
  installMockExamPrepApi,
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
  const api = await installMockExamPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await page.goto('/');

  await expectRuntimeReady(page);
  await createProject(page, api);
  await uploadDocumentAndExpectDraft(page, api);
  await startRandomQuiz(page, api);
  expect(api.practiceSessionPayload()).toMatchObject({
    mode: 'random_draw',
    question_count: 1,
  });

  await submitWrongAnswerAndOpenReview(page, api);

  expect(api.seenPaths()).toEqual(expectedSeenPaths(api));
});
