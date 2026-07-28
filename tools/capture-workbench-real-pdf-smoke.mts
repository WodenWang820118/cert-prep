import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright';

import {
  CAPTURE_RUNTIME_FILE,
  CAPTURE_RUNTIME_RELEASE_ASSETS,
  CAPTURE_RUNTIME_VERSION,
  defaultCaptureRuntimeRoot,
  installCaptureRuntime,
  verifyCaptureRuntimeReleaseDirectory,
} from './install-capture-runtime.mts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const captureWorkbenchRoot = resolve(
  process.env.CAPTURE_WORKBENCH_ROOT ?? join(workspaceRoot, '..', 'capture-workbench'),
);
const releaseRoot = join(captureWorkbenchRoot, 'packages/capture-runtime/dist/release');
const productionExecutable = join(
  captureWorkbenchRoot,
  'packages/capture-runtime/dist/executable/capture-runtime.exe',
);
const realPdfPath = resolve(
  process.env.CERT_PREP_REAL_PDF_PATH ??
    join(workspaceRoot, 'apps/cert-prep-backend/.benchmarks/jlpt-n1-page3-qa.pdf'),
);
const realPdfFileName = basename(realPdfPath);
const realPdfLlmProvider = process.env.CERT_PREP_REAL_PDF_LLM_PROVIDER ?? 'fake';
if (!['fake', 'ollama'].includes(realPdfLlmProvider)) {
  throw new Error('CERT_PREP_REAL_PDF_LLM_PROVIDER must be fake or ollama.');
}
const realPdfReviewTimeoutMs = (() => {
  const rawSeconds = process.env.CERT_PREP_REAL_PDF_REVIEW_TIMEOUT_SECONDS ?? '900';
  const seconds = Number(rawSeconds);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error('CERT_PREP_REAL_PDF_REVIEW_TIMEOUT_SECONDS must be a positive integer.');
  }
  return seconds * 1_000;
})();
const recordingRequested =
  process.argv.includes('--record-video') ||
  process.env.CERT_PREP_RECORD_CAPTURE_VIDEO === 'true';
const recordingPath = resolve(
  process.env.CERT_PREP_CAPTURE_VIDEO_PATH ??
    join(workspaceRoot, 'output', 'capture-workbench-to-cert-prep.webm'),
);
const modelArchiveRoot = join(
  captureWorkbenchRoot,
  'packages/capture-runtime/dist/windowsml',
);
const modelFiles = [
  'det/inference.onnx',
  'det/inference.yml',
  'rec/inference.onnx',
  'rec/inference.yml',
  'rec/ppocr_keys_v1.txt',
  'pipeline.json',
] as const;

type ServerHandle = {
  readonly server: Server;
  readonly baseUrl: string;
};

type ManagedProcess = {
  readonly child: ChildProcess;
  readonly name: string;
  readonly output: () => string;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (!port) throw new Error('Could not reserve a loopback port.');
  return port;
}

function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function processOutput(child: ChildProcess): () => string {
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
    if (output.length > 20_000) output = output.slice(-20_000);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
    if (output.length > 20_000) output = output.slice(-20_000);
  });
  return () => output;
}

function startProcess(
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { readonly shell?: boolean } = {},
): ManagedProcess {
  const child = spawn(command, args, {
    cwd,
    env,
    shell: options.shell,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = processOutput(child);
  child.once('error', (error) => {
    output;
    console.error(`${name} process error: ${error.message}`);
  });
  return { child, name, output };
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000,
    });
    return;
  }
  try {
    process.kill(child.pid, 'SIGTERM');
  } catch {
    // The process already exited.
  }
}

async function stopProcess(processHandle: ManagedProcess | undefined): Promise<void> {
  if (!processHandle) return;
  const { child } = processHandle;
  // On Windows, uv/pnpm/runtime parents can close before their service child
  // does. Always target the handle's process tree so those descendants cannot
  // survive the smoke harness cleanup.
  killProcessTree(child);
  await delay(500);
}

