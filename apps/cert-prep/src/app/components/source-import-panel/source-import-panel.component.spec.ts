import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import type { DocumentRead, ProjectRead } from '../../contracts/api.contracts';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { OperationStore } from '../../stores/operation.store';
import { ProjectStore } from '../../stores/project.store';
import type { SourceUploadItem } from '../../stores/source-import/contracts/source-import.contracts';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { appDocument, appProject, secondAppProject } from '../../testing/app.spec-helpers';
import type { SourceImportAction } from './source-import-panel.contracts';
import { SourceImportPanelComponent } from './source-import-panel.component';

describe('SourceImportPanelComponent', () => {
  let projects: ReturnType<typeof createProjectsFake>;
  let sourceImport: ReturnType<typeof createSourceImportFake>;
  let drafts: { load: ReturnType<typeof vi.fn> };
  let operations: ReturnType<typeof createOperationsFake>;
  let api: { getDocumentAudioSource: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:panel-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    projects = createProjectsFake(appProject);
    sourceImport = createSourceImportFake();
    drafts = { load: vi.fn() };
    operations = createOperationsFake();
    api = {
      getDocumentAudioSource: vi.fn(() => of(new Blob(['audio'], { type: 'audio/mpeg' }))),
    };
    TestBed.configureTestingModule({
      imports: [SourceImportPanelComponent],
      providers: [
        { provide: CERT_PREP_API, useValue: api },
        { provide: DraftReviewStore, useValue: drafts },
        { provide: OperationStore, useValue: operations },
        { provide: ProjectStore, useValue: projects },
        { provide: SourceImportStore, useValue: sourceImport },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the initial source journey with only the next useful actions', () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Choose files');
    expect(text).toContain('Choose a source file to check whether its evidence is ready.');
    expect(text).not.toContain('Concurrent uploads');
    expect(text).not.toContain('Elapsed time');
    expect(text).not.toContain('Capture Runtime Device');
    expect(text).not.toContain('Extraction');
  });

  it('keeps upload and document selection orchestration at the coordinator', () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance as unknown as {
      handleAction(action: SourceImportAction): void;
    };

    component.handleAction({ type: 'upload' });
    component.handleAction({ type: 'select-document', documentId: 'document-1' });

    expect(sourceImport.uploadDocuments).toHaveBeenCalledTimes(1);
    expect(sourceImport.selectDocument).toHaveBeenCalledWith('document-1');
    expect(drafts.load).toHaveBeenNthCalledWith(1, appProject.id);
    expect(drafts.load).toHaveBeenNthCalledWith(2, appProject.id);
  });

  it('reloads drafts when an uploaded document becomes active', () => {
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    fixture.detectChanges();

    sourceImport.activeDocumentId.set('document-1');
    fixture.detectChanges();

    expect(drafts.load).toHaveBeenCalledWith(appProject.id);
  });

  it('preserves append upload intent through a sequential crop queue', () => {
    sourceImport.shouldAppendNewSelection.mockReturnValue(true);
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance as unknown as {
      handleAction(action: SourceImportAction): void;
    };
    const image = new File(['image'], 'scan.png', { type: 'image/png' });
    const pdf = new File(['pdf'], 'guide.pdf', { type: 'application/pdf' });
    const cropped = new File(['cropped'], 'scan-cropped.png', { type: 'image/png' });

    component.handleAction({ type: 'set-crop-images', enabled: true });
    component.handleAction({ type: 'choose-files', files: [image, pdf] });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Image 1 of 1');

    component.handleAction({ type: 'crop-applied', file: cropped });

    expect(sourceImport.chooseFiles).toHaveBeenCalledWith(
      [cropped, pdf],
      { append: true, autoUpload: true },
    );
  });

  it('routes partial-failure cancel and retry actions without changing store contracts', () => {
    sourceImport.uploadItems.set([
      uploadItem('upload-1', 'failed', 'The source upload failed.'),
      uploadItem('upload-2', 'queued', null),
    ]);
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance as unknown as {
      handleAction(action: SourceImportAction): void;
    };

    component.handleAction({ type: 'cancel-upload', itemId: 'upload-2' });
    component.handleAction({ type: 'retry-upload', itemId: 'upload-1' });

    expect(sourceImport.cancelUploadItem).toHaveBeenCalledWith('upload-2');
    expect(sourceImport.retryUploadItem).toHaveBeenCalledWith('upload-1');
    expect(fixture.nativeElement.textContent).toContain('The source upload failed.');
  });

  it('does not let a previous project/document audio response replace the active preview', () => {
    const firstResponse = new Subject<Blob>();
    const secondResponse = new Subject<Blob>();
    api.getDocumentAudioSource
      .mockReset()
      .mockReturnValueOnce(firstResponse)
      .mockReturnValueOnce(secondResponse);
    sourceImport.activeDocument.set(audioDocument('audio-1'));
    sourceImport.previewChunks.set([{} as never]);
    const fixture = TestBed.createComponent(SourceImportPanelComponent);
    fixture.detectChanges();
    expect(api.getDocumentAudioSource).toHaveBeenCalledWith(
      appProject.id,
      'audio-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    projects.selectedProject.set(secondAppProject);
    fixture.detectChanges();
    expect(api.getDocumentAudioSource).toHaveBeenNthCalledWith(
      2,
      secondAppProject.id,
      'audio-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    firstResponse.next(new Blob(['stale'], { type: 'audio/mpeg' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('audio')).toBeNull();

    secondResponse.next(new Blob(['current'], { type: 'audio/mpeg' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('audio')).not.toBeNull();
  });
});

function createProjectsFake(project: ProjectRead) {
  const selectedProject = signal<ProjectRead | null>(project);
  return {
    selectedProject,
    selectedProjectId: computed(() => selectedProject()?.id ?? null),
  };
}

function createOperationsFake() {
  return {
    error: signal<string | null>(null),
    isBusyFor: vi.fn(() => false),
  };
}

function createSourceImportFake() {
  const uploadItems = signal<SourceUploadItem[]>([]);
  const documents = signal<DocumentRead[]>([]);
  const activeDocumentId = signal<string | null>(null);
  const activeDocument = signal<DocumentRead | null>(null);
  const previewChunks = signal<never[]>([]);
  return {
    sourceFileAccept: '.pdf,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a',
    languageHints: ['auto', 'ja'] as const,
    languageHint: signal<'auto' | 'ja'>('auto'),
    uploadItems,
    selectedFileLabel: signal('No source file selected'),
    canUpload: signal(false),
    isUploading: signal(false),
    documents,
    activeDocumentId,
    activeDocument,
    streamError: signal<string | null>(null),
    previewChunks,
    hiddenChunkCount: signal(0),
    isTranscriptMutationBusy: signal(false),
    shouldAppendNewSelection: vi.fn(() => false),
    chooseFiles: vi.fn(),
    uploadDocuments: vi.fn(),
    selectDocument: vi.fn(),
    cancelUploadItem: vi.fn(),
    retryUploadItem: vi.fn(),
    cancelActiveDocumentProcessing: vi.fn(),
    retryActiveDocumentProcessing: vi.fn(),
    retryDocumentStream: vi.fn(),
    updateTranscriptChunk: vi.fn(),
    translateTranscriptChunk: vi.fn(),
    translateStaleTranscriptChunks: vi.fn(),
    showMoreChunks: vi.fn(),
  };
}

function uploadItem(
  id: string,
  status: SourceUploadItem['status'],
  error: string | null,
): SourceUploadItem {
  return {
    id,
    file: new File(['source'], `${id}.pdf`, { type: 'application/pdf' }),
    status,
    document: null,
    error,
  };
}

function audioDocument(id: string): DocumentRead {
  return {
    ...appDocument,
    id,
    source_kind: 'audio',
    chunks_count: 1,
    has_text: true,
  };
}
