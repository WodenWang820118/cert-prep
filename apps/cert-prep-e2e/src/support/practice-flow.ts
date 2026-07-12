import { expect, type Page } from '@playwright/test';
import type { DocumentRead, ProjectRead } from '@cert-prep/api';
import type {
  CompleteQuestionDraft,
  CompleteQuestionDraftWithExcerpt,
  MockCertPrepApi,
} from './mock-api';

export async function seedMockApiConfig(
  page: Page,
  baseUrl: string,
  token: string,
): Promise<void> {
  await page.addInitScript(
    ([apiBaseUrl, devToken]) => {
      localStorage.setItem('certPrepApiBaseUrl', apiBaseUrl);
      localStorage.setItem('certPrepApiToken', devToken);
    },
    [baseUrl, token],
  );
}

export async function expectRuntimeReady(page: Page): Promise<void> {
  await expect(page.locator('h1', { hasText: 'Cert Prep' })).toBeVisible();
  await expect(page.getByText('qwen3.5:4b')).toBeVisible();
  await expect(page.getByText('fake')).toBeVisible();
  await expect(page.getByText('paddle / gpu:0')).toBeVisible();
}

export async function createProject(
  page: Page,
  api: MockCertPrepApi,
  project: ProjectRead = api.project,
): Promise<void> {
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('Name').fill(project.name);
  await page.getByLabel('Description').fill(project.description);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('button', { name: new RegExp(project.name) }),
  ).toBeVisible();
}

