import { expect, test, type Page } from '@playwright/test';
import {
  apiBaseUrl,
  devToken,
  expectedSeenPaths,
  installMockCertPrepApi,
} from './support/mock-api';
import { minimalPng } from './support/minimal-image';
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

test('keeps mixed PDF and image multipart filenames in upload order and the library', async ({
  page,
}) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);
  await installUploadCapture(page);
  const pdfDocument = api.document;

  await page.goto('/');
  await createProject(page, api);
  await expectRuntimeReady(page);

  const imageFilename = 'network-diagram.png';
  const binaryPdf = Buffer.from([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0xfe, 0x00,
    0x80,
  ]);
  await page.locator('input[aria-label="Source files"]').setInputFiles([
    {
      name: pdfDocument.filename,
      mimeType: 'application/pdf',
      buffer: binaryPdf,
    },
    {
      name: imageFilename,
      mimeType: 'image/png',
      buffer: minimalPng(),
    },
  ]);
  await expect(page.getByText('2 files selected')).toBeVisible();
  await page.getByRole('button', { name: 'Upload files' }).click();

  await expect
    .poll(() => api.uploadedDocuments().map((document) => document.filename))
    .toEqual([pdfDocument.filename, imageFilename]);

  const uploadList = page.getByLabel('Selected source file upload status');
  for (const filename of [pdfDocument.filename, imageFilename]) {
    await expect(
      uploadList.locator(':scope > div').filter({ hasText: filename }),
    ).toContainText('Uploaded');
  }

  const library = page.getByLabel('Project document library');
  await expect(
    library.locator('option', { hasText: pdfDocument.filename }),
  ).toHaveCount(1);
  await expect(
    library.locator('option', { hasText: imageFilename }),
  ).toHaveCount(1);
  const imageDocument = api.uploadedDocuments()[1];
  expect(imageDocument?.filename).toBe(imageFilename);
  await expect
    .poll(async () => (await capturedUploads(page))[1]?.bytes)
    .toEqual(Array.from(minimalPng()));
  await expect(library).toHaveValue(
    imageDocument?.id ?? 'missing-image-document',
  );
});

