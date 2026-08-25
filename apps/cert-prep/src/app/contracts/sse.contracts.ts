export interface CertPrepSseJsonEvent<T> {
  readonly id: string;
  readonly event: string;
  readonly data: T;
}

export interface SseFrame {
  readonly id: string;
  readonly event: string;
  readonly data: string;
}

export interface CertPrepSseStreamOptions<T> {
  readonly lastEventId?: string | number;
  readonly signal?: AbortSignal;
  readonly isTerminal: (value: T) => boolean;
}

export interface CertPrepSseJsonStreamInit<T> extends RequestInit {
  readonly eventName: string;
  readonly lastEventId?: string | number;
  readonly isTerminal: (value: T) => boolean;
}
