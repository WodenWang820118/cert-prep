import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import type { DocumentRead } from '@cert-prep/api';
import { of } from 'rxjs';
import type { CaptureCompletedEvent } from '@gx/capture-workbench';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { CertPrepCaptureClient } from './cert-prep-capture-client';
import { CaptureWorkbenchTrialPage } from './capture-workbench-trial.page';

describe('CaptureWorkbenchTrialPage', () => {
  const activeDocument = signal<DocumentRead | null>(null);
  const selectedProjectId = signal<string | null>(null);
  let captureClient: {
    documentIdForSourceSha256: ReturnType<typeof vi.fn>;
    getDocumentMarkdown: ReturnType<typeof vi.fn>;
  };
  let refreshUploadedDocument: ReturnType<typeof vi.fn>;
  let loadLatestDocument: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    activeDocument.set(null);
    selectedProjectId.set(null);
    captureClient = {
      documentIdForSourceSha256: vi.fn().mockReturnValue(null),
      getDocumentMarkdown: vi.fn().mockReturnValue(of(new Blob(['# scan']))),
    };
    refreshUploadedDocument = vi.fn();
    loadLatestDocument = vi.fn();
    TestBed.configureTestingModule({
      imports: [CaptureWorkbenchTrialPage],
      providers: [
        {
          provide: CertPrepCaptureClient,
          useValue: captureClient,
        },
        {
          provide: ProjectStore,
          useValue: { selectedProjectId },
        },
        {
          provide: SourceImportStore,
          useValue: {
            activeDocument,
            refreshUploadedDocument,
            loadLatestDocument,
        },
        },
      ],
    });
  });

  it('renders the PDF OCR surface with the real client contract', () => {
    const fixture = TestBed.createComponent(CaptureWorkbenchTrialPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Capture Workbench PDF OCR');
    expect(fixture.nativeElement.querySelector('capture-workbench')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('registering');
    expect(fixture.nativeElement.textContent).not.toContain('in-memory');
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it('shows and downloads Markdown only after the saved PDF is ready', async () => {
    activeDocument.set({
      id: 'document-1',
      project_id: 'project-1',
      filename: 'scan.pdf',
      status: 'ready',
      source_kind: 'pdf',
      chunks_count: 46,
    } as DocumentRead);
    const fixture = TestBed.createComponent(CaptureWorkbenchTrialPage);
    const page = fixture.componentInstance as unknown as {
      lastCompleted: { set(value: CaptureCompletedEvent): void };
      downloadMarkdown(): void;
    };
    page.lastCompleted.set({
      taskId: 'task-1',
      document: {
        source: { fileName: 'scan.pdf', bytes: 4 },
        schemaVersion: '1',
        blocks: [],
      },
    } as unknown as CaptureCompletedEvent);
    fixture.detectChanges();

    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:markdown');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    expect(fixture.nativeElement.textContent).toContain('Download Markdown');
    page.downloadMarkdown();
    await fixture.whenStable();

    expect(captureClient.getDocumentMarkdown).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchorClick).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:markdown');
  });

  it('refreshes the saved document after Capture Workbench completion', () => {
    selectedProjectId.set('project-1');
    captureClient.documentIdForSourceSha256.mockReturnValue('document-1');
    const fixture = TestBed.createComponent(CaptureWorkbenchTrialPage);
    const page = fixture.componentInstance as unknown as {
      onCompleted(event: Event): void;
    };

    page.onCompleted(
      new CustomEvent('capture-completed', {
        detail: {
          taskId: 'task-1',
          document: {
            source: {
              sha256: 'a'.repeat(64),
              fileName: 'scan.pdf',
            },
          },
        },
      }),
    );

    expect(refreshUploadedDocument).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
    expect(loadLatestDocument).toHaveBeenCalledWith('project-1');
  });
});
