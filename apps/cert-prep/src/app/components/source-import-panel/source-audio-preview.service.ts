import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { catchError, of } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import type { SourceAudioPreviewViewModel } from './source-import-panel.contracts';
import { INITIAL_SOURCE_AUDIO_PREVIEW_STATE } from './constants/source-audio-preview.constants';

@Injectable()
export class SourceAudioPreviewService {
  private readonly api = inject(CERT_PREP_API);
  private readonly destroyRef = inject(DestroyRef);
  private readonly requestState = signal<SourceAudioPreviewViewModel>(
    INITIAL_SOURCE_AUDIO_PREVIEW_STATE,
  );
  private requestId = 0;
  private requestedKey: string | null = null;
  private currentContext: { projectId: string; documentId: string } | null =
    null;
  private abortController: AbortController | null = null;
  private objectUrl: string | null = null;
  private destroyed = false;

  readonly state = this.requestState.asReadonly();

  constructor() {
    this.destroyRef.onDestroy(() => this.destroy());
  }

  load(projectId: string | null, documentId: string | null): void {
    const key =
      projectId === null || documentId === null
        ? null
        : `${projectId}:${documentId}`;
    if (key === this.requestedKey && !this.destroyed) {
      return;
    }

    this.requestedKey = key;
    this.currentContext =
      projectId === null || documentId === null
        ? null
        : { projectId, documentId };
    const requestId = ++this.requestId;
    this.abortController?.abort();
    this.abortController = null;
    this.releaseObjectUrl();
    this.requestState.set(INITIAL_SOURCE_AUDIO_PREVIEW_STATE);

    if (this.currentContext === null || this.destroyed) {
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;
    const { projectId: currentProjectId, documentId: currentDocumentId } =
      this.currentContext;
    this.requestState.set({ url: null, loading: true, error: null });
    this.api
      .getDocumentAudioSource(currentProjectId, currentDocumentId, {
        signal: controller.signal,
      })
      .pipe(catchError(() => of(null)))
      .subscribe((source) => {
        if (
          this.destroyed ||
          requestId !== this.requestId ||
          controller.signal.aborted
        ) {
          return;
        }

        if (source === null) {
          this.requestedKey = null;
          this.requestState.set({
            url: null,
            loading: false,
            error: 'The source audio could not be loaded.',
          });
        } else if (typeof URL.createObjectURL !== 'function') {
          this.requestState.set({
            url: null,
            loading: false,
            error: 'Audio playback is unavailable in this environment.',
          });
        } else {
          try {
            const objectUrl = URL.createObjectURL(source);
            this.objectUrl = objectUrl;
            this.requestState.set({
              url: objectUrl,
              loading: false,
              error: null,
            });
          } catch {
            this.requestState.set({
              url: null,
              loading: false,
              error: 'Audio playback is unavailable in this environment.',
            });
          }
        }

        if (this.abortController === controller) {
          this.abortController = null;
        }
      });
  }

  retry(): void {
    const context = this.currentContext;
    if (context === null || this.destroyed) {
      return;
    }
    this.requestedKey = null;
    this.load(context.projectId, context.documentId);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.requestId += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.currentContext = null;
    this.requestedKey = null;
    this.releaseObjectUrl();
    this.requestState.set(INITIAL_SOURCE_AUDIO_PREVIEW_STATE);
  }

  private releaseObjectUrl(): void {
    if (this.objectUrl !== null) {
      if (typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(this.objectUrl);
      }
      this.objectUrl = null;
    }
  }
}
