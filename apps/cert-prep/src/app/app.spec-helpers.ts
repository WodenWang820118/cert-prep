import type {
  DocumentRead,
  HealthResponse,
  LLMHealthRead,
  OCRHealthRead,
  ProjectRead,
  QuestionDraftRead,
} from './cert-prep-api';

export const appProject: ProjectRead = {
  id: 'project-1',
  name: 'Security Study',
  description: 'Local cert prep',
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
};

export const secondAppProject: ProjectRead = {
  ...appProject,
  id: 'project-2',
  name: 'Network Study',
};

export const appDocument: DocumentRead = {
  id: 'document-1',
  project_id: appProject.id,
  filename: 'security.pdf',
  sha256: 'abc123',
  language_hint: 'en',
  page_count: 12,
  has_text: true,
  status: 'ready',
  extraction_method: 'text',
  ocr_device: null,
  ocr_fallback_reason: null,
  ocr_duration_ms: 0,
  processed_page_count: 12,
  parse_wall_duration_ms: 0,
  render_duration_ms: 0,
  ocr_engine_duration_ms: 0,
  ocr_worker_count: 1,
  first_chunk_ms: 0,
  exam_item_count: 1,
  content_profile: 'vocabulary_single_questions',
  classification_detail: '{"profile":"vocabulary_single_questions"}',
  chunks_count: 6,
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
};

export const secondAppDocument: DocumentRead = {
  ...appDocument,
  id: 'document-2',
  project_id: secondAppProject.id,
  filename: 'network.pdf',
};

export const editableAppQuestion: QuestionDraftRead = {
  id: 'draft-1',
  project_id: appProject.id,
  document_id: appDocument.id,
  chunk_id: 'chunk-1',
  question: 'Which principle limits permissions?',
  choices: ['Least privilege', 'Privilege sprawl'],
  answer: 'Least privilege',
  answer_key_source: 'manual',
  rationale: 'Permissions stay scoped.',
  citation_page: 2,
  source_excerpt: 'Least privilege limits access.',
  confidence: null,
  source_order: 10001,
  source_question_number: '1',
  item_kind: 'vocabulary_single',
  group_key: null,
  group_prompt: null,
  status: 'approved',
  rejection_reason: null,
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
};

export function backendHealth(): HealthResponse {
  return {
    status: 'ok',
    app: 'cert-prep-backend',
    version: '0.1.0',
    python_version: '3.13.5',
    runtime_mode: 'source',
  };
}

export function availableLlmHealth(): LLMHealthRead {
  return {
    provider: 'fake',
    model: 'reasoner:7b',
    available: true,
    detail: 'deterministic local fake provider',
    unavailable_reason: null,
  };
}

export function availableOcrHealth(): OCRHealthRead {
  return {
    provider: 'fake',
    engine: 'none',
    available: true,
    detail: 'deterministic local fake OCR provider',
    python_version: '3.13.5',
    paddle_version: null,
    paddleocr_version: null,
    selected_device: null,
    cuda_available: false,
    gpu_count: 0,
    model_cache_dir: null,
    fallback_reason: null,
    unavailable_reason: null,
  };
}

export function buttonByText(
  root: ParentNode,
  text: string,
): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}
