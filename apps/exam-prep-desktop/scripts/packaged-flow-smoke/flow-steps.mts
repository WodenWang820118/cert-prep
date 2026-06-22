import { setTimeout as delay } from 'node:timers/promises';

import {
  activePage,
  bodyText,
  clickButtonPattern,
  clickButtonText,
  closeRuntimeDrawer,
  escapeRegExp,
  metricText,
  screenshot,
  waitText,
} from './runner-context.mts';
import {
  answerForVisiblePracticeQuestion,
  captureLlmHealth,
  createPackagedSmokeQuestion,
  EXPECTED_BASELINE_CHUNKS,
  EXPECTED_BASELINE_PAGES,
  firstSourceChunk,
  FIRST_CHUNK_TEXT_PATTERN,
  observeFirstChunkVisibleFromParseStart,
  observeStreamingDraftUiUntil,
  recordFirstChunkVisible,
  refreshFirstChunkGateMetrics,
  waitForStreamingJobsComplete,
  waitForUploadDocumentResponse,
} from './streaming-capture.mts';
import { FIRST_CHUNK_GATE_MS } from './streaming-evidence.mts';
import type { SmokeRunState } from './types.mts';

export async function createProject(run: SmokeRunState): Promise<void> {
  await closeRuntimeDrawer(run);
  const projectName = `Parallel Parsing QA ${new Date()
    .toISOString()
    .slice(11, 19)}`;
  await activePage(run).locator('#projectName').fill(projectName);
  await activePage(run)
    .locator('#projectDescription')
    .fill(
      'Packaged QA flow for parallel parsing, reasoning model UX, and wrong-answer review.',
    );
  await clickButtonText(run, 'Create project');
  await waitText(run,
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
  await activePage(run).locator('input[type="file"]').setInputFiles(run.options.pdfPath);
  await screenshot(run, 'pdf-selected-language-ja');

  const uploadDocumentResponse = waitForUploadDocumentResponse(run);
  const uploadStart = Date.now();
  await clickButtonText(run, 'Upload PDF', { timeout: 120_000 });
  await waitText(run,
    /Parsing started|Parsing continues|0\/\d+ pages|processing/i,
    30_000,
    'upload response / parsing visible',
  );
  run.metrics.ui_timings_ms.upload_to_processing_visible = Date.now() - uploadStart;
  const parseStart = Date.now();
  run.streamingDraftParseStartedAt = parseStart;
  run.streamingDraftCaptureOpen = true;
  const firstChunkObservation = observeFirstChunkVisibleFromParseStart(run, parseStart);

  try {
    const uploadedDocument = await uploadDocumentResponse;
    run.uploadedDocument = uploadedDocument;
    if (uploadedDocument) {
      run.metrics.observations.push(
        `Captured upload document reference for streaming API polling: ${uploadedDocument.documentId}.`,
      );
      await captureLlmHealth(run, uploadedDocument);
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

    const parseCompletePromise = waitText(run,
      /Parsing complete\.|46\/46 pages|ready\s*Page/i,
      300_000,
      'parsing complete',
    ).then(() => {
      run.metrics.ui_timings_ms.parse_complete_visible = Date.now() - parseStart;
    });
    await observeStreamingDraftUiUntil(
      run,
      parseStart,
      parseCompletePromise,
      uploadedDocument,
    );
    await parseCompletePromise;
    recordOcrCompletionFromText(run, await bodyText(run));
    if (run.options.waitForStreamingComplete) {
      if (!uploadedDocument) {
        throw new Error('Cannot wait for streaming completion without upload API reference.');
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
    throw new Error('Cannot create QA question without uploaded document reference.');
  }

  const correctAnswer = 'Packaged smoke correct answer';
  const wrongAnswer = 'Packaged smoke wrong answer';
  const chunk = await firstSourceChunk(run, run.uploadedDocument);
  const createStart = Date.now();
  await createPackagedSmokeQuestion(run, run.uploadedDocument, {
    document_id: run.uploadedDocument.documentId,
    chunk_id: chunk.id,
    question: 'Packaged smoke editable question?',
    choices: [correctAnswer, wrongAnswer],
    answer: correctAnswer,
    answer_key_source: 'manual',
    rationale:
      'Packaged smoke rationale validates direct editable questions and practice.',
    citation_page: chunk.pageNumber,
    source_excerpt: chunk.sourceExcerpt,
    source_order: 1,
    item_kind: 'vocabulary_single',
  });
  run.metrics.ui_timings_ms.question_creation = Date.now() - createStart;
  run.metrics.selected_answer = metricText(correctAnswer);
  run.metrics.wrong_answer = metricText(wrongAnswer);

  await activePage(run).reload({ waitUntil: 'domcontentloaded' });
  await waitText(run, /Packaged smoke editable question\?/, 60_000, 'created question visible');
  await screenshot(run, 'editable-question-created');

  const questionArticle = activePage(run)
    .locator('app-draft-review-panel article')
    .filter({ hasText: 'Packaged smoke editable question?' })
    .first();
  const editButton = questionArticle
    .locator('button')
    .filter({ hasText: /^\s*Edit\s*$/ })
    .first();
  await editButton.waitFor({ state: 'visible', timeout: 30_000 });
  await editButton.click({ timeout: 30_000 });
  await waitText(run, /Select answer|Rationale/, 10_000, 'question edit mode');

  const editingArticle = activePage(run)
    .locator('app-draft-review-panel article')
    .first();
  const questionInput = editingArticle.locator('input').first();
  await questionInput.waitFor({ state: 'visible', timeout: 30_000 });
  await questionInput.fill('Packaged smoke edited question?');
  await editingArticle.locator('textarea').fill(
    'Edited packaged smoke rationale validates save, practice, and wrong-answer clearing in the packaged app.',
  );
  await screenshot(run, 'editable-question-editing');

  const saveStart = Date.now();
  const saveButton = editingArticle
    .locator('button')
    .filter({ hasText: /^\s*Save\s*$/ })
    .first();
  await saveButton.waitFor({ state: 'visible', timeout: 30_000 });
  await saveButton.click({ timeout: 30_000 });
  await waitText(run,
    /Question saved|Packaged smoke edited question\?/,
    60_000,
    'question saved',
  );
  run.metrics.ui_timings_ms.question_save = Date.now() - saveStart;
  await screenshot(run, 'editable-question-saved');
}

export async function runFullExamWrongAnswer(run: SmokeRunState): Promise<void> {
  await clickButtonPattern(run, /^\s*Full Exam\s*$/);
  await waitText(run, /Start full exam|Full Exam/i, 10_000, 'full exam mode');
  await screenshot(run, 'full-exam-ready');
  await clickButtonText(run, 'Start full exam');
  await waitText(run, /Submit answer|Choices/, 30_000, 'full exam question visible');
  await activePage(run).locator('label[for="practice-choice-1"]').click();
  await clickButtonText(run, 'Submit answer');
  await waitText(run,
    /Last answer: Needs review|Practice set complete/i,
    30_000,
    'wrong answer recorded',
  );
  await screenshot(run, 'practice-wrong-answer');

  await clickButtonPattern(run, /^\s*Review\s*$/);
  await waitText(run,
    /Wrong Answers|1 recorded|Selected:/i,
    30_000,
    'wrong-answer review populated',
  );
  await screenshot(run, 'wrong-answer-panel-populated');
}

export async function runRandomQuizCorrectClear(run: SmokeRunState): Promise<void> {
  await clickButtonPattern(run, /^\s*Random Quiz\s*$/);
  await waitText(run, /Start random quiz|Random Quiz/i, 10_000, 'random quiz mode');
  await activePage(run).locator('input[name="sessionQuestionCount"]').fill('100');
  await screenshot(run, 'random-quiz-ready');
  await clickButtonText(run, 'Start random quiz');
  await waitText(run, /Submit answer|Choices/, 30_000, 'random quiz question visible');

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const article = activePage(run).locator('app-practice-panel article').first();
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
    await waitText(run,
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
  await waitText(run,
    /0 recorded|Wrong answers will appear here/i,
    30_000,
    'wrong-answer review cleared',
  );
  await screenshot(run, 'wrong-answer-panel-cleared');
}
