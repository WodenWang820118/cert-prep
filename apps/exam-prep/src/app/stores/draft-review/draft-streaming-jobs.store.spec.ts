import { TestBed } from '@angular/core/testing';
import { EXAM_PREP_API } from '../../exam-prep-api';
import { DraftReviewStore } from './draft-review.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';
import {
  documentRead,
  draftJob,
  questionDraft,
} from './draft-review.store.spec-helpers';

describe('DraftReviewStore streaming jobs', () => {
  const apiClient = {
    generateDocumentDrafts: vi.fn(),
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocumentDraftJobs: vi.fn(),
    listQuestionDrafts: vi.fn(),
    retryDocumentDraftJobs: vi.fn(),
    updateQuestionDraft: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
    });

    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([
      {
        id: 'project-1',
        name: 'JLPT N1',
        description: '',
        created_at: '2026-06-09T00:00:00Z',
        updated_at: '2026-06-09T00:00:00Z',
      },
    ]);
    projects.select('project-1');

    apiClient.getDocument.mockResolvedValue(documentRead());
    apiClient.listDocumentChunks.mockResolvedValue({ items: [] });
    apiClient.listDocumentDraftJobs.mockResolvedValue({ items: [] });
  });

  it('refreshes questions while a processing document has completed chunks', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });
    apiClient.listDocumentDraftJobs.mockResolvedValue({
      items: [
        draftJob({ status: 'running' }),
        draftJob({ id: 'job-2', status: 'succeeded', generated_count: 1 }),
      ],
    });

    sourceImport.uploadedDocument.set(
      documentRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(apiClient.listQuestionDrafts).toHaveBeenCalledWith('project-1');
    expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(store.drafts()).toEqual([draft]);
    expect(store.draftJobSummary()).toEqual(
      expect.objectContaining({
        active: 1,
        generatedCount: 1,
        label: 'Generating 1/2',
        severity: 'info',
      }),
    );

    sourceImport.uploadedDocument.set(documentRead({ status: 'ready' }));
    TestBed.tick();
    await Promise.resolve();
  });

  it('keeps streaming question refresh when job status is temporarily unavailable', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });
    apiClient.listDocumentDraftJobs.mockRejectedValue(new Error('jobs offline'));

    sourceImport.uploadedDocument.set(
      documentRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.drafts()).toEqual([draft]);
    expect(store.draftJobs()).toEqual([]);
  });

  it('surfaces skipped streaming question jobs when the reasoning model is missing', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [] });
    apiClient.listDocumentDraftJobs.mockResolvedValue({
      items: [
        draftJob({
          status: 'skipped_missing_model',
          last_error: 'qwen3.5:4b is not installed',
        }),
      ],
    });

    sourceImport.uploadedDocument.set(
      documentRead({ status: 'processing', chunks_count: 1 }),
    );
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.draftJobSummary()).toEqual(
      expect.objectContaining({
        label: 'Model missing',
        skipped: 1,
        severity: 'warn',
      }),
    );
  });

  it('retries skipped streaming question jobs for the current document', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    const skippedJob = draftJob({
      status: 'skipped_missing_model',
      last_error: 'qwen3.5:4b is not installed',
    });
    const succeededJob = draftJob({
      status: 'succeeded',
      generated_count: 1,
      retry_count: 1,
    });
    sourceImport.uploadedDocument.set(documentRead());
    store.draftJobs.set([skippedJob]);
    apiClient.retryDocumentDraftJobs.mockResolvedValue({ items: [succeededJob] });
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });

    await store.retryDraftJobs();

    expect(apiClient.retryDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(store.draftJobs()).toEqual([succeededJob]);
    expect(store.drafts()).toEqual([draft]);
    expect(apiClient.getDocument).toHaveBeenCalledWith('project-1', 'document-1');
  });
});
