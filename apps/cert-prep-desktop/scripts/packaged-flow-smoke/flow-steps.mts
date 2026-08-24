import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Locator } from 'playwright';

import {
  activePage,
  bodyText,
  clickButtonPattern,
  clickButtonText,
  closeRuntimeDrawer,
  escapeRegExp,
  log,
  screenshot,
  waitLocatorText,
  waitText,
} from './runner-context.mts';
import {
  answerForVisiblePracticeQuestion,
  captureDocumentOcrEvidence,
  captureFullExamSessionCreate,
  captureLlmHealth,
  EXPECTED_BASELINE_CHUNKS,
  EXPECTED_BASELINE_PAGES,
  FIRST_CHUNK_TEXT_PATTERN,
  observeFirstChunkVisibleFromParseStart,
  observeStreamingDraftUiUntil,
  recordFirstChunkVisible,
  refreshFirstChunkGateMetrics,
  waitForStreamingJobsComplete,
  waitForUploadDocumentResponse,
} from './streaming-capture.mts';
import { FIRST_CHUNK_GATE_MS } from './streaming-evidence.mts';
import { captureGenerationReadinessAtProjectCreate } from './generation-readiness.mts';
import type { SmokeRunState } from './types.mts';

export async function createProject(run: SmokeRunState): Promise<void> {
  await closeRuntimeDrawer(run);
  // The acceptance app-data directory is isolated per run, so a stable name
  // keeps the project-created screenshot deterministic across retries.
  const projectName = 'Parallel Parsing QA';
  await clickButtonText(run, 'Create project');
  await activePage(run).locator('#projectName').fill(projectName);
  await activePage(run)
    .locator('#projectDescription')
    .fill(
      'Packaged QA flow for parallel parsing, reasoning model UX, and wrong-answer review.',
    );
  await captureGenerationReadinessAtProjectCreate(run, () =>
    clickButtonText(run, 'Create project'),
  );
  await waitText(
    run,
    new RegExp(escapeRegExp(projectName)),
    30_000,
    'project created and selected',
  );
  await screenshot(run, 'project-created');
  run.metrics.project_name = projectName;
}

export async function uploadAndParsePdf(run: SmokeRunState): Promise<void> {
  await activePage(run)
    .locator('label')
    .filter({ hasText: 'Language' })
    .locator('select')
    .selectOption('ja');
  await activePage(run)
    .locator('input[type="file"]')
    .setInputFiles(run.options.pdfPath);
  await waitText(
    run,
    new RegExp(escapeRegExp(basename(run.options.pdfPath))),
    10_000,
    'selected PDF visible',
  );
  await screenshot(run, 'pdf-selected-language-ja');

  const uploadDocumentResponse = waitForUploadDocumentResponse(run);
  const uploadStart = Date.now();
  await clickButtonText(run, 'Upload files', { timeout: 120_000 });
  await waitText(
    run,
    /Parsing started|Parsing continues|0\/\d+ pages|processing/i,
    30_000,
    'upload response / parsing visible',
  );
  run.metrics.ui_timings_ms.upload_to_processing_visible =
    Date.now() - uploadStart;
  const parseStart = Date.now();
  run.streamingDraftParseStartedAt = parseStart;
  run.streamingDraftCaptureOpen = true;
  const firstChunkObservation = observeFirstChunkVisibleFromParseStart(
    run,
    parseStart,
  );

  try {
    const uploadedDocument = await uploadDocumentResponse;
    run.uploadedDocument = uploadedDocument;
    if (uploadedDocument) {
      run.metrics.observations.push(
        `Captured upload document reference for streaming API polling: ${uploadedDocument.documentId}.`,
      );
    } else {
      run.metrics.observations.push(
        'Upload document response was not captured; streaming evidence is limited to UI/API responses.',
      );
    }
    await screenshot(run, 'parsing-started');

    await delay(FIRST_CHUNK_GATE_MS);
    const midText = await bodyText(run);
    if (FIRST_CHUNK_TEXT_PATTERN.test(midText)) {
      recordFirstChunkVisible(run, parseStart);
    } else {
      run.metrics.observations.push(
        'No extracted chunk was visible 15s after parsing started.',
      );
      refreshFirstChunkGateMetrics(run);
    }
    await screenshot(run, 'mid-parse-ui-still-usable');

    await firstChunkObservation.done;

    const parseCompletePromise = waitText(
      run,
      /Parsing complete\.|46\/46 pages|ready\s*Page|OCR failed|Parsing failed|WindowsML OCR is unavailable/i,
      300_000,
      'parsing complete',
    ).then(() => {
      run.metrics.ui_timings_ms.parse_complete_visible =
        Date.now() - parseStart;
    });
    await observeStreamingDraftUiUntil(
      run,
      parseStart,
      parseCompletePromise,
      uploadedDocument,
    );
    await parseCompletePromise;
    const terminalText = await bodyText(run);
    if (
      /OCR failed|Parsing failed|WindowsML OCR is unavailable|requires WindowsML OCR/i.test(
        terminalText,
      )
    ) {
      throw new Error(
        `PDF parsing reached a terminal OCR failure: ${terminalText.match(/(?:OCR failed|Parsing failed|WindowsML OCR is unavailable|requires WindowsML OCR)[^\r\n]*/i)?.[0] ?? 'unknown OCR failure'}.`,
      );
    }
    recordOcrCompletionFromText(run, terminalText);
    if (uploadedDocument) {
      await captureDocumentOcrEvidence(run, uploadedDocument);
      await captureLlmHealth(run, uploadedDocument);
    }
    if (run.options.waitForStreamingComplete) {
      if (!uploadedDocument) {
        throw new Error(
          'Cannot wait for streaming completion without upload API reference.',
        );
      }
      try {
        await waitForStreamingJobsComplete(run, uploadedDocument, parseStart);
      } catch (error) {
        await captureLlmHealth(run, uploadedDocument);
        throw error;
      }
      await captureLlmHealth(run, uploadedDocument);
    }
  } finally {
    firstChunkObservation.stop();
    await firstChunkObservation.done;
    run.streamingDraftCaptureOpen = false;
  }
  await screenshot(run, 'parsing-complete-with-metrics');
}