async function waitForHttp(
  url: string,
  predicate: (response: Response) => boolean | Promise<boolean> = (response) => response.ok,
  timeoutMs = 60_000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { Connection: 'close' } });
      if (await predicate(response)) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function waitForGeneratedQuestion(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastBody = '';
  while (Date.now() < deadline) {
    if ((await page.getByTestId('draft-question-card').count()) > 0) return;
    lastBody = await page.locator('body').innerText();
    if (/Manual generation:\s*failed/i.test(lastBody)) {
      throw new Error(
        `Build Workbench manual generation failed before rendering a question: ${lastBody.slice(-1_000)}`,
      );
    }
    await delay(Math.min(1_000, Math.max(100, deadline - Date.now())));
  }
  throw new Error(
    `Timed out waiting for Build Workbench to render a generated question: ${lastBody.slice(-1_000)}`,
  );
}

async function jsonRequest(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers ?? {}) },
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function startMirror(directory: string): Promise<ServerHandle> {
  const server = createServer((request, response) => {
    const pathname = request.url
      ? new URL(request.url, 'http://127.0.0.1').pathname
      : '';
    const expectedPrefix = `/v${CAPTURE_RUNTIME_VERSION}/`;
    const name = pathname.startsWith(expectedPrefix)
      ? pathname.slice(expectedPrefix.length)
      : '';
    if (
      request.method !== 'GET' ||
      !CAPTURE_RUNTIME_RELEASE_ASSETS.includes(name as (typeof CAPTURE_RUNTIME_RELEASE_ASSETS)[number])
    ) {
      response.writeHead(404).end();
      return;
    }
    const stream = createReadStream(join(directory, name));
    stream.once('error', () => response.destroy());
    response.writeHead(200, { Connection: 'close' });
    stream.pipe(response);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Release mirror did not expose a port.');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v${CAPTURE_RUNTIME_VERSION}`,
  };
}

async function closeMirror(mirror: ServerHandle | undefined): Promise<void> {
  if (!mirror) return;
  mirror.server.closeIdleConnections();
  mirror.server.closeAllConnections();
  await new Promise<void>((resolvePromise) => mirror.server.close(() => resolvePromise()));
}

function runCommand(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    cwd,
    env,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.status}: ${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
}

async function prepareModelBundle(temporaryRoot: string): Promise<{
  readonly modelDir: string;
}> {
  const archives = (await readdir(modelArchiveRoot)).filter((name) => name.endsWith('.zip'));
  const archive = archives[0];
  if (!archive) throw new Error(`No WindowsML model archive found under ${modelArchiveRoot}.`);
  const extracted = join(temporaryRoot, 'model-source');
  const modelDir = join(temporaryRoot, 'models');
  await mkdir(extracted, { recursive: true });
  await mkdir(join(modelDir, 'det'), { recursive: true });
  await mkdir(join(modelDir, 'rec'), { recursive: true });
  runCommand('tar', ['-xf', join(modelArchiveRoot, archive), '-C', extracted], workspaceRoot, process.env);
  for (const relativePath of modelFiles) {
    await copyFile(join(extracted, relativePath), join(modelDir, relativePath));
  }
  const details = await stat(join(modelArchiveRoot, archive));
  if (details.size <= 1) {
    throw new Error('WindowsML model archive is empty.');
  }
  return { modelDir };
}

async function prepareReleaseMirror(temporaryRoot: string): Promise<ServerHandle> {
  const mirrorRoot = join(temporaryRoot, 'release-mirror');
  await mkdir(mirrorRoot, { recursive: true });
  for (const name of CAPTURE_RUNTIME_RELEASE_ASSETS) {
    await copyFile(join(releaseRoot, name), join(mirrorRoot, name));
  }
  if (await stat(productionExecutable).then(() => true, () => false)) {
    await copyFile(productionExecutable, join(mirrorRoot, CAPTURE_RUNTIME_FILE));
  }
  const manifestPath = join(mirrorRoot, 'capture-runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const executable = await stat(join(mirrorRoot, CAPTURE_RUNTIME_FILE));
  manifest.fileName = CAPTURE_RUNTIME_FILE;
  manifest.bytes = executable.size;
  manifest.sha256 = await sha256File(join(mirrorRoot, CAPTURE_RUNTIME_FILE));
  await writeFile(
    join(mirrorRoot, `${CAPTURE_RUNTIME_FILE}.sha256`),
    `${manifest.sha256}  ${CAPTURE_RUNTIME_FILE}\n`,
    'utf8',
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await verifyCaptureRuntimeReleaseDirectory(mirrorRoot);
  return startMirror(mirrorRoot);
}

async function waitForRuntime(
  runtimePort: number,
  token: string,
): Promise<void> {
  await waitForHttp(
    `http://127.0.0.1:${runtimePort}/v1/health/ready`,
    (response) => response.status === 401,
    30_000,
  );
  const url = `http://127.0.0.1:${runtimePort}/v1/health/ready`;
  const deadline = Date.now() + 60_000;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    try {
      const authenticated = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Connection: 'close' },
      });
      if (authenticated.ok) {
        const ready = (await authenticated.json()) as Record<string, unknown>;
        const capabilities = ready.capabilities as { structuringModes?: unknown } | undefined;
        if (
          ready.service === 'capture-runtime' &&
          ready.runtimeVersion === CAPTURE_RUNTIME_VERSION &&
          ready.apiVersion === '1.0' &&
          ready.captureDocumentSchemaVersion === '1' &&
          JSON.stringify(capabilities?.structuringModes) === '["host"]'
        ) {
          return;
        }
        lastStatus = 'readiness contract mismatch';
      } else {
        lastStatus = `HTTP ${authenticated.status}`;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Authenticated runtime readiness failed: ${lastStatus}`);
}

async function waitForDocument(
  backendBaseUrl: string,
  token: string,
  projectId: string,
  documentId: string,
): Promise<{ readonly document: Record<string, unknown>; readonly chunks: readonly Record<string, unknown>[] }> {
  // The backend capture coordinator defaults to a 15-minute deadline. A real
  // multi-page Capture Runtime run plus host structuring must be allowed to use
  // that same contract; the smoke must not fail early at an unrelated 5-minute
  // browser polling limit.
  const deadline = Date.now() + 900_000;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    const document = await jsonRequest(
      `${backendBaseUrl}/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    lastStatus = String(document.status);
    if (document.status === 'ready') {
      const chunks = await jsonRequest(
        `${backendBaseUrl}/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/chunks`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return { document, chunks: (chunks.items ?? []) as Record<string, unknown>[] };
    }
    if (['ocr_failed', 'no_text_detected', 'canceled'].includes(String(document.status))) {
      throw new Error(`Real PDF document processing failed with status ${lastStatus}: ${JSON.stringify(document)}`);
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for document ${documentId}; last status ${lastStatus}.`);
}

async function runBrowserFlow(
  frontendBaseUrl: string,
  backendBaseUrl: string,
  runtimeBaseUrl: string,
  token: string,
  projectId: string,
  temporaryRoot: string,
): Promise<void> {
  const browser: Browser = await chromium.launch({ headless: true });
  const videoDirectory = dirname(recordingPath);
  if (recordingRequested) {
    await mkdir(videoDirectory, { recursive: true });
    await rm(recordingPath, { force: true });
  }
  const context = await browser.newContext(
    recordingRequested
      ? {
          recordVideo: {
            dir: videoDirectory,
            size: { width: 1440, height: 1000 },
          },
        }
      : undefined,
  );
  const page: Page = await context.newPage();
  const video = page.video();
  try {
    const runtimeRequests: string[] = [];
    const directRuntimeRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('capture-runtime')) runtimeRequests.push(request.url());
      if (request.url().startsWith(runtimeBaseUrl)) {
        directRuntimeRequests.push(request.url());
        if (request.headers().authorization !== undefined) {
          throw new Error('Capture Runtime bearer token was sent from the browser.');
        }
      }
    });
    await page.addInitScript(
      ({ apiBaseUrl, apiToken, lastProjectId }) => {
        localStorage.setItem('certPrepApiBaseUrl', apiBaseUrl);
        localStorage.setItem('certPrepApiToken', apiToken);
        localStorage.setItem('certPrepLastProjectId', lastProjectId);
      },
      { apiBaseUrl: backendBaseUrl, apiToken: token, lastProjectId: projectId },
    );
    await page.goto(`${frontendBaseUrl}/capture-workbench-trial`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('heading', { name: 'Capture Workbench trial' }).waitFor();
    const input = page.locator('capture-workbench input[type="file"]');
    const uploadResponse = new Promise<{
      readonly captureId: string;
      readonly documentId: string;
    }>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(
        () => rejectPromise(new Error('Timed out waiting for cert-prep upload response.')),
        30_000,
      );
      page.on('response', async (response) => {
        if (response.request().method() !== 'POST' ||
            !response.url().includes(
              `/projects/${encodeURIComponent(projectId)}/capture-workbench/captures`,
            )) {
          return;
        }
        try {
          const body = (await response.json()) as {
            captureId?: unknown;
            documentId?: unknown;
          };
          if (
            response.ok() &&
            typeof body.captureId === 'string' &&
            typeof body.documentId === 'string'
          ) {
            clearTimeout(timeout);
            resolvePromise({ captureId: body.captureId, documentId: body.documentId });
          } else if (!response.ok()) {
            clearTimeout(timeout);
            rejectPromise(
              new Error(`Cert Prep Capture Workbench upload failed with HTTP ${response.status()}.`),
            );
          }
        } catch (error) {
          clearTimeout(timeout);
          rejectPromise(error);
        }
      });
    });
    await input.setInputFiles(realPdfPath);
    const capture = await uploadResponse;
    const documentId = capture.documentId;
    const pendingDocument = await jsonRequest(
      `${backendBaseUrl}/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (pendingDocument.status !== 'processing' || Number(pendingDocument.chunks_count) !== 0) {
      throw new Error(
        `Review gate did not keep the document pending: ${JSON.stringify(pendingDocument)}`,
      );
    }
    try {
      await page
        .getByRole('heading', { name: 'Review capture text' })
        .waitFor({ timeout: realPdfReviewTimeoutMs });
    } catch (error) {
      const bodyText = await page.locator('body').innerText();
      await page.screenshot({ path: join(temporaryRoot, 'real-pdf-review-timeout.png'), fullPage: true });
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `Real PDF Capture review UI did not appear. Body:\n${bodyText}`,
      );
    }
    const firstReviewField = page.locator('capture-workbench .ocr-review textarea').first();
    await firstReviewField.waitFor({ state: 'visible', timeout: 60_000 });
    const originalReviewText = await firstReviewField.inputValue();
    if (originalReviewText.trim().length === 0) {
      throw new Error('Real PDF Capture review did not expose text for the first page.');
    }
    const reviewMarker = '\n\n[reviewed by real PDF smoke]';
    await firstReviewField.fill(`${originalReviewText}${reviewMarker}`);
    await page.getByRole('button', { name: 'Confirm capture', exact: true }).click();
    const processed = await waitForDocument(backendBaseUrl, token, projectId, documentId);
    const firstReviewedText = String(processed.chunks[0]?.text ?? '');
    const firstRawText = String(processed.chunks[0]?.raw_text ?? '');
    if (!firstReviewedText.includes('[reviewed by real PDF smoke]')) {
      throw new Error('Confirmed Capture edit was not persisted in the reviewed chunk text.');
    }
    if (firstRawText !== originalReviewText) {
      throw new Error('Original Capture text was not retained in raw_text after review confirmation.');
    }
    console.log(`Real PDF backend persistence ready: ${processed.chunks.length} chunks.`);
    await page
      .getByRole('heading', { name: 'Capture document saved' })
      .waitFor({ timeout: 90_000 });
    try {
      await page.waitForFunction(
        () => {
          const text = document.body.innerText;
          return text.includes('ready') && text.includes('windowsml_ocr');
        },
        undefined,
        { timeout: 90_000 },
      );
    } catch (error) {
      const bodyText = await page.locator('body').innerText();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `Real PDF page did not show the saved Capture projection:\n${bodyText}`,
      );
    }
    const bodyText = await page.locator('body').innerText();
    if (!bodyText.includes('ready') || !bodyText.includes('windowsml_ocr')) {
      throw new Error(`Real PDF page did not show the saved Capture projection:\n${bodyText}`);
    }
    if (bodyText.includes('deterministic') || bodyText.includes('in-memory')) {
      throw new Error('The real PDF page exposed a fake/in-memory implementation label.');
    }
    if (directRuntimeRequests.length !== 0) {
      throw new Error(`Browser called Capture Runtime directly: ${directRuntimeRequests.join(', ')}`);
    }
    if (runtimeRequests.some((url) => url.includes('token') || url.includes('Authorization'))) {
      throw new Error(`Browser made an unsafe Capture Runtime request: ${runtimeRequests.join(', ')}`);
    }
    const downloadButton = page.getByRole('button', { name: 'Download Markdown' });
    await downloadButton.waitFor({ state: 'visible', timeout: 90_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      downloadButton.click(),
    ]);
    const markdownPath = join(temporaryRoot, 'real-pdf-capture.md');
    await download.saveAs(markdownPath);
    const markdown = await readFile(markdownPath, 'utf8');
    const expectedMarkdownFilename = realPdfFileName.replace(/\.[^.]+$/, '.md');
    if (download.suggestedFilename() !== expectedMarkdownFilename) {
      throw new Error(
        `Unexpected Markdown filename: ${download.suggestedFilename()} ` +
          `(expected ${expectedMarkdownFilename}).`,
      );
    }
    const firstOcrText = String(processed.chunks[0]?.text ?? '').trim();
    const lastPageNumber = Math.max(
      ...processed.chunks.map((chunk) => Number(chunk.page_number ?? 0)),
    );
    if (
      !markdown.includes(`# ${realPdfFileName}`) ||
      !markdown.includes('## Page 1') ||
      !markdown.includes(`## Page ${lastPageNumber}`) ||
      firstOcrText.length === 0 ||
      !markdown.includes(firstOcrText.slice(0, Math.min(firstOcrText.length, 80)))
    ) {
      throw new Error(
        'Downloaded Markdown did not contain the persisted Capture projection: ' +
          JSON.stringify({
            expectedTitle: `# ${realPdfFileName}`,
            firstOcrText: firstOcrText.slice(0, 120),
            markdown: markdown.slice(0, 600),
            hasReviewMarker: markdown.includes('[reviewed by real PDF smoke]'),
          }),
      );
    }
    console.log(`Markdown download started: ${download.suggestedFilename()}`);
    await page.getByRole('link', { name: 'Build', exact: true }).click();
    await page.getByRole('heading', { name: 'Cert Prep' }).waitFor({ timeout: 90_000 });
    const generateQuestions = page.getByRole('button', {
      name: 'Generate questions',
      exact: true,
    });
    await generateQuestions.waitFor({ state: 'visible', timeout: 90_000 });
    if (!(await generateQuestions.isEnabled())) {
      throw new Error('Build Workbench kept Generate questions disabled after parsing.');
    }
    await generateQuestions.click();
    await waitForGeneratedQuestion(page, realPdfReviewTimeoutMs);
    const firstQuestion = page.getByTestId('draft-question-card').first();
    await firstQuestion.waitFor({ state: 'visible', timeout: 90_000 });
    await firstQuestion.getByText('Playable', { exact: true }).waitFor({
      state: 'visible',
      timeout: 90_000,
    });
    const firstQuestionHeading = firstQuestion.getByRole('heading').first();
    await firstQuestionHeading.waitFor({ state: 'visible', timeout: 90_000 });
    const firstQuestionText = (await firstQuestionHeading.innerText()).trim();
    if (firstQuestionText.length < 8) {
      throw new Error('Build Workbench generated an empty or incomplete question stem.');
    }
    if (
      realPdfLlmProvider === 'fake' &&
      firstQuestionText !== 'Which action best applies the cited exam concept?'
    ) {
      throw new Error(`Unexpected deterministic question stem: ${firstQuestionText}`);
    }
    const generatedQuestionCount = await page.getByTestId('draft-question-card').count();
    if (generatedQuestionCount < 1) {
      throw new Error('Build Workbench did not render any generated question cards.');
    }
    console.log(`Build Workbench generated ${generatedQuestionCount} playable question(s).`);
    await page.screenshot({ path: join(temporaryRoot, 'real-pdf-completed.png'), fullPage: true });
  } finally {
    await context.close();
    const generatedVideoPath = await video?.path();
    if (recordingRequested && generatedVideoPath !== undefined) {
      await copyFile(generatedVideoPath, recordingPath);
      console.log(`Browser recording saved: ${recordingPath}`);
    }
    await browser.close();
  }
}

async function runSmoke(): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Real capture-workbench PDF smoke requires Windows x64.');
  }
  const pdfDetails = await stat(realPdfPath);
  if (pdfDetails.size <= 0) throw new Error(`Real PDF fixture is empty: ${realPdfPath}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'cert-prep-capture-workbench-real-pdf-'));
  let mirror: ServerHandle | undefined;
  let runtime: ManagedProcess | undefined;
  let backend: ManagedProcess | undefined;
  let frontend: ManagedProcess | undefined;
  let browserFailure: unknown;
  try {
    const { modelDir } = await prepareModelBundle(temporaryRoot);
    mirror = await prepareReleaseMirror(temporaryRoot);
    const consumerWorkspace = join(temporaryRoot, 'cert-prep-consumer');
    await mkdir(consumerWorkspace, { recursive: true });
    const installed = await installCaptureRuntime({
      workspaceRoot: consumerWorkspace,
      baseUrl: mirror.baseUrl,
      outputRoot: defaultCaptureRuntimeRoot(consumerWorkspace),
    });
    const runtimePort = await findFreePort();
    const backendPort = await findFreePort();
    const frontendPort = await findFreePort();
    const runtimeToken = `capture-runtime-real-pdf-${randomUUID()}`;
    const backendToken = `cert-prep-real-pdf-${randomUUID()}`;
    const runtimeData = join(temporaryRoot, 'runtime-data');
    const backendData = join(temporaryRoot, 'backend-data');
    await mkdir(runtimeData, { recursive: true });
    await mkdir(backendData, { recursive: true });
    runtime = startProcess(
      'capture-runtime',
      join(installed.outputRoot, CAPTURE_RUNTIME_FILE),
      ['serve', '--host', '127.0.0.1', '--port', String(runtimePort)],
      installed.outputRoot,
      {
        ...process.env,
        CAPTURE_HOST: '127.0.0.1',
        CAPTURE_PORT: String(runtimePort),
        CAPTURE_API_TOKEN: runtimeToken,
        CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${runtimePort}`,
        CAPTURE_ALLOWED_ORIGINS: '',
        CAPTURE_ENABLE_API_DOCS: 'false',
        CAPTURE_APP_DATA_DIR: runtimeData,
        CAPTURE_EXTRACTION_PROVIDER: 'runtime',
        CAPTURE_STRUCTURING_PROVIDER: 'host',
        CAPTURE_WINDOWSML_MODEL_DIR: modelDir,
      },
    );
    await waitForRuntime(runtimePort, runtimeToken).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${runtime.output()}`);
    });

    const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
    backend = startProcess(
      'cert-prep-backend',
      'uv',
      ['run', 'uvicorn', '--app-dir', 'src', 'cert_prep_backend.api.app:create_app', '--factory', '--host', '127.0.0.1', '--port', String(backendPort)],
      join(workspaceRoot, 'apps/cert-prep-backend'),
      {
        ...process.env,
        CERT_PREP_DATA_DIR: backendData,
        CERT_PREP_API_TOKEN: backendToken,
        CERT_PREP_ALLOWED_ORIGINS: JSON.stringify([`http://127.0.0.1:${frontendPort}`]),
        // Capture Runtime owns extraction and the cert-prep host owns document
        // projection. The provider is configurable so the smoke can prove the
        // deterministic app path or exercise the installed Ollama profile.
        CERT_PREP_LLM_PROVIDER: realPdfLlmProvider,
        CERT_PREP_CAPTURE_RUNTIME_URL: `http://127.0.0.1:${runtimePort}`,
        CERT_PREP_CAPTURE_RUNTIME_TOKEN: runtimeToken,
        CERT_PREP_CAPTURE_RUNTIME_VERSION: CAPTURE_RUNTIME_VERSION,
        CERT_PREP_CAPTURE_RUNTIME_API_VERSION: '1.0',
        CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_VERSION: '1',
        CERT_PREP_CAPTURE_RUNTIME_POLL_INTERVAL_SECONDS: '0.2',
        CERT_PREP_CAPTURE_RUNTIME_JOB_TIMEOUT_SECONDS: '900',
      },
    );
    await waitForHttp(`${backendBaseUrl}/health`, undefined, 90_000).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${backend.output()}`);
    });
    const project = await jsonRequest(`${backendBaseUrl}/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${backendToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Real PDF smoke ${randomUUID()}`, description: 'Temporary real Capture Workbench OCR smoke.' }),
    });
    const projectId = String(project.id);
    if (!projectId || projectId === 'undefined') throw new Error('Backend did not return a project id.');

    frontend = startProcess(
      'cert-prep-frontend',
      'corepack',
      ['pnpm', 'nx', 'serve', 'cert-prep', '--host=127.0.0.1', `--port=${frontendPort}`],
      workspaceRoot,
      process.env,
      { shell: true },
    );
    const frontendBaseUrl = `http://127.0.0.1:${frontendPort}`;
    await waitForHttp(frontendBaseUrl, undefined, 90_000).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${frontend.output()}`);
    });
    try {
      await runBrowserFlow(
        frontendBaseUrl,
        backendBaseUrl,
        `http://127.0.0.1:${runtimePort}`,
        backendToken,
        projectId,
        temporaryRoot,
      );
    } catch (error) {
      browserFailure = error;
      throw error;
    }

    const documents = await jsonRequest(`${backendBaseUrl}/projects/${encodeURIComponent(projectId)}/documents`, {
      headers: { Authorization: `Bearer ${backendToken}` },
    });
    const uploaded = (documents.items as Record<string, unknown>[] | undefined)?.find(
      (item) => item.filename === realPdfFileName,
    );
    if (!uploaded) throw new Error(`Backend did not persist ${realPdfPath}.`);
    const processed = await waitForDocument(backendBaseUrl, backendToken, projectId, String(uploaded.id));
    if (
      processed.document.status !== 'ready' ||
      processed.document.has_text !== true ||
      processed.document.extraction_method !== 'windowsml_ocr' ||
      Number(processed.document.chunks_count) <= 0 ||
      processed.chunks.some((chunk) => String(chunk.text ?? '').trim().length === 0)
    ) {
      throw new Error(`Real Capture persistence contract failed: ${JSON.stringify(processed)}`);
    }
    const captureJobsRoot = join(runtimeData, 'jobs', 'captures');
    const remainingJobs = await readdir(captureJobsRoot).catch(() => [] as string[]);
    if (remainingJobs.length !== 0) {
      throw new Error(`Capture Runtime job cleanup failed: ${remainingJobs.join(', ')}`);
    }
    console.log(
      `cert-prep real PDF smoke passed: ${processed.document.filename}, ${processed.chunks.length} Capture chunks, extraction=${processed.document.extraction_method}`,
    );
  } catch (error) {
    console.error(
      `Real PDF smoke failed${browserFailure === undefined ? ' before browser completion' : ''}. Runtime output:\n${runtime?.output() ?? ''}`,
    );
    console.error(`Backend output:\n${backend?.output() ?? ''}`);
    console.error(`Frontend output:\n${frontend?.output() ?? ''}`);
    throw error;
  } finally {
    await stopProcess(frontend);
    await stopProcess(backend);
    await stopProcess(runtime);
    await closeMirror(mirror);
    const relativeRoot = temporaryRoot
      .replace(resolve(tmpdir()), '')
      .replace(/^[/\\]+/u, '');
    if (!relativeRoot || relativeRoot === '..' || relativeRoot.startsWith(`..${sep}`)) {
      throw new Error(`Refusing to remove unexpected smoke path: ${temporaryRoot}`);
    }
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runSmoke().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
