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