function recordOcrCompletionFromText(run: SmokeRunState, text: string): void {
  const pagesMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*pages/i);
  const chunksMatch = text.match(/\b(\d+)\s+chunks\b/i);
  run.metrics.ocr_completion = {
    pages_processed: pagesMatch ? Number(pagesMatch[1]) : null,
    total_pages: pagesMatch ? Number(pagesMatch[2]) : null,
    chunks: chunksMatch ? Number(chunksMatch[1]) : null,
    expected_pages: EXPECTED_BASELINE_PAGES,
    expected_chunks: EXPECTED_BASELINE_CHUNKS,
  };
}

export async function createAndEditQuestion(run: SmokeRunState): Promise<void> {
  if (!run.uploadedDocument) {
    throw new Error(
      'Cannot create QA question without uploaded document reference.',
    );
  }

  const createStart = Date.now();
  await clickButtonText(run, 'Generate questions', { timeout: 120_000 });
  const generatedArticle = activePage(run)
    .locator('app-draft-review-panel [data-testid="draft-question-card"]')
    .first();
  await generatedArticle.waitFor({ state: 'visible', timeout: 10 * 60_000 });
  const generatedQuestion = (
    await generatedArticle.locator('h3').first().innerText()
  ).trim();
  if (!generatedQuestion) {
    throw new Error(
      'Real question generation did not produce a visible question.',
    );
  }
  run.metrics.ui_timings_ms.question_creation = Date.now() - createStart;

  await activePage(run).reload({ waitUntil: 'domcontentloaded' });
  await waitText(
    run,
    new RegExp(escapeRegExp(generatedQuestion)),
    60_000,
    'generated question visible',
  );
  await screenshot(run, 'editable-question-created');

  const questionArticle = activePage(run)
    .locator('app-draft-review-panel article')
    .filter({ hasText: generatedQuestion })
    .first();
  const editButton = questionArticle
    .locator('button')
    .filter({ hasText: /^\s*Edit\s*$/ })
    .first();
  await editButton.waitFor({ state: 'visible', timeout: 30_000 });
  await questionArticle.scrollIntoViewIfNeeded({ timeout: 30_000 });
  await editButton.evaluate((button) => {
    if (button instanceof HTMLElement) {
      button.click();
      return;
    }
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });

  const editingArticle = activePage(run)
    .locator('app-draft-review-panel article')
    .first();
  await editingArticle.locator('textarea').first().waitFor({
    state: 'visible',
    timeout: 10_000,
  });
  const questionInput = editingArticle.locator('input').first();
  await questionInput.waitFor({ state: 'visible', timeout: 30_000 });
  await questionInput.fill('Packaged smoke edited question?');
  await editingArticle
    .locator('textarea')
    .fill(
      'Edited packaged smoke rationale validates save, practice, and wrong-answer clearing in the packaged app.',
    );
  await screenshot(run, 'editable-question-editing');

  const saveStart = Date.now();
  const saveButton = editingArticle
    .locator('button')
    .filter({ hasText: /^\s*Save\s*$/ })
    .first();
  await saveButton.waitFor({ state: 'visible', timeout: 30_000 });
  await saveButton.evaluate((button) => {
    if (button instanceof HTMLElement) {
      button.click();
      return;
    }
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
  await waitText(
    run,
    /Question saved|Packaged smoke edited question\?/i,
    60_000,
    'question saved',
  );
  run.metrics.ui_timings_ms.question_save = Date.now() - saveStart;
  await screenshot(run, 'editable-question-saved');
}

export async function verifyStreamingPracticeReady(
  run: SmokeRunState,
): Promise<void> {
  const parseStart = run.streamingDraftParseStartedAt ?? Date.now();
  await clickButtonPattern(run, /^\s*Full Exam\s*$/);
  await waitText(
    run,
    /Start full exam|Full Exam/i,
    10_000,
    'streamed full exam mode',
  );

  const startButton = activePage(run)
    .locator('button')
    .filter({ hasText: /^\s*Start full exam\s*$/ })
    .first();
  await startButton.waitFor({ state: 'visible', timeout: 30_000 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await startButton.isEnabled()) {
      run.metrics.ui_timings_ms.practice_ready_visible_ms =
        Date.now() - parseStart;
      await screenshot(run, 'streaming-practice-ready');
      const [fullExamQuestionCount] = await Promise.all([
        captureFullExamSessionCreate(run),
        startButton.click({ timeout: 30_000 }),
      ]);
      run.metrics.full_exam_question_count = fullExamQuestionCount;
      await waitText(
        run,
        /Submit answer|Choices/,
        30_000,
        'streamed practice first question visible',
      );
      run.metrics.ui_timings_ms.practice_first_question_visible_ms =
        Date.now() - parseStart;
      run.metrics.practice_ready_from_streamed_questions = true;
      await screenshot(run, 'streaming-practice-first-question');
      return;
    }
    await delay(500);
  }

  const text = await bodyText(run);
  throw new Error(
    `Streamed questions did not enable practice readiness. Body=${text.slice(0, 1400)}`,
  );
}

export async function runFullExamWrongAnswer(
  run: SmokeRunState,
): Promise<void> {
  await clickButtonPattern(run, /^\s*Full Exam\s*$/);
  await waitText(run, /Start full exam|Full Exam/i, 10_000, 'full exam mode');
  await screenshot(run, 'full-exam-ready');
  await clickButtonText(run, 'Start full exam');
  await waitText(
    run,
    /Submit answer|Choices/,
    30_000,
    'full exam question visible',
  );
  const article = activePage(run).locator('app-practice-panel article').first();
  await article.waitFor({ state: 'visible', timeout: 30_000 });
  log(run, 'full exam practice article connected');
  const isFakeProvider = run.options.llmProvider === 'fake';
  const questionText = isFakeProvider
    ? ''
    : await article.locator('h3').first().innerText();
  log(run, 'full exam visible answer selection started');
  // The real acceptance package deliberately uses the deterministic fake
  // provider. Its answer is part of that provider's contract, so avoid a
  // second API round-trip here and keep the wrong-answer assertion focused on
  // the packaged practice flow. Non-fake smoke runs still resolve the answer
  // from the persisted draft API.
  const correctAnswer = isFakeProvider
    ? 'Apply the cited concept'
    : await answerForVisiblePracticeQuestion(run, questionText);
  const choices = article.locator('label[for^="practice-choice-"]');
  const wrongChoice = isFakeProvider
    ? choices.nth(1)
    : await findChoiceThatIsNotAnswer(choices, correctAnswer);
  const wrongChoiceId = isFakeProvider
    ? 'practice-choice-1'
    : await wrongChoice.getAttribute('for');
  if (!wrongChoiceId)
    throw new Error(
      'Full exam wrong-answer flow could not identify the selected choice.',
    );
  run.metrics.wrong_answer = wrongChoiceId;
  log(run, `full exam wrong choice selected: ${wrongChoiceId}`);
  await wrongChoice.click({ timeout: 30_000, force: true });
  log(run, 'full exam wrong choice clicked');
  await clickButtonText(run, 'Submit answer');
  await waitText(
    run,
    /Last answer: Needs review/i,
    30_000,
    'wrong answer recorded',
  );
  await screenshot(run, 'practice-wrong-answer');

  await clickButtonPattern(run, /^\s*Review\s*$/);
  await waitText(
    run,
    /Wrong Answers|1 recorded|Selected:/i,
    30_000,
    'wrong-answer review populated',
  );
  await screenshot(run, 'wrong-answer-panel-populated');
}

export async function runRandomQuizCorrectClear(
  run: SmokeRunState,
): Promise<void> {
  await clickButtonPattern(run, /^\s*Random Quiz\s*$/);
  await waitText(
    run,
    /Start random quiz|Random Quiz/i,
    10_000,
    'random quiz mode',
  );
  await activePage(run)
    .locator('input[name="sessionQuestionCount"]')
    .fill('100');
  await screenshot(run, 'random-quiz-ready');
  await clickButtonText(run, 'Start random quiz');
  await waitText(
    run,
    /Submit answer|Choices/,
    30_000,
    'random quiz question visible',
  );

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const article = activePage(run)
      .locator('app-practice-panel article')
      .first();
    if ((await article.count()) === 0) {
      break;
    }
    const questionText = await article.locator('h3').first().innerText();
    const answer = await answerForVisiblePracticeQuestion(run, questionText);
    await article
      .locator('label')
      .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(answer)}\\s*$`) })
      .first()
      .click({ timeout: 30_000 });
    await clickButtonText(run, 'Submit answer');
    await waitText(
      run,
      /Last answer: Correct|Practice set complete/i,
      30_000,
      'correct answer recorded',
    );
    if (/Practice set complete/i.test(await bodyText(run))) {
      break;
    }
  }

  await screenshot(run, 'random-quiz-correct-answer');

  await clickButtonPattern(run, /^\s*Review\s*$/);
  await waitText(
    run,
    /0 recorded|Wrong answers will appear here/i,
    30_000,
    'wrong-answer review cleared',
  );
  await screenshot(run, 'wrong-answer-panel-cleared');
}

async function findChoiceThatIsNotAnswer(
  choices: Locator,
  correctAnswer: string,
): Promise<Locator> {
  const normalizedAnswer = normalizeChoiceText(correctAnswer);
  const count = await choices.count();
  for (let index = 0; index < count; index += 1) {
    const choice = choices.nth(index);
    const visibleText = await choice.innerText();
    if (normalizeChoiceText(visibleText) !== normalizedAnswer) return choice;
  }
  throw new Error(
    'Full exam question did not expose a choice different from the generated correct answer.',
  );
}

function normalizeChoiceText(value: string): string {
  return value
    .replace(/^\s*(?:[A-Z]|\d+)[.)]\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export async function verifyMarkdownExport(run: SmokeRunState): Promise<void> {
  const page = activePage(run);
  const captureWorkbenchLink = page.getByRole('link', {
    name: 'Capture Workbench',
    exact: true,
  });
  await captureWorkbenchLink.waitFor({ state: 'visible', timeout: 30_000 });
  await captureWorkbenchLink.click({ timeout: 30_000 });
  await waitText(
    run,
    /Capture Workbench|Download Markdown|Cert Prep status/i,
    30_000,
    'Capture Workbench export page',
  );

  // The export control is rendered only after this page has completed its own
  // real Capture Workbench flow. Navigating here without processing a source
  // leaves lastCompleted() empty and would make the export assertion false.
  const captureWorkbench = page.locator('capture-workbench');
  await captureWorkbench.waitFor({ state: 'visible', timeout: 30_000 });
  const captureFileInput = captureWorkbench.locator('input[type="file"]');
  await captureFileInput.waitFor({ state: 'attached', timeout: 30_000 });
  await captureFileInput.setInputFiles(run.options.pdfPath);
  await screenshot(run, 'capture-workbench-input-complete');

  const captureTask = captureWorkbench
    .locator('[data-testid="capture-task"]')
    .first();
  await captureTask.waitFor({ state: 'visible', timeout: 30_000 });
  await waitLocatorText(
    captureTask,
    /awaiting_confirmation|Review capture|Original OCR|Confirm capture/i,
    10 * 60_000,
    'Capture Workbench OCR review',
  );
  const confirmCapture = captureWorkbench
    .getByRole('button', { name: /Confirm capture|Confirm OCR/i })
    .first();
  await confirmCapture.waitFor({ state: 'visible', timeout: 30_000 });
  await screenshot(run, 'capture-workbench-review');
  await confirmCapture.click({ timeout: 30_000 });
  const captureResult = captureWorkbench
    .locator('[data-testid="capture-result"]')
    .first();
  await captureResult.waitFor({
    state: 'visible',
    timeout: 10 * 60_000,
  });
  await screenshot(run, 'capture-workbench-result');

  const exportControl = page
    .locator('button.capture-trial-download-button:visible')
    .first();
  await exportControl.waitFor({ state: 'visible', timeout: 120_000 });

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await exportControl.click({ timeout: 30_000 });
  const download = await downloadPromise;
  const suggestedFilename = download.suggestedFilename();
  if (!/\.md$/iu.test(suggestedFilename)) {
    throw new Error(
      `Markdown export returned an unexpected filename: ${suggestedFilename}`,
    );
  }
  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error('Markdown export did not produce a readable download.');
  }
  const contents = await readFile(downloadPath, 'utf8');
  if (!contents.trim()) {
    throw new Error('Markdown export produced an empty file.');
  }
  run.metrics.observations.push(
    `Markdown export downloaded ${suggestedFilename} (${contents.length} bytes).`,
  );
  await screenshot(run, 'markdown-export-complete');
}
