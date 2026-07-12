import { TestBed } from '@angular/core/testing';
import {
  DocumentRead,
  CERT_PREP_API,
  PracticeSessionRead,
  ProjectRead,
  QuestionDraftRead,
} from '../../cert-prep-api';
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
  const questions: QuestionDraftRead[] = [
    editableQuestion('draft-1', documents[0].id),
    editableQuestion('draft-2', documents[1].id),
    editableQuestion('draft-3', documents[1].id),
    editableQuestion('draft-4', documents[1].id, {
      status: 'rejected',
      rejection_reason: 'No supported answer.',
    }),
    editableQuestion('draft-5', documents[0].id, { question: '   ' }),
    editableQuestion('draft-6', documents[1].id, { answer: 'C' }),
    editableQuestion('draft-7', documents[1].id, {
      citation_page: null,
      source_excerpt: null,
    }),
  ];
  const session: PracticeSessionRead = {
    id: 'session-1',
    project_id: project.id,
    question_ids: ['draft-1'],
    questions: [],
    mode: 'random_draw',
    document_id: null,
    question_count: 1,
    random_seed: 1234,
    status: 'active',
    created_at: '2026-06-17T00:00:00Z',
    completed_at: null,
    abandoned_at: null,
    attempts: [],
  };
  const apiClient = {
    createPracticeSession: vi.fn().mockResolvedValue(session),
    getPracticeSession: vi.fn().mockResolvedValue(session),
    listQuestionDrafts: vi.fn().mockResolvedValue({ items: questions }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    });

    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([project]);
    projects.select(project.id);

    TestBed.inject(SourceImportStore).documents.set(documents);
    TestBed.inject(DraftReviewStore).drafts.set(questions);
  });

  it('sends a full-document payload for the selected parsed document', async () => {
    const store = TestBed.inject(PracticeStore);
    store.setSelectedDocumentId(documents[1].id);

    expect(store.selectedDocumentQuestionCount()).toBe(2);

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

  it('defaults full-document sessions to the active document when playable', async () => {
    const store = TestBed.inject(PracticeStore);
    TestBed.inject(SourceImportStore).setActiveDocumentId(documents[1].id);

    await store.createPracticeSession('full_document');

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'full_document',
      document_id: documents[1].id,
      question_count: 2,
    });
  });

  it('sends a random-draw payload capped to playable question count', async () => {
    const store = TestBed.inject(PracticeStore);
    store.setSessionQuestionCount(10);

    expect(store.questionCount()).toBe(3);
    expect(store.effectiveRandomQuestionCount()).toBe(3);

    await store.createPracticeSession('random_draw');

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'random_draw',
      question_count: 3,
    });
  });

  it('excludes non-playable drafts from practice availability', async () => {
    const store = TestBed.inject(PracticeStore);
    store.setSelectedDocumentId(documents[1].id);

    expect(store.questionCount()).toBe(3);
    expect(store.selectedDocumentQuestionCount()).toBe(2);

    await store.createPracticeSession('full_document');

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'full_document',
      document_id: documents[1].id,
      question_count: 2,
    });
  });

  it('does not surface a non-approved in-session draft as active', () => {
    const store = TestBed.inject(PracticeStore);
    store.practiceSession.set({
      ...session,
      id: 'session-rejected',
      question_ids: ['draft-4'],
      question_count: 1,
    });

    expect(store.activeQuestion()).toBeNull();
    expect(store.sessionComplete()).toBe(false);
  });

  it('does not surface an incomplete approved in-session draft as active', () => {
    const store = TestBed.inject(PracticeStore);
    store.practiceSession.set({
      ...session,
      id: 'session-incomplete',
      question_ids: ['draft-5'],
      question_count: 1,
    });

    expect(store.activeQuestion()).toBeNull();
    expect(store.sessionComplete()).toBe(false);
  });

  it('surfaces session snapshot questions before live draft rows', () => {
    const store = TestBed.inject(PracticeStore);
    store.practiceSession.set({
      ...session,
      question_ids: ['draft-1'],
      questions: [
        {
          id: 'draft-1',
          question: 'Snapshot question text?',
          choices: ['Snapshot A', 'Snapshot B'],
          answer: 'Snapshot A',
          rationale: 'Snapshot rationale.',
          citation_page: 7,
          source_excerpt: 'Snapshot source excerpt.',
          document_id: documents[0].id,
        },
      ],
    });

    expect(store.activeQuestion()).toEqual({
      id: 'draft-1',
      question: 'Snapshot question text?',
      choices: ['Snapshot A', 'Snapshot B'],
      answer: 'Snapshot A',
      rationale: 'Snapshot rationale.',
      citation_page: 7,
      source_excerpt: 'Snapshot source excerpt.',
      document_id: documents[0].id,
    });
  });

  it('creates review retry sessions for wrong attempts', async () => {
    const store = TestBed.inject(PracticeStore);

    await expect(store.createReviewRetrySession(['attempt-1'])).resolves.toBe(
      true,
    );

    expect(apiClient.createPracticeSession).toHaveBeenCalledWith(project.id, {
      mode: 'review_retry',
      wrong_attempt_ids: ['attempt-1'],
      question_count: 1,
    });
    expect(store.practiceSession()).toEqual(session);
  });

  it('blocks a new random session while review retry is still active', async () => {
    const store = TestBed.inject(PracticeStore);
    store.practiceSession.set({
      ...session,
      mode: 'review_retry',
      questions: [
        {
          id: 'draft-1',
          question: 'Retry the missed question?',
          choices: ['A', 'B'],
          answer: 'A',
          rationale: 'Because A is cited.',
          citation_page: 1,
          source_excerpt: 'Source excerpt.',
          document_id: documents[0].id,
        },
      ],
    });

    expect(store.canCreatePracticeSession('random_draw')).toBe(false);
    expect(store.sessionStartBlocker('random_draw')).toBe(
      'Finish the active review retry before starting a new practice session.',
    );

    await store.createPracticeSession('random_draw');

    expect(apiClient.createPracticeSession).not.toHaveBeenCalled();
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

function editableQuestion(
  id: string,
  documentId: string,
  overrides: Partial<QuestionDraftRead> = {},
): QuestionDraftRead {
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
    item_kind: 'vocabulary_single',
    group_key: null,
    group_prompt: null,
    status: 'approved',
    rejection_reason: null,
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
    ...overrides,
  };
}
