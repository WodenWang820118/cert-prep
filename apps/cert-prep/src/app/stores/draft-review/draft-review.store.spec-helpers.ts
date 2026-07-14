import type {
  DocumentRead,
  DraftGenerationJobRead,
  ManualDraftGenerationOperationRead,
  QuestionDraftRead,
} from '../../cert-prep-api';

export function questionDraft(
  overrides: Partial<QuestionDraftRead> = {},
): QuestionDraftRead {
  return {
    id: 'draft-1',
    project_id: 'project-1',
    document_id: 'document-1',
    chunk_id: 'chunk-1',
    question: 'Which answer is supported by the cited source?',
    choices: ['A', 'B', 'C', 'D'],
    answer: 'A',
    answer_key_source: 'ai_inferred',
    rationale: 'The source supports A.',
    citation_page: 1,
    source_excerpt: 'The cited source supports answer A.',
    confidence: null,
    source_order: 10001,
    source_question_number: '1',
    item_kind: 'vocabulary_single',
    group_key: null,
    group_prompt: null,
    status: 'approved',
    rejection_reason: null,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}

export function documentRead(
  overrides: Partial<DocumentRead> = {},
): DocumentRead {
  return {
    id: 'document-1',
    project_id: 'project-1',
    filename: 'jlpt-n1.pdf',
    sha256: 'document-sha',
    language_hint: 'ja',
    page_count: 46,
    has_text: true,
    status: 'ready',
    extraction_method: 'paddle_ocr_gpu',
    ocr_device: 'gpu:0',
    ocr_fallback_reason: null,
    ocr_duration_ms: 26513,
    processed_page_count: 46,
    parse_wall_duration_ms: 0,
    render_duration_ms: 0,
    ocr_engine_duration_ms: 26513,
    ocr_worker_count: 1,
    first_chunk_ms: 0,
    exam_item_count: 0,
    content_profile: 'vocabulary_single_questions',
    classification_detail: '{"profile":"vocabulary_single_questions"}',
    chunks_count: 46,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}

export function draftJob(
  overrides: Partial<DraftGenerationJobRead> = {},
): DraftGenerationJobRead {
  return {
    id: 'job-1',
    project_id: 'project-1',
    document_id: 'document-1',
    chunk_id: 'chunk-1',
    page_number: 1,
    strategy: 'hybrid_reasoning',
    status: 'pending',
    phase: 'queued',
    cancellable: true,
    provider: 'ollama',
    model: 'qwen3.5:4b',
    effective_provider: null,
    effective_model: null,
    fallback_reason: null,
    generated_count: 0,
    retry_count: 0,
    last_error: null,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}

export function manualDraftOperation(
  overrides: Partial<ManualDraftGenerationOperationRead> = {},
): ManualDraftGenerationOperationRead {
  return {
    id: 'manual-operation-1',
    project_id: 'project-1',
    document_id: 'document-1',
    limit: 3,
    strategy: 'hybrid_reasoning',
    status: 'running',
    phase: 'generating',
    cancellable: true,
    provider: 'ollama',
    model: 'qwen3.5:4b',
    effective_provider: null,
    effective_model: null,
    fallback_reason: null,
    generated_count: 0,
    error: null,
    created_at: '2026-07-11T00:00:00Z',
    updated_at: '2026-07-11T00:00:00Z',
    ...overrides,
  };
}
