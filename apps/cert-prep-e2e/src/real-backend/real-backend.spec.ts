import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { minimalPng } from '../support/minimal-image';
import { minimalPdf } from '../support/minimal-pdf';

const apiBaseUrl = 'http://127.0.0.1:8766';
const apiHeaders = { Authorization: 'Bearer real-e2e-token' };

interface ProjectRead {
  id: string;
  name: string;
}

interface DocumentRead {
  id: string;
  filename: string;
  status: string;
  page_count: number;
  processed_page_count: number;
  has_text: boolean;
  chunks_count: number;
}

interface PracticeSessionRead {
  id: string;
  status: string;
}

interface HarnessRuleStats {
  id: string;
  matched: number;
  failures: number;
  forwarded: number;
  lastForwardStatus: number | null;
  lastOperationId: string | null;
}

interface HarnessStats {
  rules: HarnessRuleStats[];
}

test.describe.configure({ timeout: 60_000 });

test.beforeEach(async ({ page, request }) => {
  await expect
    .poll(
      async () => {
        const response = await request.get(`${apiBaseUrl}/health`);
        return response.ok();
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const reset = await request.post(`${apiBaseUrl}/__e2e/reset`);
  expect(reset.ok()).toBe(true);
  await page.addInitScript((baseUrl) => {
    localStorage.setItem('certPrepApiBaseUrl', baseUrl);
    localStorage.setItem('certPrepApiToken', 'real-e2e-token');
  }, apiBaseUrl);
});

test('uses the real backend for upload, generation, and Full Exam', async ({
  page,
}, testInfo) => {
  const projectName = uniqueProjectName('Real backend acceptance', testInfo);
  await createProject(page, projectName);
  await uploadAndGenerateQuestions(page, 'real-backend.pdf');

  await page.getByRole('link', { name: 'Full Exam' }).click();
  await expect(page.getByRole('heading', { name: 'Full Exam' })).toBeVisible();
  await expect(
    page.getByText(/[1-9]\d* questions in selected document/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start full exam' }).click();
  await expect(page.getByText('Question 1 of 2')).toBeVisible();

  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Question 2 of 2')).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Continue your unfinished practice?' }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Resume session' }).click();
  await expect(page.getByText('Question 2 of 2')).toBeVisible();

  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Practice set complete.')).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Resume session' }),
  ).toHaveCount(0);
});

test('uploads multiple PDFs through the real multipart API', async ({
  page,
  request,
}, testInfo) => {
  const projectName = uniqueProjectName('Real multi PDF', testInfo);
  await createProject(page, projectName);

  await page.locator('input[aria-label="Source files"]').setInputFiles([
    pdfFile('multi-one.pdf', 'The first source describes least privilege.'),
    pdfFile('multi-two.pdf', 'The second source describes defense in depth.'),
  ]);
  await expect(page.getByText('2 files selected')).toBeVisible();
  await page.getByRole('button', { name: 'Upload files' }).click();

  const uploadList = page.getByLabel('Selected source file upload status');
  for (const filename of ['multi-one.pdf', 'multi-two.pdf']) {
    const row = uploadList.locator(':scope > div').filter({ hasText: filename });
    await expect(row).toContainText('Uploaded', { timeout: 30_000 });
  }
  const library = page.getByLabel('Project document library');
  await expect(library.locator('option')).toHaveCount(2);
  await expect(library).toContainText('multi-one.pdf');
  await expect(library).toContainText('multi-two.pdf');

  const project = await projectByName(request, projectName);
  const documents = await apiJson<{ items: DocumentRead[] }>(
    request,
    `/projects/${project.id}/documents`,
  );
  expect(documents.items.map((document) => document.filename).sort()).toEqual([
    'multi-one.pdf',
    'multi-two.pdf',
  ]);
});

