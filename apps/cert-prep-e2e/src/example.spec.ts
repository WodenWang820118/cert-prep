import { expect, test } from '@playwright/test';
import {
  apiBaseUrl,
  devToken,
  expectedSeenPaths,
  installMockCertPrepApi,
} from './support/mock-api';
import {
  completePracticeQuestions,
  createProject,
  createWorkspaceWithUploadedDocument,
  expectFullExamDocumentOptions,
  expectRandomQuizAvailableCount,
  expectRuntimeReady,
  expectWrongAnswerDashboard,
  expectWrongAnswerReview,
  runMultiPdfBatchUploadScenario,
  runMultiPdfIsolationScenario,
  retryWrongAnswerAndClearReview,
  seedMockApiConfig,
  startDashboardWeakAreaRetry,
  startReviewQuizForAllWrongAnswersAndClearReview,
  startRandomQuiz,
  uploadDocumentAndExpectDraft,
  wrongChoiceForDraft,
} from './support/practice-flow';

test('completes Random Quiz for every playable mocked draft and records wrong answers', async ({
  page,
}) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await createWorkspaceWithUploadedDocument(page, api);
  await startRandomQuiz(page, api);

  expect(api.practiceSessionPayload()).toMatchObject({
    mode: 'random_draw',
    question_count: api.playableDrafts.length,
  });

  await completePracticeQuestions(
    page,
    api,
    api.playableDrafts,
    wrongChoiceForDraft,
  );
  await expectWrongAnswerReview(page, api, api.playableDrafts);

  expect(api.seenPaths()).toEqual(expectedSeenPaths(api));
});

test('keeps Full Exam sessions isolated to the selected PDF document', async ({
  page,
}) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await runMultiPdfIsolationScenario(page, api);
  expect(api.practiceSessionPayloads()).toHaveLength(2);
});

test('uploads multiple PDFs in one batch and starts Full Exam for the selected PDF', async ({
  page,
}) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await runMultiPdfBatchUploadScenario(page, api);
  expect(api.practiceSessionPayloads()).toHaveLength(1);
});

test('matches binary multipart uploads by filename instead of seeded order', async ({
  page,
}) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);
  const [firstDocument, secondDocument] = api.documents;
  if (firstDocument === undefined || secondDocument === undefined) {
    throw new Error('Binary multipart upload matching requires two documents.');
  }

  await page.goto('/');
  await createProject(page, api);
  await expectRuntimeReady(page);

  const binaryPdf = Buffer.from([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0xfe, 0x00,
    0x80,
  ]);
  await page.getByLabel('PDF file').setInputFiles([
    {
      name: secondDocument.filename,
      mimeType: 'application/pdf',
      buffer: binaryPdf,
    },
    {
      name: firstDocument.filename,
      mimeType: 'application/pdf',
      buffer: binaryPdf,
    },
  ]);
  await page.getByRole('button', { name: 'Upload PDF' }).click();

  await expect
    .poll(() => api.uploadedDocuments().map((document) => document.id))
    .toEqual([secondDocument.id, firstDocument.id]);
});

test('retries a wrong answer from Review and clears it after a correct answer', async ({
  page,
}) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await createWorkspaceWithUploadedDocument(page, api);
  await startRandomQuiz(page, api, 1);
  await retryWrongAnswerAndClearReview(page, api);
  expect(api.wrongAnswers()).toHaveLength(0);
});

test('starts a review quiz from all current wrong answers', async ({ page }) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await createWorkspaceWithUploadedDocument(page, api);
  await startRandomQuiz(page, api, 2);
  await startReviewQuizForAllWrongAnswersAndClearReview(page, api);
  expect(api.wrongAnswers()).toHaveLength(0);
});

test('shows project dashboard weak areas and starts a focused retry', async ({
  page,
}) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await createWorkspaceWithUploadedDocument(page, api);
  await startRandomQuiz(page, api, 2);
  await completePracticeQuestions(
    page,
    api,
    api.playableDrafts.slice(0, 2),
    wrongChoiceForDraft,
  );
  await expectWrongAnswerDashboard(page, api);
  await startDashboardWeakAreaRetry(page, api, {
    documentId: api.document.id,
    citationPage: 1,
  });
  expect(api.practiceSessionPayload()).toMatchObject({
    mode: 'review_retry',
  });
});

