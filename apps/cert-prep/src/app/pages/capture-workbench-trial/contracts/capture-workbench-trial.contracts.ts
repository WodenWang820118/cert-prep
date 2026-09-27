import { CAPTURE_RUNTIME_VERSION } from '@cert-prep/capture-runtime-version';
import type { RuntimeReady } from '@gx-capture/capture-workbench-ui';

export interface CaptureRecord {
  readonly projectId: string;
  readonly documentId: string;
  readonly sourceSha256: string;
  readonly structuringRequestId: string;
}

export interface SseEventFrame {
  readonly id: string;
  readonly event: string;
  readonly data: string;
}

export interface CertPrepCaptureEventStreamInit extends RequestInit {
  readonly lastEventId?: string | number;
  readonly expectedCaptureId: string;
}

export type UnknownRecord = Record<string, unknown>;

export type OcrComputeMode = 'gpu-dml' | 'cpu-fallback';
export type OcrAdapterClass = 'dedicated' | 'integrated' | 'unknown';
export type OcrComputeReasonCode =
  | 'no_compatible_gpu'
  | 'dml_provider_unavailable';
export type OcrComputeNoticeCode = 'ocr_cpu_fallback';

export interface OcrComputePreflight {
  readonly apiVersion: '2.0';
  readonly schemaVersion: '1';
  readonly service: 'capture-runtime';
  readonly runtimeVersion: typeof CAPTURE_RUNTIME_VERSION;
  readonly contractSetVersion: '2';
  readonly contractSha256: string;
  readonly workerSha256: string | null;
  readonly mode: OcrComputeMode;
  readonly adapterClass: OcrAdapterClass;
  readonly reasonCode: OcrComputeReasonCode | null;
  readonly userNoticeRequired: boolean;
  readonly noticeCode: OcrComputeNoticeCode | null;
}

export interface CaptureRuntimeReady extends RuntimeReady {
  readonly ocrCompute: OcrComputePreflight | null;
}
