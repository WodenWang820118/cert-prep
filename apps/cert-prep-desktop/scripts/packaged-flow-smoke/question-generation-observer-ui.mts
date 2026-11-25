import { setTimeout as delay } from 'node:timers/promises';

import { classifyQuestionGenerationStatus } from './question-generation-evidence.mts';
import { errorMessage } from './text-utils.mts';
import type {
  SmokeRunState,
  UploadedDocumentRef,
} from './types.mts';
import { bodyText, screenshot } from './runner-context.mts';
import { pollQuestionGenerationApis } from './question-generation-observer-api.mts';

const QUESTION_GENERATION_STATUS_PATTERN =
  /Generating \d+\/\d+|[1-9]\d* questions ready|Model missing|Reasoning unavailable|Question generation needs attention/i;

export async function observeQuestionGenerationUiUntil(
  run: SmokeRunState,
  parseStart: number,
  completion: Promise<void>,
  uploadedDocument: UploadedDocumentRef | null,
): Promise<void> {
  let completed = false;
  completion.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );

  let statusCaptured =
    run.metrics.ui_timings_ms.question_generation_status_visible !== undefined;
  let usableCaptured =
    run.metrics.ui_timings_ms.question_generation_first_usable_question_visible !== undefined;

  while (!completed && (!statusCaptured || !usableCaptured)) {
    if (uploadedDocument) {
      await pollQuestionGenerationApis(run, uploadedDocument, Date.now() - parseStart);
    }
    const text = await bodyText(run);
    if (!statusCaptured && QUESTION_GENERATION_STATUS_PATTERN.test(text)) {
      const elapsedMs = Date.now() - parseStart;
      const questionGenerationStatus = classifyQuestionGenerationStatus(text);
      run.metrics.ui_timings_ms.question_generation_status_visible = elapsedMs;
      run.metrics.observations.push(`Question generation question status: ${questionGenerationStatus}.`);
      if (questionGenerationStatus === 'ready') {
        run.metrics.ui_timings_ms.question_generation_first_question_ready_visible = elapsedMs;
      } else if (questionGenerationStatus === 'blocked') {
        run.metrics.ui_timings_ms.question_generation_blocker_visible = elapsedMs;
      }
      await screenshot(run, 'question-generation-status-visible');
      statusCaptured = true;
    }

    if (!usableCaptured && (await firstUsableQuestionArticleVisible(run))) {
      const elapsedMs = Date.now() - parseStart;
      run.metrics.ui_timings_ms.question_generation_first_usable_question_visible = elapsedMs;
      run.metrics.question_generation.first_usable_question_visible_ms ??= elapsedMs;
      await screenshot(run, 'question-generation-first-usable-question-visible');
      usableCaptured = true;
    }

    await Promise.race([
      delay(1_000),
      completion.catch(() => undefined),
    ]);
  }

  if (uploadedDocument) {
    await pollQuestionGenerationApis(run, uploadedDocument, Date.now() - parseStart);
  }

  if (run.metrics.ui_timings_ms.question_generation_status_visible === undefined) {
    run.metrics.observations.push(
      'Question generation question status was not visible before OCR parse completion.',
    );
  }
}

async function firstUsableQuestionArticleVisible(
  run: SmokeRunState,
): Promise<boolean> {
  if (!run.page) {
    return false;
  }
  try {
    return await run.page.locator('app-questions-panel article').evaluateAll(
      (articles) =>
        articles.some((article) => {
          const question = article.querySelector('h3')?.textContent?.trim() ?? '';
          const choices = Array.from(article.querySelectorAll('ol li')).filter(
            (choice) => (choice.textContent ?? '').trim().length > 0,
          );
          return question.length > 0 && choices.length >= 2;
        }),
    );
  } catch (error) {
    if (errorMessage(error).includes('Execution context was destroyed')) {
      return false;
    }
    throw error;
  }
}