test('clears document draft practice and review state when switching projects', async ({
  page,
}) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);

  await createWorkspaceWithUploadedDocument(page, api);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('Name').fill(api.secondaryProject.name);
  await page.getByLabel('Description').fill(api.secondaryProject.description);
  await page.getByRole('button', { name: 'Create project' }).click();
  await uploadDocumentAndExpectDraft(page, api, {
    document: api.secondaryDocument,
    draft: api.secondaryDraft,
  });

  await page
    .getByRole('button', { name: new RegExp(api.project.name) })
    .click();
  await expect(
    page
      .locator('.workbench-file-name')
      .getByText(api.document.filename, { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Random Quiz' }).click();
  await startRandomQuiz(page, api, 1);
  await completePracticeQuestions(page, api, [api.draft], wrongChoiceForDraft);
  await page.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByText(api.draft.question)).toBeVisible();

  const requestMarker = api.markRequestLog();
  await page
    .getByRole('button', { name: new RegExp(api.secondaryProject.name) })
    .click();
  await expect(
    page.getByText(
      'Wrong answers will appear here after a practice attempt needs review.',
    ),
  ).toBeVisible();
  await expect(page.getByText(api.draft.question)).toBeHidden();

  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('No weakness data yet.')).toBeVisible();
  await expect(page.getByText(api.draft.question)).toBeHidden();

  await page.getByRole('link', { name: 'Build' }).click();
  await expect(
    page
      .locator('.workbench-file-name')
      .getByText(api.secondaryDocument.filename, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(api.secondaryDraft.question)).toBeVisible();
  await expect(page.getByText(api.document.filename)).toBeHidden();
  await expect(page.getByText(api.draft.question)).toBeHidden();

  await page.getByRole('link', { name: 'Random Quiz' }).click();
  await expectRandomQuizAvailableCount(
    page,
    api.secondaryPlayableDrafts.length,
  );
  await expect(
    page.getByLabel('Session details').getByText('Not started'),
  ).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Random draw size' }).fill('1');
  await page.getByRole('button', { name: 'Start random quiz' }).click();
  await expect
    .poll(() => api.practiceSessionPayload(api.secondaryProject.id))
    .toMatchObject({ mode: 'random_draw', question_count: 1 });

  const pathsAfterSwitch = api.requestLogSince(requestMarker);
  expect(pathsAfterSwitch).toEqual(
    expect.arrayContaining([
      `GET /projects/${api.secondaryProject.id}/documents`,
      `GET /projects/${api.secondaryProject.id}/question-drafts`,
      `GET /projects/${api.secondaryProject.id}/wrong-answers`,
      `GET /projects/${api.secondaryProject.id}/wrong-answers/summary`,
      `POST /projects/${api.secondaryProject.id}/practice-sessions`,
    ]),
  );
  expect(
    pathsAfterSwitch.filter((path) =>
      path.includes(`/projects/${api.project.id}/`),
    ),
  ).toEqual([]);
});

test('excludes incomplete approved-looking drafts from Random Quiz and Full Exam', async ({
  page,
}) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);
  expect(api.incompleteApprovedDrafts.length).toBeGreaterThan(0);

  await createWorkspaceWithUploadedDocument(page, api);

  await page.getByRole('link', { name: 'Random Quiz' }).click();
  await expectRandomQuizAvailableCount(page, api.playableDrafts.length);
  await page.getByRole('spinbutton', { name: 'Random draw size' }).fill('100');
  await page.getByRole('button', { name: 'Start random quiz' }).click();
  await expect.poll(() => api.practiceSessionPayload()).not.toBeNull();
  expect(api.practiceSessionPayload()).toMatchObject({
    mode: 'random_draw',
    question_count: api.playableDrafts.length,
  });

  await expectFullExamDocumentOptions(page, api);
  await page.getByRole('combobox').selectOption(api.fullExamDocument.id);
  await page.getByRole('button', { name: 'Start full exam' }).click();
  await expect
    .poll(() => api.practiceSessionPayload())
    .toMatchObject({ mode: 'full_document' });
  expect(api.practiceSessionPayload()).toMatchObject({
    mode: 'full_document',
    document_id: api.fullExamDocument.id,
    question_count: api.playableDraftsForDocument(api.fullExamDocument.id)
      .length,
  });
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
