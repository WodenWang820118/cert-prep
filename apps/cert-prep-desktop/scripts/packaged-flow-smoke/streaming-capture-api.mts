import type { Page, Response } from 'playwright';

import { errorMessage, isRecord, stringField } from './text-utils.mts';
import type {
  LlmHealthSnapshot,
  SmokeRunState,
  UploadedDocumentRef,
} from './types.mts';
import { activePage } from './runner-context.mts';
import {
  recordStreamingDraftJobSnapshot,
  recordStreamingQuestionSnapshot,
} from './streaming-capture-snapshots.mts';

export function observeStreamingApiResponses(run: SmokeRunState, currentPage: Page): void {
  currentPage.on('response', (response) => {
    void recordStreamingApiResponse(run, response);
  });
}

async function recordStreamingApiResponse(run: SmokeRunState, response: Response): Promise<void> {
  if (!run.streamingDraftCaptureOpen || run.streamingDraftParseStartedAt === null) {
    return;
  }
  if (response.request().method().toUpperCase() !== 'GET') {
    return;
  }

  const url = response.url();
  const capturesDraftJobs = url.includes('/draft-jobs');
  const capturesQuestionDrafts = url.includes('/question-drafts');
  if (!capturesDraftJobs && !capturesQuestionDrafts) {
    return;
  }

  const payload = await response.json().catch(() => null);
  if (!payload) {
    return;
  }
  const elapsedMs = Date.now() - run.streamingDraftParseStartedAt;
  if (capturesDraftJobs) {
    recordStreamingDraftJobSnapshot(run, payload, elapsedMs);
  } else {
    recordStreamingQuestionSnapshot(run, payload, elapsedMs);
  }
}

export async function waitForUploadDocumentResponse(run: SmokeRunState): Promise<UploadedDocumentRef | null> {
  const response = await activePage(run)
    .waitForResponse(
      (candidate) =>
        candidate.request().method().toUpperCase() === 'POST' &&
        isDocumentsCollectionUrl(candidate.url()),
      { timeout: 120_000 },
    )
    .catch((error) => {
      run.metrics.observations.push(
        `Upload document response capture timed out: ${errorMessage(error)}`,
      );
      return null;
    });
  if (!response) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') {
    run.metrics.observations.push('Upload document response was not valid JSON.');
    return null;
  }

  return uploadedDocumentRefFromResponse(run, response, payload);
}

function uploadedDocumentRefFromResponse(
  run: SmokeRunState,
  response: Response,
  payload: object,
): UploadedDocumentRef | null {
  const id = valueString(payload, 'id');
  const projectId = valueString(payload, 'project_id');
  if (!id || !projectId) {
    run.metrics.observations.push(
      'Upload document response did not include project_id and id.',
    );
    return null;
  }

  const apiBaseUrl = apiBaseUrlFromResponse(response);
  if (!apiBaseUrl) {
    run.metrics.observations.push(
      'Upload document response URL could not be converted to an API base URL.',
    );
    return null;
  }

  const requestHeaders = response.request().headers();
  return {
    apiBaseUrl,
    authorization: requestHeaders.authorization ?? null,
    projectId,
    documentId: id,
  };
}

