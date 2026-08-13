import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  ElementRef,
  inject,
  OnDestroy,
  ViewChild,
  effect,
  signal,
} from '@angular/core';
import {
  CAPTURE_WORKBENCH_CUSTOM_EVENTS,
  defineCaptureWorkbenchElement,
  type CaptureCompletedEvent,
  type CaptureWorkbenchElement,
} from '@gx-capture/capture-workbench';
import { Subscription } from 'rxjs';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { CertPrepCaptureClient } from './cert-prep-capture-client';
import { DesktopRuntimeStore } from '../../stores/desktop-runtime/desktop-runtime.store';

@Component({
  selector: 'app-capture-workbench-trial-page',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './capture-workbench-trial.page.html',
  styleUrl: './capture-workbench-trial.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureWorkbenchTrialPage implements AfterViewInit, OnDestroy {
  private captureWorkbench?: ElementRef<CaptureWorkbenchElement>;
  private captureWorkbenchDefined = false;

  @ViewChild('captureWorkbench')
  private set captureWorkbenchView(
    element: ElementRef<CaptureWorkbenchElement> | undefined,
  ) {
    this.captureWorkbench = element;
    this.configureElementWhenReady();
  }

  protected readonly client = inject(CertPrepCaptureClient);
  private readonly projects = inject(ProjectStore);
  protected readonly sourceImport = inject(SourceImportStore);
  protected readonly registrationState = signal<
    'runtime_unavailable' | 'registering' | 'ready' | 'error'
  >('runtime_unavailable');
  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  protected readonly trialStatus = signal(
    'Choose a source to run through Capture Workbench and Capture Runtime.',
  );
  protected readonly lastCompleted = signal<CaptureCompletedEvent | null>(null);
  protected readonly registrationError = signal<string | null>(null);
  protected readonly markdownDownloadState = signal<'idle' | 'downloading'>(
    'idle',
  );
  protected readonly markdownDownloadError = signal<string | null>(null);
  private readonly registration = new Subscription();

  constructor() {
    effect(() => {
      if (
        this.desktopRuntime.isCaptureRuntimeReady() &&
        this.registrationState() === 'runtime_unavailable'
      ) {
        queueMicrotask(() => this.registerCaptureWorkbench());
      }
    });
  }

  ngAfterViewInit(): void {
    this.desktopRuntime.loadCaptureRuntime().subscribe((status) => {
      if (!status?.running) {
        this.trialStatus.set(status?.detail ?? 'Capture Runtime is unavailable.');
      }
    });
  }

  protected installCaptureRuntime(): void {
    this.desktopRuntime.installCaptureRuntime();
  }

  protected startCaptureRuntime(): void {
    this.desktopRuntime.startCaptureRuntime();
  }

  private registerCaptureWorkbench(): void {
    if (this.registrationState() !== 'runtime_unavailable') {
      return;
    }
    this.registrationState.set('registering');
    this.registration.add(
      defineCaptureWorkbenchElement().subscribe({
        next: () => {
          this.captureWorkbenchDefined = true;
          this.configureElementWhenReady();
        },
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

  private configureElementWhenReady(): void {
    if (
      !this.captureWorkbenchDefined ||
      this.registrationState() !== 'registering'
    ) {
      return;
    }
    const element = this.captureWorkbench?.nativeElement;
    if (!element) {
      return;
    }

    element.config = {
      enabledSources: ['pdf', 'image', 'audio'],
      structuringMode: 'host',
      outputMode: 'json',
      multiple: false,
      showRuntimeSetup: false,
      hostStructuringOwner: 'component',
      hostManagedHandshake: true,
      reviewBeforeCommit: true,
      reviewEditable: true,
      labels: {
        reviewTitle: 'Review capture text',
        originalText: 'Original capture',
        reviewedText: 'Reviewed text',
        confirmReview: 'Confirm capture',
      },
      width: '100%',
      height: 'min(620px, 70vh)',
      density: 'comfortable',
    };
    element.client = this.client;
    element.structuringProvider = this.client;
    element.addEventListener(
      CAPTURE_WORKBENCH_CUSTOM_EVENTS.completed,
      this.onCompleted,
    );
    this.registrationState.set('ready');
    this.trialStatus.set(
      'Capture Workbench is ready. Capture Runtime can process PDF, image, and audio sources after their explicit OCR and Whisper consent steps.',
    );
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
