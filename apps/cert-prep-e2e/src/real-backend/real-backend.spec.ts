import { createHash } from 'node:crypto';
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
const captureRuntimeBaseUrl = 'http://127.0.0.1:8767';
const captureRuntimeHeaders = {
  Authorization: 'Bearer real-e2e-capture-runtime-token',
};

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

test('enforces the fixture v2 ingestion, live replay SSE, and host commit contract', async ({
  request,
}) => {
  const unauthorized = await request.get(
    `${captureRuntimeBaseUrl}/v2/health/ready`,
  );
  expect(unauthorized.status()).toBe(401);

  const readiness = await request.get(
    `${captureRuntimeBaseUrl}/v2/health/ready`,
    { headers: captureRuntimeHeaders },
  );
  expect(readiness.ok()).toBe(true);
  await expect(readiness.json()).resolves.toMatchObject({
    apiVersion: '2.0',
    runtimeVersion: '0.4.0',
    captureDocumentSchemaVersion: '2',
    contractSetVersion: '2',
  });
  const streamingReadiness = await request.get(
    `${captureRuntimeBaseUrl}/v2/streaming/health/ready`,
    { headers: captureRuntimeHeaders },
  );
  expect(streamingReadiness.ok()).toBe(true);
  await expect(streamingReadiness.json()).resolves.toMatchObject({
    protocolVersion: '2',
    maxChunkBytes: 1024 * 1024,
  });

  const sourceBytes = Buffer.from('deterministic v2 fixture PDF bytes');
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const clientRequestId = `fixture-contract-${Date.now()}`;
  const open = await request.post(`${captureRuntimeBaseUrl}/v2/ingestions`, {
    headers: captureRuntimeHeaders,
    data: {
      protocolVersion: '2',
      kind: 'pdf',
      mode: 'file',
      clientRequestId,
      fileName: 'fixture-v2.pdf',
      mediaType: 'application/pdf',
      totalBytes: sourceBytes.length,
      sourceSha256,
    },
  });
  expect(open.status()).toBe(201);
  const ingestion = (await open.json()) as {
    ingestionId: string;
    nextChunkIndex: number;
    nextOffset: number;
  };
  expect(ingestion).toMatchObject({ nextChunkIndex: 0, nextOffset: 0 });

  const chunkHeaders = {
    ...captureRuntimeHeaders,
    'Content-Type': 'application/octet-stream',
    'Content-Range': `bytes 0-${sourceBytes.length - 1}/${sourceBytes.length}`,
    Digest: `sha-256=${sourceSha256}`,
    'X-Idempotency-Key': `${clientRequestId}-chunk-0`,
  };
  const chunk = await request.put(
    `${captureRuntimeBaseUrl}/v2/ingestions/${ingestion.ingestionId}/chunks/0`,
    { headers: chunkHeaders, data: sourceBytes },
  );
  expect(chunk.ok()).toBe(true);
  await expect(chunk.json()).resolves.toMatchObject({
    receivedBytes: sourceBytes.length,
    contiguousBytes: sourceBytes.length,
    nextChunkIndex: 1,
    nextOffset: sourceBytes.length,
  });
  const replayedChunk = await request.put(
    `${captureRuntimeBaseUrl}/v2/ingestions/${ingestion.ingestionId}/chunks/0`,
    { headers: chunkHeaders, data: sourceBytes },
  );
  expect(replayedChunk.ok()).toBe(true);
  await expect(replayedChunk.json()).resolves.toMatchObject({
    receivedBytes: sourceBytes.length,
    nextChunkIndex: 1,
  });

  const finalized = await request.post(
    `${captureRuntimeBaseUrl}/v2/ingestions/${ingestion.ingestionId}/finalize`,
    {
      headers: captureRuntimeHeaders,
      data: {
        protocolVersion: '2',
        totalBytes: sourceBytes.length,
        sha256: sourceSha256,
      },
    },
  );
  expect(finalized.ok()).toBe(true);
  await expect(finalized.json()).resolves.toMatchObject({
    status: 'ready',
    finalizedSha256: sourceSha256,
  });

  const started = await request.post(`${captureRuntimeBaseUrl}/v2/captures`, {
    headers: captureRuntimeHeaders,
    data: {
      protocolVersion: '2',
      clientRequestId,
      ingestionId: ingestion.ingestionId,
      structuringMode: 'host',
      startPolicy: 'eager',
    },
  });
  expect(started.status()).toBe(202);
  const operation = (await started.json()) as {
    captureId: string;
    createdAt: string;
    status: string;
  };
  expect(operation.status).toBe('extracting');

  const liveController = new AbortController();
  const liveResponse = await fetch(
    `${captureRuntimeBaseUrl}/v2/captures/${operation.captureId}/events`,
    {
      headers: {
        ...captureRuntimeHeaders,
        Accept: 'text/event-stream',
        'Last-Event-ID': '0',
      },
      signal: liveController.signal,
    },
  );
  expect(liveResponse.status).toBe(200);
  expect(liveResponse.headers.get('content-type')).toContain(
    'text/event-stream',
  );
  const reader = liveResponse.body?.getReader();
  expect(reader).toBeDefined();
  const liveFrames = await readThroughEvent(
    reader as ReadableStreamDefaultReader<Uint8Array>,
    'event: checkpoint',
  );
  liveController.abort();
  await reader?.cancel().catch(() => undefined);
  expect(liveFrames).not.toContain('id: 0\n');
  expect(liveFrames).toContain('id: 1\nevent: segment');
  expect(liveFrames).toContain('id: 2\nevent: checkpoint');

  const disconnectedSnapshot = await request.get(
    `${captureRuntimeBaseUrl}/v2/captures/${operation.captureId}`,
    { headers: captureRuntimeHeaders },
  );
  await expect(disconnectedSnapshot.json()).resolves.toMatchObject({
    status: 'awaiting_structuring',
    lastEventSequence: 2,
  });

  const partialResponse = await request.get(
    `${captureRuntimeBaseUrl}/v2/captures/${operation.captureId}/partial`,
    { headers: captureRuntimeHeaders },
  );
  expect(partialResponse.ok()).toBe(true);
  const partial = (await partialResponse.json()) as {
    source: Record<string, unknown>;
    segments: Array<Record<string, unknown>>;
    sourceText: string;
    extractionEngine: Record<string, unknown>;
    updatedAt: string;
  };
  const candidate = fixtureCandidate(
    partial,
    operation.createdAt,
    sourceSha256,
  );
  const committed = await request.post(
    `${captureRuntimeBaseUrl}/v2/captures/${operation.captureId}/structure/commit`,
    {
      headers: {
        ...captureRuntimeHeaders,
        'X-Idempotency-Key': `${clientRequestId}-commit`,
      },
      data: candidate,
    },
  );
  expect(committed.ok()).toBe(true);
  await expect(committed.json()).resolves.toMatchObject({
    status: 'completed',
    lastEventSequence: 3,
  });

  const terminalReplay = await request.get(
    `${captureRuntimeBaseUrl}/v2/captures/${operation.captureId}/events`,
    {
      headers: {
        ...captureRuntimeHeaders,
        Accept: 'text/event-stream',
        'Last-Event-ID': '2',
      },
    },
  );
  expect(terminalReplay.ok()).toBe(true);
  const terminalFrames = await terminalReplay.text();
  expect(terminalFrames).toContain('id: 3\nevent: completed');
  expect(terminalFrames).not.toContain('id: 2\n');

  const result = await request.get(
    `${captureRuntimeBaseUrl}/v2/captures/${operation.captureId}/result`,
    { headers: captureRuntimeHeaders },
  );
  await expect(result.json()).resolves.toMatchObject({
    operation: { status: 'completed' },
    raw: { diagnosticOnly: true, sourceText: partial.sourceText },
    result: { schemaVersion: '2', source: partial.source },
  });
  const deleted = await request.delete(
    `${captureRuntimeBaseUrl}/v2/captures/${operation.captureId}`,
    { headers: captureRuntimeHeaders },
  );
  expect(deleted.status()).toBe(204);
  expect(await deleted.body()).toHaveLength(0);
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

test('uploads a static image to the deterministic Capture Runtime terminal state', async ({
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

async function readThroughEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  eventMarker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let frames = '';
  while (!frames.includes(eventMarker)) {
    const next = await reader.read();
    if (next.done) break;
    frames += decoder.decode(next.value, { stream: true });
  }
  return frames;
}

function fixtureCandidate(
  partial: {
    source: Record<string, unknown>;
    segments: Array<Record<string, unknown>>;
    sourceText: string;
    extractionEngine: Record<string, unknown>;
    updatedAt: string;
  },
  createdAt: string,
  sourceSha256: string,
): Record<string, unknown> {
  const blocks = partial.segments.map((segment, index) => ({
    blockId: `fixture-block-${index}`,
    order: index,
    type: 'paragraph',
    sourceSegmentId: segment['segmentId'],
    locator: segment['locator'],
    sourceText: segment['text'],
    targetText: segment['text'],
  }));
  return {
    schemaVersion: '2',
    source: partial.source,
    rawSegments: partial.segments,
    blocks,
    sourceText: partial.sourceText,
    targetText: blocks.map((block) => block.targetText).join('\n'),
    extractionEngine: partial.extractionEngine,
    structuringEngine: {
      engine: 'cert-prep-e2e-host',
      model: 'deterministic',
      digest: `sha256:${sourceSha256}`,
      device: null,
    },
    warnings: [],
    createdAt,
    completedAt: partial.updatedAt,
  };
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
