import { computed, inject, Injectable, signal } from '@angular/core';
import { catchError, Observable, of, tap } from 'rxjs';
import { CertPrepCaptureClient } from '../../pages/capture-workbench-trial/cert-prep-capture-client';
import type {
  CaptureRuntimeReady,
  OcrComputePreflight,
} from '../../pages/capture-workbench-trial/contracts/capture-workbench-trial.contracts';

export type CaptureRuntimePreflightStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error';

const GPU_ACCELERATION_MESSAGE = 'OCR acceleration enabled (DirectML).';
const CPU_FALLBACK_MESSAGE = 'no compatible GPU/DML, CPU may be slower';

@Injectable({ providedIn: 'root' })
export class CaptureRuntimePreflightStore {
  private readonly client = inject(CertPrepCaptureClient);

  readonly status = signal<CaptureRuntimePreflightStatus>('idle');
  readonly ready = signal<CaptureRuntimeReady | null>(null);
  readonly error = signal<string | null>(null);
  readonly ocrCompute = computed<OcrComputePreflight | null>(
    () => this.ready()?.ocrCompute ?? null,
  );
  readonly gpuAccelerationMessage = computed(() =>
    this.ocrCompute()?.mode === 'gpu-dml' ? GPU_ACCELERATION_MESSAGE : null,
  );
  readonly cpuFallbackNotice = computed(() => {
    const preflight = this.ocrCompute();
    return preflight?.mode === 'cpu-fallback' &&
      preflight.userNoticeRequired &&
      preflight.noticeCode === 'ocr_cpu_fallback'
      ? CPU_FALLBACK_MESSAGE
      : null;
  });
  readonly isLoading = computed(() => this.status() === 'loading');
  readonly isReady = computed(
    () => this.status() === 'ready' && this.ready()?.ready === true,
  );
  readonly canImport = computed(() => this.isReady() && this.ocrCompute() !== null);

  load(): Observable<CaptureRuntimeReady | null> {
    if (this.status() === 'loading') return of(this.ready());

    this.status.set('loading');
    this.error.set(null);
    return this.client.getReady().pipe(
      tap((ready) => {
        if (!ready.ready) {
          throw new Error(ready.message ?? 'Capture Runtime is not ready.');
        }
        if (ready.ocrCompute === null) {
          throw new Error(
            'Capture Runtime did not return the required OCR compute preflight.',
          );
        }
        this.ready.set(ready);
        this.status.set('ready');
      }),
      catchError((error: unknown) => {
        this.ready.set(null);
        this.status.set('error');
        this.error.set(this.errorMessage(error));
        return of(null);
      }),
    );
  }

  retry(): void {
    this.load().subscribe();
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    return 'Capture Runtime OCR preflight could not be loaded.';
  }
}
