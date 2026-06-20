import { expect, type Page } from '@playwright/test';
import type { MockExamPrepApi } from './mock-api';

export async function seedMockApiConfig(
  page: Page,
  baseUrl: string,
  token: string,
): Promise<void> {
  await page.addInitScript(
    ([apiBaseUrl, devToken]) => {
      localStorage.setItem('examPrepApiBaseUrl', apiBaseUrl);
      localStorage.setItem('examPrepApiToken', devToken);
    },
    [baseUrl, token],
  );
}

export async function expectRuntimeReady(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Exam Prep' })).toBeVisible();
  await expect(page.getByText('qwen3:14b')).toBeVisible();
  await expect(page.getByText('fake')).toBeVisible();
  await expect(page.getByText('paddle / gpu:0')).toBeVisible();
}

export async function createProject(
  page: Page,
  api: MockExamPrepApi,
): Promise<void> {
  await page.getByLabel('Name').fill(api.project.name);
  await page.getByLabel('Description').fill(api.project.description);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('button', { name: new RegExp(api.project.name) }),
  ).toBeVisible();
}

export async function uploadDocumentAndExpectDraft(
  page: Page,
  api: MockExamPrepApi,
): Promise<void> {
  await page.getByLabel('PDF file').setInputFiles({
    name: api.document.filename,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% mocked text pdf\n'),
  });
  await page.getByRole('button', { name: 'Upload PDF' }).click();
  await expect(page.getByText(api.document.filename)).toBeVisible();
  await expect(page.getByText('paddle_ocr_gpu')).toBeVisible();
  await expect(page.getByText('gpu:0').last()).toBeVisible();
  await expect(page.getByText(api.draft.question)).toBeVisible();
  await expect(page.getByText(api.draft.source_excerpt)).toBeVisible();
  await expect(page.getByText('Playable', { exact: true })).toBeVisible();
}

export async function startRandomQuiz(
  page: Page,
  api: MockExamPrepApi,
): Promise<void> {
  await page.getByRole('button', { name: 'Random Quiz' }).click();
  await expect(page.getByText('1 questions available')).toBeVisible();
  await page.getByRole('button', { name: 'Start random quiz' }).click();
  await expect(page.getByText(`Session ${api.session.id}`)).toBeVisible();
}

export async function submitWrongAnswerAndOpenReview(
  page: Page,
  api: MockExamPrepApi,
): Promise<void> {
  await page.getByLabel('Ignore the cited source').check();
  await page.getByRole('button', { name: 'Submit answer' }).click();

  await expect(page.getByText('Needs review')).toBeVisible();
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByText(`Correct: ${api.draft.answer}`)).toBeVisible();
  await expect(page.getByText(api.draft.rationale)).toBeVisible();
}