test('uploads a static image to the deterministic fake-OCR terminal state', async ({
  page,
  request,
}, testInfo) => {
  const projectName = uniqueProjectName('Real static image', testInfo);
  const filename = 'fake-ocr-image.png';
  await createProject(page, projectName);

  await page
    .locator('input[aria-label="Source files"]')
    .setInputFiles(pngFile(filename));
  await page.getByRole('button', { name: 'Upload files' }).click();

  const uploadRow = page
    .getByLabel('Selected source file upload status')
    .locator(':scope > div')
    .filter({ hasText: filename });
  await expect(uploadRow).toContainText('Uploaded', { timeout: 30_000 });

  const project = await projectByName(request, projectName);
  await expect
    .poll(
      async () => {
        const documents = await apiJson<{ items: DocumentRead[] }>(
          request,
          `/projects/${project.id}/documents`,
        );
        const image = documents.items.find(
          (document) => document.filename === filename,
        );
        return image === undefined
          ? null
          : {
              status: image.status,
              pageCount: image.page_count,
              processedPageCount: image.processed_page_count,
              hasText: image.has_text,
              chunksCount: image.chunks_count,
            };
      },
      { timeout: 30_000 },
    )
    .toEqual({
      status: 'no_text_detected',
      pageCount: 1,
      processedPageCount: 1,
      hasText: false,
      chunksCount: 0,
    });

  await expect(
    page.getByText('Parsing finished, but no text was detected.'),
  ).toBeVisible();
  await expect(
    page.locator('.workbench-file-name').getByText(filename, { exact: true }),
  ).toBeVisible();
});

test('recovers after bounded transient document polling failures', async ({
  page,
  request,
}, testInfo) => {
  await configureRules(request, [
    {
      id: 'document-progress',
      method: 'GET',
      pathPattern: '^/projects/[^/]+/documents/[^/]+$',
      failCount: 2,
    },
  ]);
  const projectName = uniqueProjectName('Real polling recovery', testInfo);
  await createProject(page, projectName);

  await page
    .locator('input[aria-label="Source files"]')
    .setInputFiles(
      pdfFile('poll-recovery.pdf', 'Availability requires tested recovery.'),
    );
  await page.getByRole('button', { name: 'Upload files' }).click();

  await expect(page.getByText('Parsing complete.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(async () => (await harnessRule(request, 'document-progress')).failures)
    .toBe(2);
  const stats = await harnessRule(request, 'document-progress');
  expect(stats.matched).toBeGreaterThanOrEqual(3);
  expect(stats.forwarded).toBeGreaterThanOrEqual(1);
  expect(stats.lastForwardStatus).toBe(200);
});

test('cancels an upload before its document id exists and ignores the late response', async ({
  page,
  request,
}, testInfo) => {
  await configureRules(request, [
    {
      id: 'delayed-upload',
      method: 'POST',
      pathPattern: '^/projects/[^/]+/documents$',
      delayBeforeForwardMs: 2_000,
    },
  ]);
  const projectName = uniqueProjectName('Real upload cancellation', testInfo);
  await createProject(page, projectName);

  await page
    .locator('input[aria-label="Source files"]')
    .setInputFiles(
      pdfFile('cancel-before-id.pdf', 'This upload must not commit.'),
    );
  await page.getByRole('button', { name: 'Upload files' }).click();
  const uploadRow = page
    .getByLabel('Selected source file upload status')
    .locator(':scope > div')
    .filter({ hasText: 'cancel-before-id.pdf' });
  await uploadRow.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(uploadRow).toContainText('Canceled');

  await expect
    .poll(async () => (await harnessRule(request, 'delayed-upload')).forwarded, {
      timeout: 15_000,
    })
    .toBe(1);
  const rule = await harnessRule(request, 'delayed-upload');
  expect(rule.lastForwardStatus).toBe(409);
  expect(rule.lastOperationId).not.toBeNull();

  const project = await projectByName(request, projectName);
  const operation = await apiJson<{ status: string; document_id: string | null }>(
    request,
    `/projects/${project.id}/document-operations/${rule.lastOperationId}`,
  );
  expect(operation).toMatchObject({ status: 'canceled', document_id: null });
  const documents = await apiJson<{ items: DocumentRead[] }>(
    request,
    `/projects/${project.id}/documents`,
  );
  expect(documents.items).toEqual([]);
  await expect(page.getByText('cancel-before-id.pdf -')).toHaveCount(0);
});

test('abandons a resumable session through the real practice API', async ({
  page,
  request,
}, testInfo) => {
  const projectName = uniqueProjectName('Real abandon session', testInfo);
  await createProject(page, projectName);
  await uploadAndGenerateQuestions(page, 'abandon-session.pdf');
  await page.getByRole('link', { name: 'Full Exam' }).click();
  await page.getByRole('button', { name: 'Start full exam' }).click();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Question 2 of 2')).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Continue your unfinished practice?' }),
  ).toBeVisible({ timeout: 30_000 });
  const project = await projectByName(request, projectName);
  const activeBefore = await apiJson<{ items: PracticeSessionRead[] }>(
    request,
    `/projects/${project.id}/practice-sessions`,
  );
  expect(activeBefore.items).toHaveLength(1);

  await page.getByRole('button', { name: 'Abandon', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Abandon this session?',
  );
  await page.getByRole('button', { name: 'Confirm abandon' }).click();
  await expect(
    page.getByRole('heading', { name: 'Continue your unfinished practice?' }),
  ).toHaveCount(0);

  const abandoned = await apiJson<PracticeSessionRead>(
    request,
    `/projects/${project.id}/practice-sessions/${activeBefore.items[0]?.id}`,
  );
  expect(abandoned.status).toBe('abandoned');
  const activeAfter = await apiJson<{ items: PracticeSessionRead[] }>(
    request,
    `/projects/${project.id}/practice-sessions`,
  );
  expect(activeAfter.items).toEqual([]);
});

