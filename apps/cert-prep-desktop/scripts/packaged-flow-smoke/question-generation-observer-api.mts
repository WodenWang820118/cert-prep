import type { Page, Response } from 'playwright';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_LLM_MODEL } from '../package-qa/constants.mts';
import { errorMessage, isRecord, stringField } from './text-utils.mts';
import type {
  LlmHealthSnapshot,
  SmokeMetrics,
  SmokeRunState,
  UploadedSourceRef,
} from './types.mts';
import { activePage } from './runner-context.mts';
import { wholeSourceQuestionCountFromSession } from './question-generation-evidence.mts';
import {
  isProjectSourcesCollectionResponse,
  projectApiRefMatchesResponse,
} from './generation-readiness.mts';
import {
  recordQuestionJobSnapshot,
  recordQuestionSnapshot,
} from './question-generation-observer-snapshots.mts';
import { evaluateOcrTruth } from '../ocr-truth-contract.mts';
import { buildOcrPageRecordEvidence } from '../ocr-page-record-evidence.mts';
import { serializePrivacySafeOcrSemanticEvidence } from '../ocr-semantic-evidence.mts';

export function observeQuestionGenerationApiResponses(
  run: SmokeRunState,
  currentPage: Page,
): void {
  currentPage.on('response', (response) => {
    void recordQuestionGenerationApiResponse(run, response);
  });
}

async function recordQuestionGenerationApiResponse(
  run: SmokeRunState,
  response: Response,
): Promise<void> {
  if (
    !run.questionObservationActive ||
    run.questionObservationStartedAt === null
  ) {
    return;
  }
  if (response.request().method().toUpperCase() !== 'GET') {
    return;
  }

  const { pathname } = new URL(response.url());
  const capturesQuestionJobs = /^\/projects\/[^/]+\/sources\/[^/]+\/question-jobs$/u.test(pathname);
  const capturesQuestions = /^\/projects\/[^/]+\/questions$/u.test(pathname);
  if (!capturesQuestionJobs && !capturesQuestions) {
    return;
  }

  const payload = await response.json().catch(() => null);
  if (!payload) {
    return;
  }
  const elapsedMs = Date.now() - run.questionObservationStartedAt;
  if (capturesQuestionJobs) {
    recordQuestionJobSnapshot(run, payload, elapsedMs);
  } else {
    recordQuestionSnapshot(run, payload, elapsedMs);
  }
}

export async function waitForUploadSourceResponse(
  run: SmokeRunState,
): Promise<UploadedSourceRef | null> {
  if (!run.projectApi) {
    run.metrics.observations.push(
      'Upload response capture skipped because project API context was unavailable.',
    );
    return null;
  }
  const response = await activePage(run)
    .waitForResponse(
      (candidate) =>
        isProjectSourcesCollectionResponse(run.projectApi, candidate),
      { timeout: 120_000 },
    )
    .catch(() => {
      run.metrics.observations.push(
        'Upload source response capture timed out.',
      );
      return null;
    });
  if (!response) {
    return null;
  }

  if (response.status() !== 201) {
    run.metrics.observations.push(
      'Upload source response did not return the expected status.',
    );
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') {
    run.metrics.observations.push(
      'Upload source response was not valid JSON.',
    );
    return null;
  }

  return uploadedSourceRefFromResponse(run, response, payload);
}

export async function captureWholeSourceSessionCreate(
  run: SmokeRunState,
): Promise<number> {
  const uploadedSource = run.uploadedSource;
  if (!uploadedSource) {
    throw new Error(
      'Cannot prove Whole source scope without the uploaded source.',
    );
  }
  const expectedUrl = new URL(
    `${uploadedSource.apiBaseUrl}/projects/${encodeURIComponent(
      uploadedSource.projectId,
    )}/practice-sessions`,
  );
  const response = await activePage(run).waitForResponse(
    (candidate) => {
      if (candidate.request().method().toUpperCase() !== 'POST') {
        return false;
      }
      try {
        const candidateUrl = new URL(candidate.url());
        return (
          candidateUrl.origin === expectedUrl.origin &&
          candidateUrl.pathname === expectedUrl.pathname
        );
      } catch {
        return false;
      }
    },
    { timeout: 30_000 },
  );
  if (response.status() !== 201) {
    throw new Error(
      `Whole source session creation returned HTTP ${response.status()}.`,
    );
  }

  let requestPayload: unknown;
  let responsePayload: unknown;
  try {
    requestPayload = response.request().postDataJSON();
    responsePayload = await response.json();
  } catch {
    throw new Error('Whole source session evidence was not valid JSON.');
  }
  const questionCount = wholeSourceQuestionCountFromSession(
    requestPayload,
    responsePayload,
    {
      projectId: uploadedSource.projectId,
      sourceId: uploadedSource.sourceId,
    },
  );
  if (questionCount === null) {
    throw new Error(
      'Whole source session did not prove a non-empty, practice-ready selected-source scope.',
    );
  }
  return questionCount;
}