export async function uploadDocumentAndExpectDraft(
  page: Page,
  api: MockCertPrepApi,
  options: {
    readonly document?: DocumentRead;
    readonly draft?: CompleteQuestionDraftWithExcerpt;
  } = {},
): Promise<void> {
  const document = options.document ?? api.document;
  const draft = options.draft ?? api.draft;

  await page.getByLabel('PDF file').setInputFiles({
    name: document.filename,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% mocked text pdf\n'),
  });
  await page.getByRole('button', { name: 'Upload PDF' }).click();
  await expect(
    page
      .locator('.workbench-file-name')
      .getByText(document.filename, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('paddle_ocr_gpu')).toBeVisible();
  await expect(page.getByText('gpu:0').last()).toBeVisible();
  await expect(page.getByText(draft.question)).toBeVisible();
  await expect(page.getByText(draft.source_excerpt)).toBeVisible();
  await expect(
    page
      .getByTestId('draft-question-card')
      .filter({ hasText: draft.question })
      .getByText('Playable', { exact: true }),
  ).toBeVisible();
}

export async function createWorkspaceWithUploadedDocument(
  page: Page,
  api: MockCertPrepApi,
  options: {
    readonly project?: ProjectRead;
    readonly document?: DocumentRead;
    readonly draft?: CompleteQuestionDraftWithExcerpt;
  } = {},
): Promise<void> {
  const project = options.project ?? api.project;
  await page.goto('/');
  await createProject(page, api, project);
  await expectRuntimeReady(page);
  await uploadDocumentAndExpectDraft(page, api, options);
}

export async function startRandomQuiz(
  page: Page,
  api: MockCertPrepApi,
  questionCount = api.playableDrafts.length,
): Promise<void> {
  await page.getByRole('link', { name: 'Random Quiz' }).click();
  await expectRandomQuizAvailableCount(page, api.playableDrafts.length);
  await page
    .getByRole('spinbutton', { name: 'Random draw size' })
    .fill(String(questionCount));
  await page.getByRole('button', { name: 'Start random quiz' }).click();
  await expectCurrentSessionVisible(page, api);
}

export async function startFullExam(
  page: Page,
  api: MockCertPrepApi,
  document = api.fullExamDocument,
): Promise<void> {
  const questionCount = api.playableDraftsForDocument(document.id).length;

  await page.getByRole('link', { name: 'Full Exam' }).click();
  await expect(page.getByRole('heading', { name: 'Full Exam' })).toBeVisible();
  const documentSelect = page
    .getByRole('region', { name: 'Source Document' })
    .getByRole('combobox');
  await expect(
    documentSelect.locator(`option[value="${document.id}"]`),
  ).toHaveCount(1);
  await documentSelect.selectOption(document.id);
  await expect(
    page.getByText(`${questionCount} questions in selected document`),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start full exam' }).click();
  await expectCurrentSessionVisible(page, api);
}

export async function selectProjectInRail(
  page: Page,
  project: ProjectRead,
): Promise<void> {
  await page.getByRole('button', { name: new RegExp(project.name) }).click();
}

export async function selectActiveDocument(
  page: Page,
  document: DocumentRead,
): Promise<void> {
  await page.getByRole('link', { name: 'Build' }).click();
  await page.getByLabel('Project document library').selectOption(document.id);
  await expect(
    page
      .locator('.workbench-file-name')
      .getByText(document.filename, { exact: true }),
  ).toBeVisible();
}

export async function runPracticeCompleteScenario(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  await createWorkspaceWithUploadedDocument(page, api);
  await startRandomQuiz(page, api);
  await completePracticeQuestions(
    page,
    api,
    api.playableDrafts,
    (draft) => draft.answer,
  );
}

export async function runWrongAnswerAiScenario(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  await createWorkspaceWithUploadedDocument(page, api);
  await startRandomQuiz(page, api);
  await completePracticeQuestions(
    page,
    api,
    api.playableDrafts,
    wrongChoiceForDraft,
  );
  await expectWrongAnswerReview(page, api, api.playableDrafts);
}

export async function runMultiPdfIsolationScenario(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  await createWorkspaceWithUploadedDocument(page, api);
  await selectProjectInRail(page, api.project);
  const alternateDocument = api.documents[1];
  const defaultDocument = api.documents[0];
  if (alternateDocument === undefined || defaultDocument === undefined) {
    throw new Error('Multi-PDF isolation requires two mocked documents.');
  }

  for (const document of [alternateDocument, defaultDocument]) {
    const selectedDocumentDrafts = api.playableDraftsForDocument(document.id);
    await selectActiveDocument(page, document);
    await startFullExam(page, api, document);
    expectFullExamSessionToUseOnlyDocument(api, document);
    await completePracticeQuestions(
      page,
      api,
      selectedDocumentDrafts,
      (draft) => draft.answer,
    );
    expect(api.wrongAnswers()).toHaveLength(0);
  }
}

export async function runMultiPdfBatchUploadScenario(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  const [firstDocument, secondDocument] = api.documents;
  if (firstDocument === undefined || secondDocument === undefined) {
    throw new Error('Multi-PDF batch upload requires two mocked documents.');
  }

  await page.goto('/');
  await createProject(page, api);
  await expectRuntimeReady(page);

  const requestMarker = api.markRequestLog();
  await page.getByLabel('PDF file').setInputFiles(
    [firstDocument, secondDocument].map((document) => ({
      name: document.filename,
      mimeType: 'application/pdf',
      buffer: Buffer.from(`%PDF-1.4\n% mocked ${document.id} pdf\n`),
    })),
  );
  await page.getByRole('button', { name: 'Upload PDF' }).click();

  await expectDocumentLibraryOption(page, firstDocument);
  await expectDocumentLibraryOption(page, secondDocument);
  expect(
    api
      .requestLogSince(requestMarker)
      .filter(
        (path) => path === `POST /projects/${api.project.id}/documents`,
      ),
  ).toHaveLength(2);

  for (const document of [firstDocument, secondDocument]) {
    await selectDocumentFromLibrary(page, document);
    const [draft] = api.playableDraftsForDocument(document.id);
    if (draft === undefined) {
      throw new Error(`Document ${document.id} needs a playable mocked draft.`);
    }
    await expectAiInferredPlayableDraft(page, draft);
  }

  await startFullExam(page, api, secondDocument);
  expectFullExamSessionToUseOnlyDocument(api, secondDocument);
}

function expectFullExamSessionToUseOnlyDocument(
  api: MockCertPrepApi,
  document: DocumentRead,
): void {
  const selectedDocumentDrafts = api.playableDraftsForDocument(document.id);
  const excludedDraftIds = api.playableDrafts
    .filter((draft) => draft.document_id !== document.id)
    .map((draft) => draft.id);
  const session = api.currentSession();

  expect(session).not.toBeNull();
  expect(api.practiceSessionPayload()).toMatchObject({
    mode: 'full_document',
    document_id: document.id,
    question_count: selectedDocumentDrafts.length,
  });
  expect(session?.question_ids).toEqual(
    selectedDocumentDrafts.map((draft) => draft.id),
  );
  expect(session?.question_ids).toEqual(
    expect.not.arrayContaining(excludedDraftIds),
  );
}

async function expectDocumentLibraryOption(
  page: Page,
  document: DocumentRead,
): Promise<void> {
  await expect(
    page
      .getByLabel('Project document library')
      .locator('option', { hasText: document.filename }),
  ).toHaveCount(1);
}

async function selectDocumentFromLibrary(
  page: Page,
  document: DocumentRead,
): Promise<void> {
  const documentLibrary = page.getByLabel('Project document library');
  await documentLibrary.selectOption(document.id);
  await expect(documentLibrary).toHaveValue(document.id);
}

async function expectAiInferredPlayableDraft(
  page: Page,
  draft: CompleteQuestionDraft,
): Promise<void> {
  const card = page.getByTestId('draft-question-card').filter({
    hasText: draft.question,
  });
  await expect(card.getByText('Playable', { exact: true })).toBeVisible();
  await expect(card.getByText('ai_inferred', { exact: true })).toBeVisible();
}

export async function expectRandomQuizAvailableCount(
  page: Page,
  count: number,
): Promise<void> {
  await expect(page.getByText(`${count} questions available`)).toBeVisible();
}

export async function expectFullExamDocumentOptions(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  await page.getByRole('link', { name: 'Full Exam' }).click();
  await expect(page.getByRole('heading', { name: 'Full Exam' })).toBeVisible();
  const documentSelect = page
    .getByRole('region', { name: 'Source Document' })
    .getByRole('combobox');
  const selectedDocumentQuestionCount = api.playableDraftsForDocument(
    api.fullExamDocument.id,
  ).length;
  await expect(
    documentSelect.locator('option', {
      hasText: `${api.fullExamDocument.filename} - ${selectedDocumentQuestionCount} questions`,
    }),
  ).toHaveCount(1);

  for (const document of api.documents) {
    const questionCount = api.playableDraftsForDocument(document.id).length;
    if (questionCount === 0) {
      await expect(
        documentSelect.locator('option', { hasText: document.filename }),
      ).toHaveCount(0);
    }
  }
}

export async function completePracticeQuestions(
  page: Page,
  api: MockCertPrepApi,
  drafts: readonly CompleteQuestionDraft[],
  answerForDraft: (draft: CompleteQuestionDraft) => string,
): Promise<void> {
  const initialAttemptCount = api.attempts().length;

  for (const [index, draft] of drafts.entries()) {
    await expect(page.getByText(draft.question)).toBeVisible();
    await page.getByRole('radio', { name: answerForDraft(draft) }).check();
    await page.getByRole('button', { name: 'Submit answer' }).click();

    const answeredCount = index + 1;
    await expectSessionProgress(page, answeredCount, drafts.length);
  }

  await expect(
    page.getByText(
      'Practice set complete. Correct answers are removed from the wrong-answer list after submission.',
    ),
  ).toBeVisible();
  await expect(page.getByText('100%')).toBeVisible();
  expect(api.attempts()).toHaveLength(initialAttemptCount + drafts.length);
}

export async function retryWrongAnswerAndClearReview(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  const draft = api.draft;
  await completePracticeQuestions(page, api, [draft], wrongChoiceForDraft);

  const wrongAnswer = api
    .wrongAnswers()
    .find((candidate) => candidate.question_id === draft.id);
  expect(wrongAnswer).toBeDefined();

  await openReviewPage(page);
  await expect(page.getByText('1 recorded')).toBeVisible();
  await page
    .locator('article.wrong-answer-card')
    .filter({ hasText: draft.question })
    .getByRole('button', { name: 'Retry' })
    .click();

  await expect(
    page.getByRole('heading', { name: 'Random Quiz' }),
  ).toBeVisible();
  await expect
    .poll(() => api.practiceSessionPayload())
    .toMatchObject({
      mode: 'review_retry',
      wrong_attempt_ids: [wrongAnswer?.attempt_id],
      question_count: 1,
    });

  await completePracticeQuestions(
    page,
    api,
    [draft],
    (question) => question.answer,
  );
  expect(api.wrongAnswers()).toHaveLength(0);

  await openReviewPage(page);
  await expect(
    page.getByText(
      'Wrong answers will appear here after a practice attempt needs review.',
    ),
  ).toBeVisible();
  expect(api.wrongAnswerSummary().current_wrong_count).toBe(0);
  expect(api.wrongAnswerSummary().cleared_count).toBe(1);
}

export async function startReviewQuizForAllWrongAnswersAndClearReview(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  const drafts = api.playableDrafts.slice(0, 2);
  await completePracticeQuestions(page, api, drafts, wrongChoiceForDraft);
  const wrongAttemptIds = api
    .wrongAnswers()
    .map((wrongAnswer) => wrongAnswer.attempt_id);
  expect(wrongAttemptIds).toHaveLength(drafts.length);

  await openReviewPage(page);
  await expect(page.getByText(`${drafts.length} recorded`)).toBeVisible();
  await page.getByRole('button', { name: 'Start review quiz' }).click();

  await expect(
    page.getByRole('heading', { name: 'Random Quiz' }),
  ).toBeVisible();
  await expect
    .poll(() => api.practiceSessionPayload())
    .toMatchObject({
      mode: 'review_retry',
      wrong_attempt_ids: wrongAttemptIds,
      question_count: drafts.length,
    });

  await completePracticeQuestions(
    page,
    api,
    drafts,
    (question) => question.answer,
  );
  expect(api.wrongAnswers()).toHaveLength(0);
}

export async function expectWrongAnswerDashboard(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  const wrongAnswers = api.wrongAnswers();
  expect(wrongAnswers.length).toBeGreaterThan(0);
  await openDashboardPage(page);
  await expect(page.getByText('Project weakness analysis')).toBeVisible();
  await expect(
    page.locator('.dashboard-kpis').getByText('Current Wrong', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText('Weak Areas By Source')).toBeVisible();
  await expect(page.getByText('Answer Patterns')).toBeVisible();
  await expect(
    page.locator('.weak-area-list').getByText(api.document.filename).first(),
  ).toBeVisible();

  const summary = api.wrongAnswerSummary();
  await expect(
    page
      .locator('.dashboard-kpis div')
      .filter({ hasText: 'Current Wrong' })
      .getByText(String(summary.current_wrong_count), { exact: true }),
  ).toBeVisible();
  for (const wrongAnswer of wrongAnswers) {
    await expect(
      page.getByText(`Page ${wrongAnswer.citation_page}`).first(),
    ).toBeVisible();
    await expect(page.getByText(wrongAnswer.selected_answer).first()).toBeVisible();
    await expect(
      page.getByText(wrongAnswer.correct_answer ?? '').first(),
    ).toBeVisible();
  }
}

export async function startDashboardWeakAreaRetry(
  page: Page,
  api: MockCertPrepApi,
  area: {
    readonly documentId: string;
    readonly citationPage: number;
  },
): Promise<void> {
  const matchingAttemptIds = api
    .wrongAnswers()
    .filter(
      (wrongAnswer) =>
        wrongAnswer.document_id === area.documentId &&
        wrongAnswer.citation_page === area.citationPage,
    )
    .map((wrongAnswer) => wrongAnswer.attempt_id);
  expect(matchingAttemptIds).toHaveLength(1);

  await page
    .locator('.weak-area-row')
    .filter({ hasText: `Page ${area.citationPage}` })
    .getByRole('button', { name: 'Retry 1 question' })
    .click();
  await expect(page.getByRole('heading', { name: 'Random Quiz' })).toBeVisible();
  await expect
    .poll(() => api.practiceSessionPayload())
    .toMatchObject({
      mode: 'review_retry',
      wrong_attempt_ids: matchingAttemptIds,
      question_count: matchingAttemptIds.length,
    });
}

export async function expectWrongAnswerReview(
  page: Page,
  api: MockCertPrepApi,
  drafts: readonly CompleteQuestionDraft[],
): Promise<void> {
  const wrongAnswers = api.wrongAnswers();
  expect(wrongAnswers).toHaveLength(drafts.length);
  await openReviewPage(page);
  await expect(page.getByText(`${drafts.length} recorded`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();

  for (const draft of drafts) {
    const wrongAnswer = wrongAnswers.find(
      (candidate) => candidate.question_id === draft.id,
    );
    expect(wrongAnswer).toBeDefined();
    const card = page.locator('article.wrong-answer-card').filter({
      hasText: draft.question,
    });
    const selectedAnswerPanel = card.getByRole('region', {
      name: /your answer|selected answer/i,
    });
    const correctAnswerPanel = card.getByRole('region', {
      name: 'Correct answer',
    });
    const rationalePanel = card.getByRole('region', { name: 'Rationale' });
    const sourcePanel = card.getByRole('region', {
      name: /source|source excerpt/i,
    });

    await expect(card).toBeVisible();
    await expect(
      card.getByText(`Page ${draft.citation_page ?? 'n/a'}`),
    ).toBeVisible();
    await expect(selectedAnswerPanel).toBeVisible();
    await expect(
      selectedAnswerPanel.getByText(wrongAnswer?.selected_answer ?? '', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(correctAnswerPanel).toBeVisible();
    await expect(
      correctAnswerPanel.getByText(draft.answer, { exact: true }),
    ).toBeVisible();
    await expect(rationalePanel.getByText(draft.rationale)).toBeVisible();
    if (draft.source_excerpt !== null) {
      await expect(sourcePanel.getByText(draft.source_excerpt)).toBeVisible();
    }
    await expect(
      card.getByRole('button', { name: 'Discuss mistake with AI' }),
    ).toBeVisible();
  }

  await expect(
    page.getByText('Answer correctly in a later session to clear them.'),
  ).toBeVisible();
  await expectWrongAnswerExplanation(page, api, wrongAnswers[0]);
  const fallbackWrongAnswer = wrongAnswers.find(
    (wrongAnswer) => wrongAnswer.attempt_id !== wrongAnswers[0]?.attempt_id,
  );
  if (fallbackWrongAnswer !== undefined) {
    await expectWrongAnswerExplanation(page, api, fallbackWrongAnswer);
  }
}

export function wrongChoiceForDraft(draft: CompleteQuestionDraft): string {
  const wrongChoice = draft.choices.find((choice) => choice !== draft.answer);
  if (wrongChoice === undefined) {
    throw new Error(`Draft ${draft.id} does not have a wrong choice.`);
  }
  return wrongChoice;
}

async function expectCurrentSessionVisible(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  await expect.poll(() => api.currentSession()?.id ?? null).not.toBeNull();
  const session = api.currentSession();
  expect(session).not.toBeNull();
  await expect(
    page.getByText(session?.id ?? '', { exact: true }),
  ).toBeVisible();
}

async function expectSessionProgress(
  page: Page,
  answeredCount: number,
  total: number,
): Promise<void> {
  await expect(
    page.getByLabel('Session details').getByText(`${answeredCount}/${total}`),
  ).toBeVisible();
}

async function expectWrongAnswerExplanation(
  page: Page,
  api: MockCertPrepApi,
  wrongAnswer: ReturnType<MockCertPrepApi['wrongAnswers']>[number] | undefined,
): Promise<void> {
  expect(wrongAnswer).toBeDefined();
  const card = page.locator('article.wrong-answer-card').filter({
    hasText: wrongAnswer?.question ?? '',
  });

  await card.getByRole('button', { name: 'Discuss mistake with AI' }).click();
  await expect
    .poll(
      () =>
        api
          .wrongAnswerExplanations()
          .find(
            (explanation) => explanation.attempt_id === wrongAnswer?.attempt_id,
          )?.explanation ?? null,
    )
    .not.toBeNull();

  const explanation = api
    .wrongAnswerExplanations()
    .find((candidate) => candidate.attempt_id === wrongAnswer?.attempt_id);
  expect(explanation).toBeDefined();
  await expect(card.getByText(explanation?.explanation ?? '')).toBeVisible();

  if (explanation?.fallback) {
    await expect(card.getByText('Local AI is not ready')).toBeVisible();
  }
}

async function openReviewPage(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Review' }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(
    page.getByRole('heading', { name: 'Wrong Answers', exact: true }),
  ).toBeVisible();
}

async function openDashboardPage(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole('heading', { name: 'Dashboard', exact: true }),
  ).toBeVisible();
}
