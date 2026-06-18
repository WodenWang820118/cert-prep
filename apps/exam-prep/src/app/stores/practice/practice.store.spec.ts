import { TestBed } from '@angular/core/testing';
import {
  DocumentRead,
  EXAM_PREP_API,
  PracticeSessionRead,
  ProjectRead,
  QuestionDraftRead,
} from '../../exam-prep-api';
import { DraftReviewStore } from '../draft-review/draft-review.store';
import { PracticeStore } from './practice.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';

describe('PracticeStore session modes', () => {
  const project: ProjectRead = {
    id: 'project-1',
    name: 'Security Study',
    description: 'Local prep',
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
  };
  const documents: DocumentRead[] = [
    documentRead('document-1', 'domain-a.pdf'),
    documentRead('document-2', 'domain-b.pdf'),
  ];
  const drafts: QuestionDraftRead[] = [
    approvedDraft('draft-1', documents[0].id),
    approvedDraft('draft-2', documents[1].id),
    approvedDraft('draft-3', documents[1].id),
  ];
  const session: PracticeSessionRead = {
    id: 'session-1',
    project_id: project.id,
    question_ids: ['draft-1'],
    mode: 'random_draw',
    document_id: null,
    question_count: 1,
    random_seed: 1234,
    status: 'active',
    created_at: '2026-06-17T00:00:00Z',
    completed_at: null,
  };
  const apiClient = {
    createPracticeSession: vi.fn().mockResolvedValue(session),
    getPracticeSession: vi.fn().mockResolvedValue(session),
    listQuestionDrafts: vi.fn().mockResolvedValue({ items: drafts }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
    });

    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([project]);
    projects.select(project.id);

    TestBed.inject(SourceImportStore).documents.set(documents);
    TestBed.inject(DraftReviewStore).drafts.set(drafts);
  });

  it('sends a full-document payload for the selected parsed document', async () => {
    const store = TestBed.inject(PracticeStore);
    store.setSelectedDocumentId(documents[1].id);

    await store.createPracticeSession('full_document');

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'full_document',
      document_id: documents[1].id,
      question_count: 2,
    });
    expect(apiClient.getPracticeSession).toHaveBeenCalledWith(
      project.id,
      session.id,
    );
  });

  it('sends a random-draw payload capped to approved item count', async () => {
    const store = TestBed.inject(PracticeStore);
    store.setSessionQuestionCount(10);

    await store.createPracticeSession('random_draw');

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'random_draw',
      question_count: 3,
    });
  });
});

function documentRead(id: string, filename: string): DocumentRead {
  return {
    id,
    project_id: 'project-1',
    filename,
    sha256: id,
    language_hint: 'en',
    page_count: 10,
    has_text: true,
    status: 'ready',
    extraction_method: 'text',
    ocr_device: null,
    ocr_fallback_reason: null,
    ocr_duration_ms: 0,
    processed_page_count: 10,
    parse_wall_duration_ms: 0,
    render_duration_ms: 0,
    ocr_engine_duration_ms: 0,
    ocr_worker_count: 1,
    first_chunk_ms: 0,
    exam_item_count: 3,
    content_profile: 'vocabulary_single_questions',
    classification_detail: '{"profile":"vocabulary_single_questions"}',
    chunks_count: 8,
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
  };
}

function approvedDraft(id: string, documentId: string): QuestionDraftRead {
  return {
    id,
    project_id: 'project-1',
    document_id: documentId,
    chunk_id: `${id}-chunk`,
    question: `Question ${id}`,
    choices: ['A', 'B'],
    answer: 'A',
    answer_key_source: 'manual',
    rationale: 'Because A is cited.',
    citation_page: 1,
    source_excerpt: 'Source excerpt.',
    confidence: null,
    source_order: 10001,
    source_question_number: '1',
    item_kind: 'vocabulary_single_question',
    group_key: null,
    group_prompt: null,
    status: 'approved',
    rejection_reason: null,
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
  };
}
