import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CAPTURE_RUNTIME_VERSION } from '@cert-prep/capture-runtime-version';
import { CertPrepCaptureClient } from '../../pages/capture-workbench-trial/cert-prep-capture-client';
import type { CaptureRuntimeReady } from '../../pages/capture-workbench-trial/contracts/capture-workbench-trial.contracts';
import { CaptureRuntimePreflightStore } from './capture-runtime-preflight.store';

describe('CaptureRuntimePreflightStore', () => {
  let client: { getReady: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    client = { getReady: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        CaptureRuntimePreflightStore,
        { provide: CertPrepCaptureClient, useValue: client },
      ],
    });
  });

  it('keeps GPU acceleration visible without a CPU fallback notice', () => {
    client.getReady.mockReturnValue(of(runtimeReady('gpu-dml', 'dedicated')));
    const store = TestBed.inject(CaptureRuntimePreflightStore);

    store.load().subscribe();

    expect(store.isReady()).toBe(true);
    expect(store.canImport()).toBe(true);
    expect(store.gpuAccelerationMessage()).toBe(
      'OCR acceleration enabled (DirectML).',
    );
    expect(store.cpuFallbackNotice()).toBeNull();
  });

  it.each([
    [
      'CPU fallback with no compatible GPU',
      () => runtimeReady('cpu-fallback', 'integrated', 'no_compatible_gpu'),
      'no compatible GPU/DML, CPU may be slower',
    ],
    [
      'CPU fallback with unavailable DirectML provider',
      () => runtimeReady('cpu-fallback', 'unknown', 'dml_provider_unavailable'),
      'no compatible GPU/DML, CPU may be slower',
    ],
    [
      'producer notice flag false',
      () =>
        withOcrComputePatch(
          runtimeReady('cpu-fallback', 'integrated', 'no_compatible_gpu'),
          { userNoticeRequired: false },
        ),
      null,
    ],
    [
      'producer notice code absent',
      () =>
        withOcrComputePatch(
          runtimeReady('cpu-fallback', 'integrated', 'no_compatible_gpu'),
          { noticeCode: null },
        ),
      null,
    ],
    [
      'unknown producer notice code',
      () =>
        withOcrComputePatch(
          runtimeReady('cpu-fallback', 'integrated', 'no_compatible_gpu'),
          { noticeCode: 'ocr_future_notice' },
        ),
      null,
    ],
  ] as const)('%s', (_caseName, createReady, expectedNotice) => {
    client.getReady.mockReturnValue(of(createReady()));
    const store = TestBed.inject(CaptureRuntimePreflightStore);

    store.load().subscribe();

    expect(store.gpuAccelerationMessage()).toBeNull();
    expect(store.cpuFallbackNotice()).toBe(expectedNotice);
    expect(store.canImport()).toBe(true);
  });

  it('blocks import when the runtime omits its OCR decision', () => {
    client.getReady.mockReturnValue(
      of({ ...runtimeReady('gpu-dml', 'dedicated'), ocrCompute: null }),
    );
    const store = TestBed.inject(CaptureRuntimePreflightStore);

    store.load().subscribe();

    expect(store.status()).toBe('error');
    expect(store.canImport()).toBe(false);
    expect(store.error()).toContain('required OCR compute preflight');
  });

  it('preserves an authenticated preflight error and does not become importable', () => {
    client.getReady.mockReturnValue(
      throwError(() => new Error('Capture Runtime authentication failed.')),
    );
    const store = TestBed.inject(CaptureRuntimePreflightStore);

    store.load().subscribe();

    expect(store.status()).toBe('error');
    expect(store.canImport()).toBe(false);
    expect(store.error()).toBe('Capture Runtime authentication failed.');
  });
});

function runtimeReady(
  mode: 'gpu-dml' | 'cpu-fallback',
  adapterClass: 'dedicated' | 'integrated' | 'unknown',
  reasonCode: 'no_compatible_gpu' | 'dml_provider_unavailable' | null = null,
): CaptureRuntimeReady {
  return {
    ready: true,
    service: 'capture-runtime',
    apiVersion: '2.0',
    runtimeVersion: CAPTURE_RUNTIME_VERSION,
    captureDocumentSchemaVersion: '2',
    capabilities: {},
    ocrCompute: {
      apiVersion: '2.0',
      schemaVersion: '1',
      service: 'capture-runtime',
      runtimeVersion: CAPTURE_RUNTIME_VERSION,
      contractSetVersion: '2',
      contractSha256: 'a'.repeat(64),
      workerSha256: 'b'.repeat(64),
      mode,
      adapterClass,
      reasonCode,
      userNoticeRequired: mode === 'cpu-fallback',
      noticeCode: mode === 'cpu-fallback' ? 'ocr_cpu_fallback' : null,
    },
    message: null,
  };
}

function withOcrComputePatch(
  ready: CaptureRuntimeReady,
  patch: Record<string, unknown>,
): CaptureRuntimeReady {
  if (ready.ocrCompute === null) {
    throw new Error('Test runtime readiness must include OCR compute.');
  }
  return {
    ...ready,
    ocrCompute: {
      ...ready.ocrCompute,
      ...patch,
    } as NonNullable<CaptureRuntimeReady['ocrCompute']>,
  };
}