async function createProject(page: Page, projectName: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('Name').fill(projectName);
  await page
    .getByLabel('Description')
    .fill('Browser integration without route interception.');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('button', { name: new RegExp(projectName) }),
  ).toBeVisible();
}

async function uploadAndGenerateQuestions(
  page: Page,
  filename: string,
): Promise<void> {
  await page.locator('input[aria-label="Source files"]').setInputFiles({
    name: filename,
    mimeType: 'application/pdf',
    buffer: minimalPdf(
      'Least privilege limits cloud permissions and reduces credential exposure.',
      'Defense in depth combines independent controls and reduces single points of failure.',
    ),
  });
  await page.getByRole('button', { name: 'Upload files' }).click();

  await expect(
    page.locator('.workbench-file-name').getByText(filename),
  ).toBeVisible();
  const generateQuestions = page.getByRole('button', {
    name: 'Generate questions',
    exact: true,
  });
  await expect(generateQuestions).toBeEnabled({ timeout: 30_000 });
  await generateQuestions.click();
  await expect(page.getByTestId('draft-question-card').first()).toContainText(
    'Playable',
    { timeout: 30_000 },
  );
}

function pdfFile(name: string, text: string) {
  return {
    name,
    mimeType: 'application/pdf',
    buffer: minimalPdf(text),
  };
}

function pngFile(name: string) {
  return {
    name,
    mimeType: 'image/png',
    buffer: minimalPng(),
  };
}

function uniqueProjectName(label: string, testInfo: TestInfo): string {
  return `${label} ${testInfo.retry}`;
}

async function projectByName(
  request: APIRequestContext,
  name: string,
): Promise<ProjectRead> {
  const projects = await apiJson<{ items: ProjectRead[] }>(request, '/projects');
  const project = projects.items.find((candidate) => candidate.name === name);
  expect(project, `project ${name} should exist`).toBeDefined();
  return project as ProjectRead;
}

async function apiJson<T>(
  request: APIRequestContext,
  path: string,
): Promise<T> {
  const response = await request.get(`${apiBaseUrl}${path}`, {
    headers: apiHeaders,
  });
  expect(response.ok(), `${path} returned ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function configureRules(
  request: APIRequestContext,
  rules: object[],
): Promise<void> {
  const response = await request.post(`${apiBaseUrl}/__e2e/rules`, {
    data: { rules },
  });
  expect(response.ok()).toBe(true);
}

async function harnessRule(
  request: APIRequestContext,
  id: string,
): Promise<HarnessRuleStats> {
  const response = await request.get(`${apiBaseUrl}/__e2e/stats`);
  expect(response.ok()).toBe(true);
  const stats = (await response.json()) as HarnessStats;
  const rule = stats.rules.find((candidate) => candidate.id === id);
  expect(rule, `harness rule ${id} should exist`).toBeDefined();
  return rule as HarnessRuleStats;
}