test('optionally crops selected images before preserving mixed upload order', async ({
  page,
}) => {
  const api = await installMockCertPrepApi(page);
  await seedMockApiConfig(page, apiBaseUrl, devToken);
  await installUploadCapture(page);

  await page.goto('/');
  await createProject(page, api);
  await expectRuntimeReady(page);

  const cropToggle = page.getByRole('switch', {
    name: 'Crop images before upload',
  });
  await expect(cropToggle).not.toBeChecked();
  await cropToggle.check();

  const sourceImageDataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 4;
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('Canvas is unavailable in the browser test.');
    }
    context.fillStyle = '#0b6bcb';
    context.fillRect(0, 0, 4, 2);
    context.fillStyle = '#f59e0b';
    context.fillRect(4, 0, 4, 2);
    context.fillStyle = '#22c55e';
    context.fillRect(0, 2, 4, 2);
    context.fillStyle = '#9333ea';
    context.fillRect(4, 2, 4, 2);
    return canvas.toDataURL('image/png');
  });
  const sourceImage = Buffer.from(
    sourceImageDataUrl.split(',')[1] ?? '',
    'base64',
  );
  const pdf = Buffer.from('%PDF-1.7\nsource', 'binary');

  await page.locator('input[aria-label="Source files"]').setInputFiles([
    {
      name: 'guide.pdf',
      mimeType: 'application/pdf',
      buffer: pdf,
    },
    {
      name: 'network-diagram.png',
      mimeType: 'image/png',
      buffer: sourceImage,
    },
  ]);

  const dialog = page.getByRole('dialog', { name: /Crop image/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Image 1 of 1')).toBeVisible();
  await expect(dialog.getByLabel('Crop width')).toHaveValue('8');
  await expect(dialog.getByLabel('Crop height')).toHaveValue('4');

  await dialog.getByLabel('Crop left').fill('2');
  await dialog.getByLabel('Crop top').fill('1');
  await dialog.getByLabel('Crop width').fill('4');
  await dialog.getByLabel('Crop height').fill('2');
  await dialog.getByRole('button', { name: 'Apply crop' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText('2 files selected')).toBeVisible();
  await page.getByLabel('Batch size').selectOption('1');
  await page.getByRole('button', { name: 'Upload files' }).click();

  await expect
    .poll(() => api.uploadedSourceFiles().map((file) => file.filename))
    .toEqual(['guide.pdf', 'network-diagram-cropped.png']);
  await expect
    .poll(async () =>
      (await capturedUploads(page)).map((file) => file.filename),
    )
    .toEqual(['guide.pdf', 'network-diagram-cropped.png']);
  await expect
    .poll(async () => (await capturedUploads(page))[1]?.bytes.length ?? 0)
    .toBeGreaterThan(24);
  const croppedImage = (await capturedUploads(page))[1];
  expect(croppedImage?.contentType).toBe('image/png');
  const croppedImageBytes = Buffer.from(croppedImage?.bytes ?? []);
  expect(pngDimensions(croppedImageBytes)).toEqual({
    width: 4,
    height: 2,
  });
  const cornerPixels = await page.evaluate(
    async (imageDataUrl) => {
      const response = await fetch(imageDataUrl);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (context === null) {
        throw new Error('Canvas is unavailable while checking cropped pixels.');
      }
      context.drawImage(bitmap, 0, 0);
      const topLeft = Array.from(context.getImageData(0, 0, 1, 1).data);
      const topRight = Array.from(
        context.getImageData(bitmap.width - 1, 0, 1, 1).data,
      );
      const bottomLeft = Array.from(
        context.getImageData(0, bitmap.height - 1, 1, 1).data,
      );
      const bottomRight = Array.from(
        context.getImageData(
          bitmap.width - 1,
          bitmap.height - 1,
          1,
          1,
        ).data,
      );
      bitmap.close();
      return { bottomLeft, bottomRight, topLeft, topRight };
    },
    `data:image/png;base64,${croppedImageBytes.toString('base64')}`,
  );
  expect(cornerPixels.topLeft.slice(0, 3)).toEqual([11, 107, 203]);
  expect(cornerPixels.topRight.slice(0, 3)).toEqual([245, 158, 11]);
  expect(cornerPixels.bottomLeft.slice(0, 3)).toEqual([34, 197, 94]);
  expect(cornerPixels.bottomRight.slice(0, 3)).toEqual([147, 51, 234]);
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

test('starts a review quiz from all current wrong answers', async ({
  page,
}) => {
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

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature)) {
    throw new Error('Expected cropped upload bytes to contain a PNG image.');
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

interface CapturedUpload {
  readonly filename: string;
  readonly contentType: string;
  bytes: number[];
}

async function installUploadCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const captured: CapturedUpload[] = [];
    (
      window as unknown as { __certPrepCapturedUploads: CapturedUpload[] }
    ).__certPrepCapturedUploads = captured;
    const originalAppend = FormData.prototype.append;
    FormData.prototype.append = function (
      name: string,
      value: string | Blob,
      filename?: string,
    ): void {
      if (name === 'file' && value instanceof Blob) {
        const file = value as File;
        const capture: CapturedUpload = {
          filename: filename ?? file.name,
          contentType: file.type,
          bytes: [],
        };
        captured.push(capture);
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          if (reader.result instanceof ArrayBuffer) {
            capture.bytes = Array.from(new Uint8Array(reader.result));
          }
        });
        reader.readAsArrayBuffer(file);
      }
      if (filename === undefined) {
        originalAppend.call(this, name, value as string);
      } else {
        originalAppend.call(this, name, value as Blob, filename);
      }
    };
  });
}

async function capturedUploads(page: Page): Promise<CapturedUpload[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __certPrepCapturedUploads?: CapturedUpload[];
        }
      ).__certPrepCapturedUploads ?? [],
  );
}
