import type { Browser, Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';
import type {
  ProcessSnapshot,
  PublicProcessRecord,
} from '../process-lifecycle/processes.mts';

export interface SmokeOptions {
  workspaceRoot: string;
  exePath: string;
  pdfPath: string;
  outDir: string;
  appDataDir?: string;
  cdpPort: number;
  ocrProvider: string;
  ocrPageWorkers: number;
  llmProvider: string;
  ollamaModel: string;
  ollamaFallbackModels: string[];
  streamingDraftPageLimit?: number;
  streamingDraftWorkers?: number;
  waitForStreamingComplete: boolean;
  streamingCompleteTimeoutMs: number;
  skipGpuSampling: boolean;
  productionSummary: boolean;
  allowOcrChunkVariance: boolean;
  verifyStreamingPracticeReady: boolean;
  recordVideo: boolean;
}

export interface SmokeMetrics {
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  finished_at?: string;
  out_dir: string;
  screenshots: string[];
  video_artifacts?: VideoArtifact[];
  ui_timings_ms: Record<string, number>;
  observations: string[];
  errors: string[];
  project_name?: string;
  selected_answer?: string;
  wrong_answer?: string;
  llm_provider: string;
  llm_model: string;
  llm_configured_model?: string;
  llm_effective_model?: string;
  llm_fallback_models: string[];
  llm_fallback_reason?: string | null;
  llm_health?: LlmHealthSnapshot;
  ocr_provider: string;
  first_chunk_gate_ms: number;
  first_chunk_under_gate: boolean;
  streaming_draft_page_limit?: number;
  streaming_draft_workers?: number;
  wait_for_streaming_complete?: boolean;
  app_data_dir?: string;
  ocr_completion?: OcrCompletionMetrics;
  streaming_baseline?: StreamingBaselineArtifacts;
  production_summary?: string;
  practice_ready_from_streamed_questions?: boolean;
  restart?: {
    attempted: boolean;
    verified?: boolean;
    close?: CloseSummary;
  };
  final_close?: CloseSummary;
  process_cleanup?: {
    node_cleanup_summary: {
      baseline_node_count: number;
      closed_count: number;
      closed: PublicProcessRecord[];
    };
    new_node_helpers_closed: PublicProcessRecord[];
    residue_after_close: PublicProcessRecord[];
  };
  streaming_questions: StreamingQuestionsMetrics;
  gpu_sampling?: string;
  resource_sampling?: ResourceSamplingArtifacts;
}

export interface ResourceSamplingArtifacts {
  nvidia_smi_csv?: string;
  nvidia_smi_stderr_log?: string;
  windows_counters_csv?: string;
  windows_summary_json?: string;
  windows_dxgi_adapters_json?: string;
}

export interface VideoArtifact {
  readonly path: string;
  bytes: number;
  sha256: string;
  readonly capture_source: 'playwright_screencast';
  status: 'recording' | 'completed' | 'failed';
  readonly started_at: string;
  finished_at?: string;
  error?: string;
}

interface VideoRecordingState {
  readonly artifact: VideoArtifact;
  readonly filePath: string;
  active: boolean;
}

interface StreamingQuestionsMetrics {
  job_snapshots: StreamingDraftJobSnapshot[];
  question_snapshots: StreamingQuestionSnapshot[];
  status_counts: Record<string, number>;
  first_job_visible_ms?: number;
  first_status_visible_ms?: number;
  first_question_visible_ms?: number;
  first_usable_question_visible_ms?: number;
  all_jobs_terminal_ms?: number;
  blocker?: string;
}

interface OcrCompletionMetrics {
  pages_processed: number | null;
  total_pages: number | null;
  chunks: number | null;
  expected_pages: 46;
  expected_chunks: 46;
}

interface StreamingBaselineArtifacts {
  status: 'passed' | 'failed';
  json: string;
  markdown: string;
}

export interface LlmHealthSnapshot {
  provider: string | null;
  available: boolean | null;
  model: string | null;
  configured_model: string | null;
  effective_model: string | null;
  fallback_models: string[];
  fallback_reason: string | null;
  detail: string | null;
}

export interface StreamingJobCompletionState {
  total_count: number;
  active_count: number;
  terminal_count: number;
  succeeded_count: number;
  failed_count: number;
  skipped_count: number;
  all_terminal: boolean;
  all_succeeded: boolean;
}

export interface StreamingDraftJobSnapshot {
  elapsed_ms: number;
  source: 'draft-jobs';
  item_count: number;
  status_counts: Record<string, number>;
  generated_count: number;
  blocker?: string;
}

export interface StreamingQuestionSnapshot {
  elapsed_ms: number;
  source: 'question-drafts';
  item_count: number;
  usable_question_count: number;
}

export interface UploadedDocumentRef {
  apiBaseUrl: string;
  authorization: string | null;
  projectId: string;
  documentId: string;
}

export interface CloseSummary {
  label: string;
  app_pid: number | null;
  normal_close_requested: boolean;
  exited_after_normal_close: boolean;
  forced: boolean;
  residue: PublicProcessRecord[];
  gracefulExited: boolean;
  fallbackUsed: boolean;
  exitCode: number | null;
  residualProcesses: PublicProcessRecord[];
}

interface ChildExitState {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ResourceSamplingController {
  readonly artifacts: ResourceSamplingArtifacts;
  stop(): Promise<void>;
}

export interface SmokeRunState {
  options: SmokeOptions;
  metrics: SmokeMetrics;
  app: ChildProcess | null;
  appExit: ChildExitState | null;
  nvidia: ChildProcess | null;
  resourceSampling: ResourceSamplingController | null;
  videoRecording: VideoRecordingState | null;
  browser: Browser | null;
  page: Page | null;
  port: number;
  processBaseline: ProcessSnapshot;
  uploadedDocument: UploadedDocumentRef | null;
  streamingDraftParseStartedAt: number | null;
  streamingDraftCaptureOpen: boolean;
  streamingApiPollErrorCaptured: boolean;
}
