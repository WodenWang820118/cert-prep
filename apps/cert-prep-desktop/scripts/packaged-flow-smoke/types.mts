import type { Browser, Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';
import type {
  ProcessSnapshot,
  PublicProcessRecord,
} from '../process-lifecycle/processes.mts';

export type CandidateDistributionProfile =
  | 'public_unsigned_alpha'
  | 'local_nonpublishable';

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
  ollamaHost?: string;
  ollamaModelsDir?: string;
  ollamaProfileEnabled?: boolean;
  acceptanceIsolation?: boolean;
  candidateDistributionProfile?: CandidateDistributionProfile;
  streamingDraftPageLimit?: number;
  streamingDraftWorkers?: number;
  waitForStreamingComplete: boolean;
  streamingCompleteTimeoutMs: number;
  skipGpuSampling: boolean;
  productionSummary: boolean;
  allowOcrChunkVariance: boolean;
  verifyStreamingPracticeReady: boolean;
}

export interface SmokeMetrics {
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  finished_at?: string;
  out_dir: string;
  screenshots: string[];
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
  llm_fallback_reason?: string | null;
  provider_fallback_reason?: string | null;
  model_fallback_reason?: string | null;
  llm_health?: LlmHealthSnapshot;
  generation_readiness_at_start?: GenerationReadinessSnapshot;
  resources_released_at_end?: ResourcesReleasedAtEndSnapshot;
  full_exam_question_count?: number;
  ocr_provider: string;
  first_chunk_gate_ms: number;
  first_chunk_under_gate: boolean;
  streaming_draft_page_limit?: number;
  streaming_draft_workers?: number;
  wait_for_streaming_complete?: boolean;
  app_data_dir?: string;
  acceptance_isolation_at_launch?: AcceptanceIsolationSnapshot;
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
  resource_sampling?: ResourceSamplingArtifacts;
}

export interface AcceptanceIsolationSnapshot {
  readonly captured_at: string;
  readonly out_dir_created_by_runner: boolean;
  readonly app_data_dir_created_by_runner: boolean;
  readonly app_data_dir_empty_at_launch: boolean;
  readonly paths_within_workspace_run_root: boolean;
  readonly reparse_points_absent: boolean;
}

export interface ResourceSamplingArtifacts {
  windows_counters_csv?: string;
  windows_summary_json?: string;
  windows_dxgi_adapters_json?: string;
}

export interface StreamingQuestionsMetrics {
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

export interface OcrCompletionMetrics {
  pages_processed: number | null;
  total_pages: number | null;
  chunks: number | null;
  expected_pages: 46;
  expected_chunks: 46;
}

export interface StreamingBaselineArtifacts {
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
  fallback_reason: string | null;
  execution_mode: 'auto' | 'cpu' | null;
  execution_warning: string | null;
  detail: string | null;
  profile_id?: string | null;
  base_model?: string | null;
  modelfile_sha256?: string | null;
  profile_reason?: string | null;
  profile_warnings?: string[];
}

export interface LlmProviderSelectionSnapshot {
  preference: string | null;
  selected_provider: string | null;
  effective_provider: string | null;
  configured_model: string | null;
  effective_model: string | null;
  selection_reason: string | null;
  fallback_reason: string | null;
  runtime_requirement_kind: string | null;
  model_requirement_kind: string | null;
}

export interface RuntimeRequirementSnapshot {
  kind: string | null;
  available: boolean | null;
  version: string | null;
  installed_path_verified: boolean;
}

export interface GenerationReadinessSnapshot {
  captured_at: string;
  ready: boolean;
  provider_selection: LlmProviderSelectionSnapshot | null;
  runtime_requirements: RuntimeRequirementSnapshot[];
  blockers: string[];
}

export interface StreamingDraftJobAttribution {
  id: string | null;
  status: string | null;
  generated_count: number;
  configured_provider: string | null;
  configured_model: string | null;
  effective_provider: string | null;
  effective_model: string | null;
  fallback_reason: string | null;
  attribution_complete: boolean;
}

export interface ResourcesReleasedAtEndSnapshot {
  captured_at: string;
  released: boolean;
  pre_close_captured_at: string | null;
  pre_close_release_proven: boolean;
  pre_close_stable_empty_snapshots: number;
  stable_empty_snapshots: number;
  observed_owned_processes: OwnedProcessEvidence[];
  alive_owned_processes: OwnedProcessEvidence[];
}

export interface OwnedProcessEvidence {
  pid: number;
  name: string;
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
  jobs: StreamingDraftJobAttribution[];
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

export interface ProjectApiRef {
  apiBaseUrl: string;
  authorization: string;
  projectId: string;
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

export interface ChildExitState {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ResourceSamplingController {
  readonly artifacts: ResourceSamplingArtifacts;
  stop(): Promise<void>;
}

export interface SmokeRunState {
  options: SmokeOptions;
  metrics: SmokeMetrics;
  app: ChildProcess | null;
  appExit: ChildExitState | null;
  resourceSampling: ResourceSamplingController | null;
  browser: Browser | null;
  page: Page | null;
  port: number;
  processBaseline: ProcessSnapshot;
  projectApi: ProjectApiRef | null;
  uploadedDocument: UploadedDocumentRef | null;
  streamingDraftParseStartedAt: number | null;
  streamingDraftCaptureOpen: boolean;
  streamingApiPollErrorCaptured: boolean;
}
