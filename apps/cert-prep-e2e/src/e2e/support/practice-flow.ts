import { expect, type Page } from '@playwright/test';
import type { DocumentRead, ProjectRead } from '@cert-prep/api';
import type {
  CompleteQuestion,
  CompleteQuestionWithExcerpt,
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

export async function expectWorkspaceReady(page: Page): Promise<void> {
  await expect(page.locator('h1', { hasText: 'Cert Prep' })).toBeVisible();
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

export async function uploadDocumentAndExpectQuestion(
  page: Page,
  api: MockCertPrepApi,
  options: {
    readonly document?: DocumentRead;
    readonly question?: CompleteQuestionWithExcerpt;
  } = {},
): Promise<void> {
  const document = options.document ?? api.document;
  const question = options.question ?? api.question;

  const sourceFileInput = page.locator('input[aria-label="Source files"]');
  await sourceFileInput.setInputFiles([]);
  await sourceFileInput.setInputFiles({
    name: document.filename,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% mocked text pdf\n'),
  });
  await page.getByRole('button', { name: 'Upload files' }).click();
  await expect(
    page
      .locator('.workbench-file-name')
      .getByText(document.filename, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Ready to review' }),
  ).toBeVisible();
  await expect(page.getByText(question.question)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(question.source_excerpt)).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page
      .getByTestId('question-card')
      .filter({ hasText: question.question }),
  ).toBeVisible();
}

export async function createWorkspaceWithUploadedDocument(
  page: Page,
  api: MockCertPrepApi,
  options: {
    readonly project?: ProjectRead;
    readonly document?: DocumentRead;
    readonly question?: CompleteQuestionWithExcerpt;
  } = {},
): Promise<void> {
  const project = options.project ?? api.project;
  await page.goto('/');
  await createProject(page, api, project);
  await expectWorkspaceReady(page);
  await uploadDocumentAndExpectQuestion(page, api, options);
}

export async function startRandomDraw(
  page: Page,
  api: MockCertPrepApi,
  questionCount = api.playableQuestions.length,
): Promise<void> {
  await page.getByRole('link', { name: 'Random draw' }).click();
  await expectRandomDrawAvailableCount(page, api.playableQuestions.length);
  await page
    .getByRole('spinbutton', { name: 'Random draw size' })
    .fill(String(questionCount));
  await page.getByRole('button', { name: 'Start random draw' }).click();
  await expectCurrentSessionVisible(page, api);
}

export async function startWholeSource(
  page: Page,
  api: MockCertPrepApi,
  document = api.wholeSourceDocument,
): Promise<void> {
  const questionCount = api.playableQuestionsForDocument(document.id).length;

  await page.getByRole('link', { name: 'Whole source' }).click();
  await expect(page.getByRole('heading', { name: 'Whole source' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Start whole source' }).click();
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
  await page.getByRole('link', { name: 'Questions', exact: true }).click();
  await page.getByLabel('Project source library').selectOption(document.id);
  await expect(
    page
      .locator('.workbench-file-name')
      .getByText(document.filename, { exact: true }),
  ).toBeVisible();
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
    const selectedDocumentQuestions = api.playableQuestionsForDocument(document.id);
    await selectActiveDocument(page, document);
    await startWholeSource(page, api, document);
    expectWholeSourceSessionToUseOnlyDocument(api, document);
    await completePracticeQuestions(
      page,
      api,
      selectedDocumentQuestions,
      (question) => question.answer,
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
  await expectWorkspaceReady(page);

  const requestMarker = api.markRequestLog();
  await page.locator('input[aria-label="Source files"]').setInputFiles(
    [firstDocument, secondDocument].map((document) => ({
      name: document.filename,
      mimeType: 'application/pdf',
      buffer: Buffer.from(`%PDF-1.4\n% mocked ${document.id} pdf\n`),
    })),
  );
  await page.getByRole('button', { name: 'Upload files' }).click();

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
    const [question] = api.playableQuestionsForDocument(document.id);
    if (question === undefined) {
      throw new Error(`Document ${document.id} needs a playable mocked question.`);
    }
    await expectAiInferredPlayableQuestion(page, question);
  }

  await startWholeSource(page, api, secondDocument);
  expectWholeSourceSessionToUseOnlyDocument(api, secondDocument);
}

export function expectWholeSourceSessionToUseOnlyDocument(
  api: MockCertPrepApi,
  document: DocumentRead,
): void {
  const selectedDocumentQuestions = api.playableQuestionsForDocument(document.id);
  const excludedQuestionIds = api.playableQuestions
    .filter((question) => question.document_id !== document.id)
    .map((question) => question.id);
  const session = api.currentSession();

  expect(session).not.toBeNull();
  expect(api.practiceSessionPayload()).toMatchObject({
    mode: 'full_document',
    document_id: document.id,
    question_count: selectedDocumentQuestions.length,
  });
  expect(session?.question_ids).toEqual(
    selectedDocumentQuestions.map((question) => question.id),
  );
  expect(session?.question_ids).toEqual(
    expect.not.arrayContaining(excludedQuestionIds),
  );
}

async function expectDocumentLibraryOption(
  page: Page,
  document: DocumentRead,
): Promise<void> {
  await expect(
    page
      .getByLabel('Project source library')
      .locator('option', { hasText: document.filename }),
  ).toHaveCount(1);
}

async function selectDocumentFromLibrary(
  page: Page,
  document: DocumentRead,
): Promise<void> {
  const documentLibrary = page.getByLabel('Project source library');
  await documentLibrary.selectOption(document.id);
  await expect(documentLibrary).toHaveValue(document.id);
}

async function expectAiInferredPlayableQuestion(
  page: Page,
  question: CompleteQuestion,
): Promise<void> {
  // The panel lists only playable questions, so a listed card is playable; its answer
  // is marked as inferred both by the card header and by the answer.
  const card = page.getByTestId('question-card').filter({
    hasText: question.question,
  });
  await expect(card).toBeVisible();
  await expect(card.getByTestId('ai-inferred-answer')).toHaveText([
    'System-inferred answer',
    'System-inferred answer',
  ]);
}

export async function expectRandomDrawAvailableCount(
  page: Page,
  count: number,
): Promise<void> {
  await expect(page.getByText(`${count} questions available`)).toBeVisible();
}

export async function expectWholeSourceDocumentOptions(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  await page.getByRole('link', { name: 'Whole source' }).click();
  await expect(page.getByRole('heading', { name: 'Whole source' })).toBeVisible();
  const documentSelect = page
    .getByRole('region', { name: 'Source Document' })
    .getByRole('combobox');
  const selectedDocumentQuestionCount = api.playableQuestionsForDocument(
    api.wholeSourceDocument.id,
  ).length;
  await expect(
    documentSelect.locator('option', {
      hasText: `${api.wholeSourceDocument.filename} - ${selectedDocumentQuestionCount} questions`,
    }),
  ).toHaveCount(1);

  for (const document of api.documents) {
    const questionCount = api.playableQuestionsForDocument(document.id).length;
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
  questions: readonly CompleteQuestion[],
  answerForQuestion: (question: CompleteQuestion) => string,
): Promise<void> {
  const initialAttemptCount = api.attempts().length;

  for (const [index, question] of questions.entries()) {
    await expect(page.getByText(question.question)).toBeVisible();
    await page.getByRole('radio', { name: answerForQuestion(question) }).check();
    await page.getByRole('button', { name: 'Submit answer' }).click();

    const answeredCount = index + 1;
    await expectSessionProgress(page, answeredCount, questions.length);
  }

  await expect(
    page.getByText(
      'Practice set complete. Correct answers are removed from the wrong-answer list after submission.',
    ),
  ).toBeVisible();
  await expect(page.getByText('100%')).toBeVisible();
  expect(api.attempts()).toHaveLength(initialAttemptCount + questions.length);
}

export async function retryWrongAnswerAndClearReview(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  const question = api.question;
  await completePracticeQuestions(page, api, [question], wrongChoiceForQuestion);

  const wrongAnswer = api
    .wrongAnswers()
    .find((candidate) => candidate.question_id === question.id);
  expect(wrongAnswer).toBeDefined();

  await openWrongAnswerRetryPage(page);
  await expect(page.getByText('1 recorded')).toBeVisible();
  await page
    .locator('article.wrong-answer-card')
    .filter({ hasText: question.question })
    .getByRole('button', { name: 'Retry' })
    .click();

  await expect(
    page.getByRole('heading', { name: 'Random draw', level: 2 }),
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
    [question],
    (question) => question.answer,
  );
  expect(api.wrongAnswers()).toHaveLength(0);

  await openWrongAnswerRetryPage(page);
  await expect(
    page.getByText(
      'Wrong answers will appear here after a practice attempt needs review.',
    ),
  ).toBeVisible();
  expect(api.wrongAnswerSummary().current_wrong_count).toBe(0);
  expect(api.wrongAnswerSummary().cleared_count).toBe(1);
}

export async function startRetryForAllWrongAnswersAndClearReview(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  const questions = api.playableQuestions.slice(0, 2);
  await completePracticeQuestions(page, api, questions, wrongChoiceForQuestion);
  const wrongAttemptIds = api
    .wrongAnswers()
    .map((wrongAnswer) => wrongAnswer.attempt_id);
  expect(wrongAttemptIds).toHaveLength(questions.length);

  await openWrongAnswerRetryPage(page);
  await expect(page.getByText(`${questions.length} recorded`)).toBeVisible();
  await page.getByRole('button', { name: 'Start wrong-answer retry' }).click();

  await expect(
    page.getByRole('heading', { name: 'Random draw', level: 2 }),
  ).toBeVisible();
  await expect
    .poll(() => api.practiceSessionPayload())
    .toMatchObject({
      mode: 'review_retry',
      wrong_attempt_ids: wrongAttemptIds,
      question_count: questions.length,
    });

  await completePracticeQuestions(
    page,
    api,
    questions,
    (question) => question.answer,
  );
  expect(api.wrongAnswers()).toHaveLength(0);
}

export async function expectWrongAnswerSummary(
  page: Page,
  api: MockCertPrepApi,
): Promise<void> {
  const wrongAnswers = api.wrongAnswers();
  expect(wrongAnswers.length).toBeGreaterThan(0);
  await openWrongAnswerSummaryPage(page);
  await expect(page.getByText('Project weakness analysis')).toBeVisible();
  await expect(
    page.locator('.summary-kpis').getByText('Current Wrong', {
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
      .locator('.summary-kpis div')
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

export async function startWrongAnswerSummaryWeakAreaRetry(
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
  await expect(page.getByRole('heading', { name: 'Random draw', level: 2 })).toBeVisible();
  await expect
    .poll(() => api.practiceSessionPayload())
    .toMatchObject({
      mode: 'review_retry',
      wrong_attempt_ids: matchingAttemptIds,
      question_count: matchingAttemptIds.length,
    });
}

export async function expectWrongAnswerRetry(
  page: Page,
  api: MockCertPrepApi,
  questions: readonly CompleteQuestion[],
): Promise<void> {
  const wrongAnswers = api.wrongAnswers();
  expect(wrongAnswers).toHaveLength(questions.length);
  await openWrongAnswerRetryPage(page);
  await expect(page.getByText(`${questions.length} recorded`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();

  for (const question of questions) {
    const wrongAnswer = wrongAnswers.find(
      (candidate) => candidate.question_id === question.id,
    );
    expect(wrongAnswer).toBeDefined();
    const card = page.locator('article.wrong-answer-card').filter({
      hasText: question.question,
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
      card.getByText(`Page ${question.citation_page ?? 'n/a'}`),
    ).toBeVisible();
    await expect(selectedAnswerPanel).toBeVisible();
    await expect(
      selectedAnswerPanel.getByText(wrongAnswer?.selected_answer ?? '', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(correctAnswerPanel).toBeVisible();
    await expect(
      correctAnswerPanel.getByText(question.answer, { exact: true }),
    ).toBeVisible();
    await expect(rationalePanel.getByText(question.rationale)).toBeVisible();
    if (question.source_excerpt !== null) {
      await expect(sourcePanel.getByText(question.source_excerpt)).toBeVisible();
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

export function wrongChoiceForQuestion(question: CompleteQuestion): string {
  const wrongChoice = question.choices.find((choice) => choice !== question.answer);
  if (wrongChoice === undefined) {
    throw new Error(`Question ${question.id} does not have a wrong choice.`);
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
    // Session details show a short id; the full id is the element's title.
    page.locator(`[title="${session?.id ?? ''}"]`),
  ).toBeVisible();
}

async function expectSessionProgress(
  page: Page,
  answeredCount: number,
  total: number,
): Promise<void> {
  await expect(
    page.getByLabel('Session details').getByText(`${answeredCount} of ${total}`),
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

async function openWrongAnswerRetryPage(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Wrong-answer retry' }).click();
  await expect(page).toHaveURL(/\/wrong-answer-retry$/);
  await expect(
    page.getByRole('heading', { name: 'Wrong-answer retry', exact: true }),
  ).toBeVisible();
}

async function openWrongAnswerSummaryPage(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Wrong-answer summary' }).click();
  await expect(page).toHaveURL(/\/wrong-answers\/summary$/);
  await expect(
    page.getByRole('heading', { name: 'Wrong-answer summary', exact: true }),
  ).toBeVisible();
}
