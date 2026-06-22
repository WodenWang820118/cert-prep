import type { Page, Route } from '@playwright/test';

export const apiBaseUrl = 'http://127.0.0.1:8765';
export const devToken = 'exam-prep-local-dev-token';

export interface MockExamPrepApi {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  };
  readonly document: {
    readonly id: string;
    readonly filename: string;
  };
  readonly draft: {
    readonly id: string;
    readonly question: string;
    readonly answer: string;
    readonly rationale: string;
    readonly source_excerpt: string;
  };
  readonly session: {
    readonly id: string;
  };
  practiceSessionPayload(): Record<string, unknown> | null;
  seenPaths(): Set<string>;
}

export async function installMockExamPrepApi(
  page: Page,
): Promise<MockExamPrepApi> {
  const project = {
    id: 'project-1',
    name: 'JLPT_N1',
    description: '2025 N1 mock exam',
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
  };
  const document = {
    id: 'document-1',
    project_id: project.id,
    filename: 'jlpt-n1.pdf',
    sha256: 'abc123',
    page_count: 2,
    has_text: true,
    status: 'ready',
    extraction_method: 'paddle_ocr_gpu',
    ocr_device: 'gpu:0',
    ocr_fallback_reason: null,
    ocr_duration_ms: 384,
    processed_page_count: 1,
    parse_wall_duration_ms: 1200,
    render_duration_ms: 180,
    ocr_engine_duration_ms: 384,
    ocr_worker_count: 1,
    first_chunk_ms: 850,
    exam_item_count: 1,
    language_hint: 'ja',
    content_profile: 'vocabulary_single_questions',
    classification_detail: '{"profile":"vocabulary_single_questions"}',
    chunks_count: 2,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
  };
  const draft = {
    id: 'draft-1',
    project_id: project.id,
    document_id: document.id,
    chunk_id: 'chunk-1',
    question: 'Which access control principle is cited by the source?',
    choices: [
      'Apply the cited concept',
      'Ignore the cited source',
      'Choose an unrelated control',
      'Remove all safeguards',
    ],
    answer: 'Apply the cited concept',
    answer_key_source: 'ai_inferred',
    rationale: 'Least privilege keeps permissions scoped to the task.',
    citation_page: 1,
    source_excerpt: 'Least privilege limits access to required permissions.',
    confidence: 0.94,
    source_order: 10001,
    source_question_number: '1',
    item_kind: 'vocabulary_single',
    group_key: null,
    group_prompt: null,
    status: 'approved',
    rejection_reason: null,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
  };
  const session = {
    id: 'session-1',
    project_id: project.id,
    question_ids: [draft.id],
    mode: 'random_draw',
    document_id: null,
    question_count: 1,
    random_seed: 42,
    status: 'active',
    created_at: '2026-06-09T00:00:00Z',
    completed_at: null,
  };
  let documentUploaded = false;
  let practiceSessionPayload: Record<string, unknown> | null = null;
  const wrongAnswers: unknown[] = [];
  const seenPaths = new Set<string>();

  await page.route(`${apiBaseUrl}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: corsHeaders(),
      });
      return;
    }

    if (request.headers()['authorization'] !== `Bearer ${devToken}`) {
      await fulfillJson(route, 401, {
        code: 'unauthorized',
        message: 'Bearer token required.',
      });
      return;
    }

    seenPaths.add(`${method} ${path}`);

    if (method === 'GET' && path === '/health') {
      await fulfillJson(route, 200, {
        status: 'ok',
        app: 'exam-prep-backend',
        version: '0.1.0',
        python_version: '3.13.5',
        runtime_mode: 'source',
      });
      return;
    }

    if (method === 'GET' && path === '/llm/health') {
      await fulfillJson(route, 200, {
        provider: 'fake',
        model: 'qwen3.5:4b',
        available: true,
        detail: 'deterministic local fake provider',
      });
      return;
    }

    if (method === 'GET' && path === '/ocr/health') {
      await fulfillJson(route, 200, {
        provider: 'paddle',
        engine: 'paddleocr',
        available: true,
        detail: 'PaddleOCR imports available',
        python_version: '3.13.5',
        paddle_version: '3.3.0',
        paddleocr_version: '3.3.0',
        selected_device: 'gpu:0',
        cuda_available: true,
        gpu_count: 1,
        model_cache_dir: null,
        fallback_reason: null,
      });
      return;
    }

    if (method === 'GET' && path === '/runtime/requirements') {
      await fulfillJson(route, 200, { items: [] });
      return;
    }

    if (method === 'GET' && path === '/projects') {
      await fulfillJson(route, 200, { items: [] });
      return;
    }

    if (method === 'POST' && path === '/projects') {
      await fulfillJson(route, 201, project);
      return;
    }

    if (
      method === 'GET' &&
      path === `/projects/${project.id}/question-drafts`
    ) {
      await fulfillJson(
        route,
        200,
        documentUploaded ? { items: [draft] } : { items: [] },
      );
      return;
    }

    if (method === 'GET' && path === `/projects/${project.id}/documents`) {
      await fulfillJson(
        route,
        200,
        documentUploaded ? { items: [document] } : { items: [] },
      );
      return;
    }

    if (
      method === 'GET' &&
      path === `/projects/${project.id}/documents/${document.id}`
    ) {
      await fulfillJson(route, 200, document);
      return;
    }

    if (
      method === 'GET' &&
      path === `/projects/${project.id}/documents/${document.id}/chunks`
    ) {
      await fulfillJson(route, 200, { items: [] });
      return;
    }

    if (method === 'GET' && path === `/projects/${project.id}/wrong-answers`) {
      await fulfillJson(route, 200, { items: wrongAnswers });
      return;
    }

    if (method === 'POST' && path === `/projects/${project.id}/documents`) {
      documentUploaded = true;
      await fulfillJson(route, 201, document);
      return;
    }

    if (
      method === 'POST' &&
      path === `/projects/${project.id}/practice-sessions`
    ) {
      practiceSessionPayload = parseJsonBody(request.postData());
      await fulfillJson(route, 201, session);
      return;
    }

    if (
      method === 'GET' &&
      path === `/projects/${project.id}/practice-sessions/${session.id}`
    ) {
      await fulfillJson(route, 200, session);
      return;
    }

    if (
      method === 'POST' &&
      path ===
        `/projects/${project.id}/practice-sessions/${session.id}/attempts`
    ) {
      const payload = parseJsonBody(request.postData());
      wrongAnswers.push({
        attempt_id: 'attempt-1',
        session_id: session.id,
        question_id: draft.id,
        question: draft.question,
        selected_answer: payload['selected_answer'],
        correct_answer: draft.answer,
        rationale: draft.rationale,
        citation_page: draft.citation_page,
        source_excerpt: draft.source_excerpt,
        created_at: '2026-06-09T00:02:00Z',
      });
      await fulfillJson(route, 201, {
        id: 'attempt-1',
        session_id: session.id,
        project_id: project.id,
        question_id: draft.id,
        selected_answer: payload['selected_answer'],
        is_correct: false,
        created_at: '2026-06-09T00:02:00Z',
      });
      return;
    }

    await fulfillJson(route, 404, {
      code: 'not_found',
      message: `${method} ${path} was not mocked.`,
    });
  });

  return {
    project,
    document,
    draft,
    session,
    practiceSessionPayload: () => practiceSessionPayload,
    seenPaths: () => new Set(seenPaths),
  };
}

export function expectedSeenPaths(api: MockExamPrepApi): Set<string> {
  return new Set([
    'GET /health',
    'GET /llm/health',
    'GET /ocr/health',
    'GET /runtime/requirements',
    'GET /projects',
    'POST /projects',
    `GET /projects/${api.project.id}/documents`,
    `POST /projects/${api.project.id}/documents`,
    `GET /projects/${api.project.id}/documents/${api.document.id}`,
    `GET /projects/${api.project.id}/documents/${api.document.id}/chunks`,
    `GET /projects/${api.project.id}/question-drafts`,
    `POST /projects/${api.project.id}/practice-sessions`,
    `GET /projects/${api.project.id}/practice-sessions/${api.session.id}`,
    `POST /projects/${api.project.id}/practice-sessions/${api.session.id}/attempts`,
    `GET /projects/${api.project.id}/wrong-answers`,
  ]);
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
}

async function fulfillJson(
  route: Route,
  status: number,
  body: unknown,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: corsHeaders(),
    body: JSON.stringify(body),
  });
}

function parseJsonBody(body: string | null): Record<string, unknown> {
  if (body === null || body.length === 0) {
    return {};
  }

  return JSON.parse(body) as Record<string, unknown>;
}
