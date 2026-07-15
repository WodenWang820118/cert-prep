import type { Browser, Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';
import type {
  ProcessSnapshot,
  PublicProcessRecord,
} from '../process-lifecycle/processes.mts';
import type { OwnedFastFlowProcessTracker } from './owned-fastflow-process-lifecycle.mts';

export type AcceptanceLane = 'none' | 'xdna2-fastflow' | 'ollama-fallback';

export type CandidateDistributionProfile =
  | 'public_unsigned_alpha'
  | 'local_nonpublishable';

export type OllamaFallbackTrigger =
  | 'declined-terms'
  | 'unsupported-xdna2'
  | 'old-driver';

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
  ollamaHost?: string;
  ollamaModelsDir?: string;
  ollamaProfileEnabled?: boolean;
  acceptanceLane?: AcceptanceLane;
  candidateDistributionProfile?: CandidateDistributionProfile;
  ollamaFallbackTrigger?: OllamaFallbackTrigger;
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
  provider_fallback_reason?: string | null;
  model_fallback_reason?: string | null;
  llm_health?: LlmHealthSnapshot;
  generation_readiness_at_start?: GenerationReadinessSnapshot;
  ollama_fallback_acceptance?: OllamaFallbackAcceptanceEvidence;
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
  gpu_sampling?: string;
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

export interface VideoRecordingState {
  readonly artifact: VideoArtifact;
  readonly filePath: string;
  active: boolean;
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
  fallback_models: string[];
  fallback_reason: string | null;
  detail: string | null;
  profile_id?: string | null;
  base_model?: string | null;
  modelfile_sha256?: string | null;
  profile_reason?: string | null;
  profile_warnings?: string[];
}

export interface OllamaFallbackSelectionEvidence {
  captured_at: string;
  preference: 'auto';
  selected_provider: 'fastflowlm' | 'ollama';
  effective_provider: 'fastflowlm' | 'ollama';
  configured_model: string;
  effective_model: string;
  provider_fallback_reason: string | null;
  hardware_compatible: boolean;
  requires_terms_acceptance: boolean;
  terms_accepted: boolean;
  terms_version: string | null;
  runtime_requirement_kind: 'fastflowlm' | 'ollama';
  model_requirement_kind: 'fastflowlm_model' | 'ollama_model';
}

export interface OllamaPhysicalInventoryEvidence {
  schema_version: number;
  platform: string;
  platform_version: string;
  architecture: string;
  cpu_name: string | null;
  total_ram_bytes: number | null;
  available_ram_bytes: number | null;
  accelerators: Array<{
    kind: string;
    name: string;
    vendor: string | null;
    driver_version: string | null;
    device_id: string | null;
  }>;
  warnings: string[];
}

export interface OllamaProfileEvidence {
  profile_enabled: boolean;
  profile_id: string | null;
  support_status: string;
  selection_reason: string;
  effective_model: string;
  base_model: string | null;
  modelfile_sha256: string | null;
  fallback_models: string[];
  inventory: OllamaPhysicalInventoryEvidence | null;
}

export interface OllamaRuntimeEvidence {
  requirement_version: string | null;
  installed_path_verified: true;
  api_version: string;
  installed_models: string[];
  profile: OllamaProfileEvidence;
}

export interface OllamaResourceReleaseEvidence {
  captured_at: string;
  effective_model: string;
  loaded_models: string[];
  released: boolean;
}

export interface OllamaFallbackAcceptanceEvidence {
  schema_version: 1;
  trigger: OllamaFallbackTrigger;
  trigger_mode: 'persisted_terms_decision' | 'physical_inventory_observation';
  overrides_used: false;
  fake_provider_observed: boolean;
  decision_endpoint: string | null;
  selection_before: OllamaFallbackSelectionEvidence;
  selection_after_route: OllamaFallbackSelectionEvidence;
  selection_after_restart: OllamaFallbackSelectionEvidence;
  provider_fallback_reason: string;
  model_fallback_reason: string | null;
  runtime: OllamaRuntimeEvidence;
  job_attribution: StreamingDraftJobAttribution[];
  usable_question_count: number;
  full_exam_question_count: number;
  resource_release: OllamaResourceReleaseEvidence | null;
}

export interface LlmProviderSelectionSnapshot {
  preference: string | null;
  selected_provider: string | null;
  effective_provider: string | null;
  configured_model: string | null;
  effective_model: string | null;
  selection_reason: string | null;
  fallback_reason: string | null;
  hardware_compatible: boolean | null;
  requires_terms_acceptance: boolean | null;
  terms_accepted: boolean | null;
  terms_version: string | null;
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
  nvidia: ChildProcess | null;
  resourceSampling: ResourceSamplingController | null;
  videoRecording: VideoRecordingState | null;
  browser: Browser | null;
  page: Page | null;
  port: number;
  processBaseline: ProcessSnapshot;
  ownedFastFlowProcesses: OwnedFastFlowProcessTracker | null;
  trustedFastFlowExecutablePath: string | null;
  projectApi: ProjectApiRef | null;
  uploadedDocument: UploadedDocumentRef | null;
  streamingDraftParseStartedAt: number | null;
  streamingDraftCaptureOpen: boolean;
  streamingApiPollErrorCaptured: boolean;
}
