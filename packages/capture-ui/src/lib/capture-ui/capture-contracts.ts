import { InjectionToken, type Provider } from '@angular/core';
export type CaptureSourceKind = 'pdf' | 'image' | 'audio';
export type CaptureOutputMode = 'json' | 'text';
export type CaptureTaskStatus = 'processing' | 'completed' | 'failed' | 'canceled';
export interface CapturePageSegment { readonly pageNumber: number; readonly text: string; readonly confidence?: number; }
export interface CaptureTimedSegment { readonly startMs: number; readonly endMs: number; readonly text: string; readonly confidence?: number; }
export interface CaptureResultV1 { readonly schemaVersion: '1.0'; readonly source: { readonly fileName: string; readonly mediaType: string; readonly kind: CaptureSourceKind; readonly sizeBytes: number }; readonly status: 'completed'; readonly text: string; readonly pages?: readonly CapturePageSegment[]; readonly segments?: readonly CaptureTimedSegment[]; readonly engine?: { readonly name: string; readonly model?: string; readonly device?: string }; readonly warnings?: readonly string[]; readonly startedAt: string; readonly completedAt: string; }
export interface CaptureAdapterRequest { readonly file: File; readonly sourceKind: CaptureSourceKind; readonly languageHint?: string; readonly signal: AbortSignal; readonly reportProgress: (percentage: number) => void; }
export interface CaptureAdapter { process(request: CaptureAdapterRequest): Promise<CaptureResultV1>; }
export interface CaptureWorkbenchConfig { readonly enabledSources?: readonly CaptureSourceKind[]; readonly outputMode?: CaptureOutputMode; readonly multiple?: boolean; readonly languageHint?: string; readonly width?: string; readonly height?: string; readonly density?: 'compact' | 'comfortable'; readonly colors?: { readonly accent?: string; readonly background?: string; readonly foreground?: string; readonly border?: string }; readonly labels?: { readonly title?: string; readonly chooseFiles?: string; readonly emptyState?: string }; }
export interface CaptureTaskView { readonly id: string; readonly fileName: string; readonly sourceKind: CaptureSourceKind; readonly status: CaptureTaskStatus; readonly progress: number; readonly result?: CaptureResultV1; readonly error?: string; }
export const CAPTURE_ADAPTER = new InjectionToken<CaptureAdapter>('CAPTURE_ADAPTER');
export function provideCaptureAdapter(adapter: CaptureAdapter): Provider { return { provide: CAPTURE_ADAPTER, useValue: adapter }; }