function uploadedSourceRefFromResponse(
  run: SmokeRunState,
  response: Response,
  payload: object,
): UploadedSourceRef | null {
  const id = valueString(payload, 'id');
  const projectId = valueString(payload, 'project_id');
  const projectApi = run.projectApi;
  if (
    !id ||
    !UUID_PATTERN.test(id) ||
    !projectId ||
    !projectApi ||
    projectId !== projectApi.projectId ||
    !projectApiRefMatchesResponse(projectApi, response)
  ) {
    run.metrics.observations.push(
      'Upload source response did not match the captured project API context.',
    );
    return null;
  }
  return {
    apiBaseUrl: projectApi.apiBaseUrl,
    authorization: projectApi.authorization,
    projectId,
    sourceId: id,
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function valueString(payload: object, key: string): string | null {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function valueNumber(payload: object, key: string): number | null {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function pollQuestionGenerationApis(
  run: SmokeRunState,
  uploadedSource: UploadedSourceRef,
  elapsedMs: number,
): Promise<void> {
  const [jobs, questions] = await Promise.all([
    questionGenerationApiGet(
      run,
      uploadedSource,
      `/projects/${encodeURIComponent(uploadedSource.projectId)}/sources/${encodeURIComponent(
        uploadedSource.sourceId,
      )}/question-jobs`,
    ),
    questionGenerationApiGet(
      run,
      uploadedSource,
      `/projects/${encodeURIComponent(uploadedSource.projectId)}/questions`,
    ),
  ]);

  if (jobs) {
    recordQuestionJobSnapshot(run, jobs, elapsedMs);
  }
  if (questions) {
    recordQuestionSnapshot(run, questions, elapsedMs);
  }
}

export async function captureLlmHealth(
  run: SmokeRunState,
  uploadedSource: UploadedSourceRef,
): Promise<void> {
  const payload = await questionGenerationApiGet(run, uploadedSource, '/llm/health');
  const health = sanitizeLlmHealth(payload);
  if (!health) {
    run.metrics.observations.push('LLM health response was not valid JSON.');
    return;
  }

  run.metrics.llm_health = health;
  if (health.provider) {
    run.metrics.llm_provider = health.provider;
  }
  run.metrics.llm_configured_model =
    health.configured_model ?? health.model ?? DEFAULT_LLM_MODEL;
  run.metrics.llm_effective_model = health.available
    ? (health.effective_model ?? health.model ?? undefined)
    : (health.effective_model ?? undefined);
  run.metrics.llm_fallback_reason = health.fallback_reason;
  run.metrics.model_fallback_reason = health.fallback_reason;
}

export async function captureSourceOcrEvidence(
  run: SmokeRunState,
  uploadedSource: UploadedSourceRef,
): Promise<void> {
  const payload = await questionGenerationApiGet(
    run,
    uploadedSource,
    `/projects/${encodeURIComponent(uploadedSource.projectId)}/sources/${encodeURIComponent(
      uploadedSource.sourceId,
    )}`,
  );
  if (!isRecord(payload)) {
    run.metrics.observations.push(
      'Source OCR evidence response was not valid JSON.',
    );
    return;
  }

  recordSourceOcrCompletionEvidence(run, payload);
  if (run.options.acceptanceFixture?.truth) {
    if (payload.sha256 !== run.options.acceptanceFixture.sha256) {
      throw new Error(
        `PDF OCR evidence source SHA expected ${run.options.acceptanceFixture.sha256} but received ${String(payload.sha256)}.`,
      );
    }
    if (payload.extraction_method !== 'text_recognition') {
      throw new Error(
        `PDF OCR evidence extraction_method expected text_recognition but received ${String(payload.extraction_method)}.`,
      );
    }
    if (stringField(payload.failure_message).trim()) {
      throw new Error('A ready PDF reported an extraction failure message.');
    }
    const chunksPayload = await questionGenerationApiGet(
      run,
      uploadedSource,
      `/projects/${encodeURIComponent(uploadedSource.projectId)}/sources/${encodeURIComponent(
        uploadedSource.sourceId,
      )}/chunks`,
    );
    const chunks = responseItems(chunksPayload);
    if (chunks.length === 0) {
      throw new Error('PDF OCR truth evaluation received no persisted chunks.');
    }
    const actualPages = new Map<number, string[]>();
    for (const chunk of chunks) {
      const pageNumber = valueNumber(chunk, 'page_number');
      if (
        pageNumber === null ||
        !Number.isInteger(pageNumber) ||
        pageNumber < 1
      ) {
        throw new Error(
          'PDF OCR chunks did not expose valid page_number values.',
        );
      }
      if (
        chunk.extraction_method !== undefined &&
        chunk.extraction_method !== 'text_recognition'
      ) {
        throw new Error(
          `PDF OCR chunk extraction_method expected text_recognition but received ${String(chunk.extraction_method)}.`,
        );
      }
      const rawText =
        typeof chunk.raw_text === 'string'
          ? chunk.raw_text
          : typeof chunk.text === 'string'
            ? chunk.text
            : '';
      if (!rawText.trim()) {
        throw new Error(`PDF OCR page ${pageNumber} exposed no raw text.`);
      }
      const page = actualPages.get(pageNumber) ?? [];
      page.push(rawText);
      actualPages.set(pageNumber, page);
    }
    const pageRecords = buildOcrPageRecordEvidence({
      runId: process.env.E2E_ACCEPTANCE_RUN_ID ?? 'unknown',
      expectedSourceId: uploadedSource.sourceId,
      expectedProjectId: uploadedSource.projectId,
      source: payload,
      chunks,
      expectedPageNumbers: run.options.acceptanceFixture.truth.pages.map(
        (page) => page.pageNumber,
      ),
      appDataEmptyAtLaunch:
        run.metrics.acceptance_isolation_at_launch
          ?.app_data_dir_empty_at_launch === true,
    });
    run.metrics.ocr_page_records = pageRecords;
    writeFileSync(
      join(run.options.outDir, 'ocr-page-record-evidence.json'),
      `${JSON.stringify(pageRecords, null, 2)}\n`,
      'utf8',
    );
    const evaluatedTruth = evaluateOcrTruth(
      run.options.acceptanceFixture.truth,
      [...actualPages.entries()]
        .sort(([left], [right]) => left - right)
        .map(([pageNumber, texts]) => ({ pageNumber, text: texts.join('\n') })),
    );
    run.metrics.ocr_truth = evaluatedTruth;
    run.metrics.ocr_semantic_evidence = serializePrivacySafeOcrSemanticEvidence(
      {
        truth: run.options.acceptanceFixture.truth,
        evaluation: evaluatedTruth,
        actualPages: [...actualPages.entries()]
          .sort(([left], [right]) => left - right)
          .map(([pageNumber, texts]) => ({
            pageNumber,
            text: texts.join('\n'),
          })),
      },
    );
    if (run.options.acceptancePdfPageScope === 'page-1') {
      const pageNumbers = [...actualPages.keys()].sort(
        (left, right) => left - right,
      );
      const sourcePageCount = assertPdfPageOneScope(payload, pageNumbers);
      run.metrics.observations.push(
        `PDF acceptance page scope verified: source=${sourcePageCount}, requested=[1], processed=[1].`,
      );
    }
  }
  const device = stringField(payload.ocr_device).trim() || 'unknown';
  (run.metrics as SmokeMetrics & { ocr_device?: string }).ocr_device = device;
  const warning = stringField(payload.extraction_warnings).trim();
  run.metrics.observations.push(
    warning
      ? `Source OCR completed on ${device}; extraction_warnings=${warning}.`
      : `Source OCR completed on ${device}.`,
  );
}

export function assertPdfPageOneScope(
  payload: Record<string, unknown>,
  persistedPageNumbers: readonly number[],
): number {
  const pageCount = valueNumber(payload, 'page_count');
  if (
    pageCount === null ||
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    valueNumber(payload, 'processed_page_count') !== 1 ||
    valueNumber(payload, 'chunks_count') !== 1 ||
    persistedPageNumbers.length !== 1 ||
    persistedPageNumbers[0] !== 1
  ) {
    throw new Error(
      `PDF page-one scope was not preserved through the durable source: ${JSON.stringify(
        {
          pageCount,
          processedPageCount: valueNumber(payload, 'processed_page_count'),
          chunksCount: valueNumber(payload, 'chunks_count'),
          pageNumbers: persistedPageNumbers,
        },
      )}`,
    );
  }
  return pageCount;
}

export function recordSourceOcrCompletionEvidence(
  run: SmokeRunState,
  payload: Record<string, unknown>,
): void {
  run.metrics.ocr_completion = {
    pages_processed: valueNumber(payload, 'processed_page_count'),
    total_pages: valueNumber(payload, 'page_count'),
    chunks: valueNumber(payload, 'chunks_count'),
    expected_pages:
      run.options.acceptancePdfPageScope === 'page-1'
        ? 1
        : (run.metrics.ocr_completion?.expected_pages ?? 46),
    expected_chunks:
      run.options.acceptancePdfPageScope === 'page-1'
        ? 1
        : (run.metrics.ocr_completion?.expected_chunks ?? 46),
  };
}

async function questionGenerationApiGet(
  run: SmokeRunState,
  uploadedSource: UploadedSourceRef,
  path: string,
): Promise<unknown | null> {
  try {
    const headers = uploadedSource.authorization
      ? { Authorization: uploadedSource.authorization }
      : undefined;
    const response = await activePage(run).request.get(
      `${uploadedSource.apiBaseUrl}${path}`,
      {
        headers,
        timeout: 10_000,
      },
    );
    if (!response.ok()) {
      recordQuestionGenerationApiPollError(
        run,
        `Question generation API poll ${path} returned HTTP ${response.status()}.`,
      );
      return null;
    }
    return await response.json();
  } catch (error) {
    recordQuestionGenerationApiPollError(
      run,
      `Question generation API poll ${path} failed: ${errorMessage(error)}`,
    );
    return null;
  }
}

function normalizedVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export async function answerForVisiblePracticeQuestion(
  run: SmokeRunState,
  questionText: string,
): Promise<string> {
  if (!run.uploadedSource) {
    throw new Error(
      'Cannot answer practice question because no source API reference was captured.',
    );
  }
  const payload = await questionGenerationApiGet(
    run,
    run.uploadedSource,
    `/projects/${encodeURIComponent(run.uploadedSource.projectId)}/questions`,
  );
  const question = normalizedVisibleText(questionText);
  const match = responseItems(payload).find(
    (item) =>
      normalizedVisibleText(valueString(item, 'question') ?? '') === question,
  );
  const answer = match ? valueString(match, 'answer') : null;
  if (!answer) {
    throw new Error(
      `Cannot answer practice question because no answer matched visible question: ${question.slice(0, 120)}`,
    );
  }
  return answer;
}

function responseItems(payload: unknown): Record<string, unknown>[] {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !Array.isArray((payload as { items?: unknown }).items)
  ) {
    return [];
  }
  return (payload as { items: unknown[] }).items.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );
}

function recordQuestionGenerationApiPollError(
  run: SmokeRunState,
  message: string,
): void {
  if (run.questionGenerationApiPollErrorCaptured) {
    return;
  }
  run.questionGenerationApiPollErrorCaptured = true;
  run.metrics.observations.push(message);
}

function sanitizeLlmHealth(payload: unknown): LlmHealthSnapshot | null {
  if (!isRecord(payload)) {
    return null;
  }
  return {
    provider: nullableString(payload.provider),
    available:
      typeof payload.available === 'boolean' ? payload.available : null,
    model: nullableString(payload.model),
    configured_model: nullableString(payload.configured_model),
    effective_model: nullableString(payload.effective_model),
    fallback_reason: nullableString(payload.fallback_reason),
    execution_mode:
      payload.execution_mode === 'auto' || payload.execution_mode === 'cpu'
        ? payload.execution_mode
        : null,
    execution_warning: nullableString(payload.execution_warning),
    detail: nullableString(payload.detail),
    profile_id: nullableString(payload.profile_id),
    base_model: nullableString(payload.base_model),
    modelfile_sha256: nullableString(payload.modelfile_sha256),
    profile_reason: nullableString(payload.profile_reason),
    profile_warnings: Array.isArray(payload.profile_warnings)
      ? payload.profile_warnings
          .map((value) => stringField(value).trim())
          .filter(Boolean)
      : [],
  };
}

function nullableString(value: unknown): string | null {
  const normalized = stringField(value).trim();
  return normalized.length > 0 ? normalized : null;
}
