import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  ElementRef,
  inject,
  OnDestroy,
  ViewChild,
  signal,
} from '@angular/core';
import {
  CAPTURE_WORKBENCH_CUSTOM_EVENTS,
  defineCaptureWorkbenchElement,
  type CaptureCompletedEvent,
  type CaptureWorkbenchElement,
} from '@gx/capture-workbench';
import { Subscription } from 'rxjs';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { CertPrepCaptureClient } from './cert-prep-capture-client';

@Component({
  selector: 'app-capture-workbench-trial-page',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './capture-workbench-trial.page.html',
  styleUrl: './capture-workbench-trial.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureWorkbenchTrialPage implements AfterViewInit, OnDestroy {
  @ViewChild('captureWorkbench')
  private captureWorkbench?: ElementRef<CaptureWorkbenchElement>;

  protected readonly client = inject(CertPrepCaptureClient);
  private readonly projects = inject(ProjectStore);
  protected readonly sourceImport = inject(SourceImportStore);
  protected readonly registrationState = signal<
    'registering' | 'ready' | 'error'
  >('registering');
  protected readonly trialStatus = signal(
    'Choose one PDF to run through Capture Runtime OCR.',
  );
  protected readonly lastCompleted = signal<CaptureCompletedEvent | null>(null);
  protected readonly registrationError = signal<string | null>(null);
  protected readonly markdownDownloadState = signal<'idle' | 'downloading'>(
    'idle',
  );
  protected readonly markdownDownloadError = signal<string | null>(null);
  private readonly registration = new Subscription();

  ngAfterViewInit(): void {
    this.registration.add(
      defineCaptureWorkbenchElement().subscribe({
        next: () => this.configureElement(),
        error: (error: unknown) => {
          this.registrationState.set('error');
          this.registrationError.set(
            error instanceof Error ? error.message : String(error),
          );
        },
      }),
    );
  }

  ngOnDestroy(): void {
    const element = this.captureWorkbench?.nativeElement;
    if (element) {
      element.removeEventListener(
        CAPTURE_WORKBENCH_CUSTOM_EVENTS.completed,
        this.onCompleted,
      );
    }
    this.registration.unsubscribe();
  }

  private configureElement(): void {
    const element = this.captureWorkbench?.nativeElement;
    if (!element) {
      this.registrationState.set('error');
      this.registrationError.set(
        'The Capture Workbench element is unavailable.',
      );
      return;
    }

    element.config = {
      enabledSources: ['pdf'],
      structuringMode: 'host',
      outputMode: 'json',
      multiple: false,
      showRuntimeSetup: false,
      hostStructuringOwner: 'client',
      hostManagedHandshake: false,
      reviewBeforeCommit: true,
      reviewEditable: true,
      width: '100%',
      height: 'min(620px, 70vh)',
      density: 'comfortable',
    };
    element.client = this.client;
    element.addEventListener(
      CAPTURE_WORKBENCH_CUSTOM_EVENTS.completed,
      this.onCompleted,
    );
    this.registrationState.set('ready');
    this.trialStatus.set('Capture Workbench is ready. Select a PDF.');
  }

  private readonly onCompleted = (event: Event): void => {
    const completed = event as CustomEvent<CaptureCompletedEvent>;
    this.lastCompleted.set(completed.detail);
    const projectId = this.projects.selectedProjectId();
    const documentId = this.client.documentIdForSourceSha256(
      completed.detail.document.source.sha256,
    );
    if (projectId !== null) {
      if (documentId !== null) {
        this.sourceImport.refreshUploadedDocument(projectId, documentId);
      }
      // Re-select the document from the durable project list as well. This
      // closes the startup/resource race where an in-flight project refresh
      // can otherwise clear the just-completed active document.
      this.sourceImport.loadLatestDocument(projectId);
    }
    this.trialStatus.set(
      `Completed ${completed.detail.document.source.fileName}. Saved to your project.`,
    );
  };

  protected downloadMarkdown(): void {
    const completed = this.lastCompleted();
    const document = this.sourceImport.activeDocument();
    if (
      completed === null ||
      document === null ||
      document.status !== 'ready' ||
      document.chunks_count < 1
    ) {
      return;
    }

    this.markdownDownloadState.set('downloading');
    this.markdownDownloadError.set(null);
    this.registration.add(
      this.client.getDocumentMarkdown(document.project_id, document.id).subscribe({
        next: (blob) => {
          const objectUrl = URL.createObjectURL(blob);
          try {
            const anchor = window.document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = markdownFilename(
              completed.document.source.fileName,
            );
            window.document.body.append(anchor);
            try {
              anchor.click();
            } finally {
              anchor.remove();
            }
          } finally {
            URL.revokeObjectURL(objectUrl);
            this.markdownDownloadState.set('idle');
          }
        },
        error: (error: unknown) => {
          this.markdownDownloadState.set('idle');
          this.markdownDownloadError.set(
            error instanceof Error
              ? error.message
              : 'Markdown download failed. Please try again.',
          );
        },
      }),
    );
  }
}

function markdownFilename(filename: string): string {
  const pathFreeName = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  const stem = pathFreeName.replace(/\.[^.]*$/, '') || 'document';
  return `${stem}.md`;
}