function isDocumentsCollectionUrl(value: string): boolean {
  try {
    return /\/projects\/[^/]+\/documents\/?$/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function apiBaseUrlFromResponse(response: Response): string | null {
  try {
    const parsed = new URL(response.url());
    const markerIndex = parsed.pathname.indexOf('/projects/');
    if (markerIndex < 0) {
      return null;
    }
    const basePath = parsed.pathname.slice(0, markerIndex).replace(/\/+$/, '');
    return `${parsed.origin}${basePath}`;
  } catch {
    return null;
  }
}

function valueString(payload: object, key: string): string | null {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function valueNumber(payload: object, key: string): number | null {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function pollStreamingDraftApis(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
  elapsedMs: number,
): Promise<void> {
  const [jobs, drafts] = await Promise.all([
    streamingApiGet(
      run,
      uploadedDocument,
      `/projects/${encodeURIComponent(uploadedDocument.projectId)}/documents/${encodeURIComponent(
        uploadedDocument.documentId,
      )}/draft-jobs`,
    ),
    streamingApiGet(
      run,
      uploadedDocument,
      `/projects/${encodeURIComponent(uploadedDocument.projectId)}/question-drafts`,
    ),
  ]);

  if (jobs) {
    recordStreamingDraftJobSnapshot(run, jobs, elapsedMs);
  }
  if (drafts) {
    recordStreamingQuestionSnapshot(run, drafts, elapsedMs);
  }
}

export async function captureLlmHealth(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
): Promise<void> {
  const payload = await streamingApiGet(run, uploadedDocument, '/llm/health');
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
    health.configured_model ?? health.model ?? run.options.ollamaModel;
  run.metrics.llm_effective_model = health.available
    ? health.effective_model ?? health.model ?? undefined
    : health.effective_model ?? undefined;
  run.metrics.llm_fallback_models = health.fallback_models;
  run.metrics.llm_fallback_reason = health.fallback_reason;
}

export async function captureDocumentOcrEvidence(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
): Promise<void> {
  const payload = await streamingApiGet(
    run,
    uploadedDocument,
    `/projects/${encodeURIComponent(uploadedDocument.projectId)}/documents/${encodeURIComponent(
      uploadedDocument.documentId,
    )}`,
  );
  if (!isRecord(payload)) {
    run.metrics.observations.push('Document OCR evidence response was not valid JSON.');
    return;
  }

  const device = stringField(payload.ocr_device).trim() || 'unknown';
  const fallback = stringField(payload.ocr_fallback_reason).trim();
  run.metrics.observations.push(
    fallback
      ? `Document OCR completed on ${device}; fallback_reason=${fallback}.`
      : `Document OCR completed on ${device}.`,
  );
}

async function streamingApiGet(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
  path: string,
): Promise<unknown | null> {
  try {
    const headers = uploadedDocument.authorization
      ? { Authorization: uploadedDocument.authorization }
      : undefined;
    const response = await activePage(run).request.get(
      `${uploadedDocument.apiBaseUrl}${path}`,
      {
        headers,
        timeout: 10_000,
      },
    );
    if (!response.ok()) {
      recordStreamingApiPollError(
        run,
        `Streaming API poll ${path} returned HTTP ${response.status()}.`,
      );
      return null;
    }
    return await response.json();
  } catch (error) {
    recordStreamingApiPollError(
      run,
      `Streaming API poll ${path} failed: ${errorMessage(error)}`,
    );
    return null;
  }
}

export async function createPackagedSmokeQuestion(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const headers = uploadedDocument.authorization
    ? { Authorization: uploadedDocument.authorization }
    : undefined;
  const response = await activePage(run).request.post(
    `${uploadedDocument.apiBaseUrl}/projects/${encodeURIComponent(
      uploadedDocument.projectId,
    )}/question-drafts`,
    {
      data: payload,
      headers,
      timeout: 30_000,
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Creating packaged smoke question failed with HTTP ${response.status()}: ${await response.text()}`,
    );
  }
  return await response.json();
}

export async function firstSourceChunk(
  run: SmokeRunState,
  uploadedDocument: UploadedDocumentRef,
): Promise<{ id: string; pageNumber: number; sourceExcerpt: string }> {
  const payload = await streamingApiGet(
    run,
    uploadedDocument,
    `/projects/${encodeURIComponent(uploadedDocument.projectId)}/documents/${encodeURIComponent(
      uploadedDocument.documentId,
    )}/chunks`,
  );
  const items = responseItems(payload);
  const first = items[0];
  if (!first || typeof first !== 'object') {
    throw new Error('Cannot create QA question because no source chunks were returned.');
  }
  const id = valueString(first, 'id');
  if (!id) {
    throw new Error('Cannot create QA question because the first source chunk had no id.');
  }
  return {
    id,
    pageNumber: valueNumber(first, 'page_number') ?? 1,
    sourceExcerpt:
      valueString(first, 'source_excerpt') ??
      valueString(first, 'text') ??
      'Packaged smoke source excerpt.',
  };
}

function normalizedVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export async function answerForVisiblePracticeQuestion(
  run: SmokeRunState,
  questionText: string,
): Promise<string> {
  if (!run.uploadedDocument) {
    throw new Error('Cannot answer practice question because no document API reference was captured.');
  }
  const payload = await streamingApiGet(
    run,
    run.uploadedDocument,
    `/projects/${encodeURIComponent(run.uploadedDocument.projectId)}/question-drafts`,
  );
  const question = normalizedVisibleText(questionText);
  const match = responseItems(payload).find(
    (item) => normalizedVisibleText(valueString(item, 'question') ?? '') === question,
  );
  const answer = match ? valueString(match, 'answer') : null;
  if (!answer) {
    throw new Error(
      `Cannot answer practice question because no answer matched visible question: ${question.slice(0, 120)}`,
    );
  }
  return answer;
}

function responseItems(payload: unknown): object[] {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !Array.isArray((payload as { items?: unknown }).items)
  ) {
    return [];
  }
  return (payload as { items: unknown[] }).items.filter(
    (item): item is object => typeof item === 'object' && item !== null,
  );
}

function recordStreamingApiPollError(run: SmokeRunState, message: string): void {
  if (run.streamingApiPollErrorCaptured) {
    return;
  }
  run.streamingApiPollErrorCaptured = true;
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
    fallback_models: Array.isArray(payload.fallback_models)
      ? payload.fallback_models
          .map((value) => stringField(value).trim())
          .filter(Boolean)
      : [],
    fallback_reason: nullableString(payload.fallback_reason),
    detail: nullableString(payload.detail),
  };
}

function nullableString(value: unknown): string | null {
  const normalized = stringField(value).trim();
  return normalized.length > 0 ? normalized : null;
}
