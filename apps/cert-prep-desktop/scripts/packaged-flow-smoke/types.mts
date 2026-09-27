import type { Browser, Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';
import type {
  OcrTruthEvaluation,
  OcrTruthManifest,
} from '../ocr-truth-contract.mts';
import type {
  ProcessSnapshot,
  PublicProcessRecord,
} from '../process-lifecycle/processes.mts';
import type { OcrPageRecordEvidence } from '../ocr-page-record-evidence.mts';
import type {
  OcrExecutionProofExpectation,
  OcrExecutionProofSummary,
} from '../ocr-execution-proof.mts';
import type { PrivacySafeOcrSemanticEvidence } from '../ocr-semantic-evidence.mts';

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
  llmProvider: string;
  ollamaHost?: string;
  ollamaModelsDir?: string;
  ollamaProfileEnabled?: boolean;
  acceptanceIsolation?: boolean;
  captureRuntimeWorkerMirrorUrl?: string;
  candidateDistributionProfile?: CandidateDistributionProfile;
  streamingDraftPageLimit?: number;
  streamingDraftWorkers?: number;
  waitForStreamingComplete: boolean;
  streamingCompleteTimeoutMs: number;
  skipGpuSampling: boolean;
  productionSummary: boolean;
  allowCaptureChunkVariance: boolean;
  verifyStreamingPracticeReady: boolean;
  acceptanceArtifactRoot?: string;
  acceptanceRecordVideo?: boolean;
  acceptanceVisualCheckpoint?: (page: Page, name: string) => Promise<void>;
  acceptanceFixture?: {
    name: string;
    sha256: string;
    truth?: OcrTruthManifest;
  };
  /**
   * Exact identity required by the Phase 1 local-probe journey. This is
   * deliberately optional so ordinary packaged-flow smoke and release-mode
   * acceptance retain their existing policy.
   */
  acceptanceRuntimeIdentity?: AcceptanceRuntimeIdentityExpectation;
  /** Runtime sink and exact GPU proof identity for the JPEG Phase 1 lane. */
  ocrExecutionEvidenceRoot?: string;
  ocrExecutionProofExpected?: OcrExecutionProofExpectation;
  /** Page-one scope is an acceptance-only override for the PDF child. */
  acceptancePdfPageScope?: 'page-1';
  /** Phase 1 stops after OCR evidence; question generation is a separate lane. */
  acceptanceOcrOnly?: boolean;
  acceptanceVerifyMarkdownExport?: boolean;
}

export interface AcceptanceRuntimeIdentityExpectation {
  readonly runtimeArtifactSha256: string;
  readonly contractSetSha256: string;
  readonly workerArchiveSha256: string;
  readonly workerExecutableSha256: string;
  readonly preflightMode: 'gpu-dml';
  /** Hashes re-read from the exact executable under test, not a build path. */
  readonly installedExecutableSha256?: string;
  readonly installedRuntimeManifestIdentitySha256?: string;
  readonly installedRuntimeCoreSha256?: string;
  readonly installedRuntimeCoreBytes?: number;
}

export interface InstalledRuntimeTupleAttestation {
  readonly schema_version: 1;
  readonly candidate: {
    readonly runtime_version: string;
    readonly runtime_core_sha256: string;
    readonly runtime_core_bytes: number;
    readonly runtime_manifest_identity_sha256: string;
    readonly worker_archive_sha256: string;
    readonly worker_archive_bytes: number;
    readonly worker_executable_sha256: string;
    readonly contract_set_sha256: string;
    readonly python_wheel: {
      readonly file_name: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly package_name: string;
      readonly package_version: string;
      readonly contract_set_sha256: string;
      readonly generated_models: {
        readonly worker_sha256: true;
        readonly pdf_page_numbers: true;
      };
    };
  };
  readonly observed: {
    readonly ready: true;
    readonly runtime_version: string;
    readonly api_version: string;
    readonly capture_document_schema_version: string;
    readonly contract_set_sha256: string;
    readonly worker_executable_sha256: string;
    readonly mode: 'gpu-dml';
  };
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
  first_chunk_gate_ms: number;
  first_chunk_under_gate: boolean;
  streaming_draft_page_limit?: number;
  streaming_draft_workers?: number;
  wait_for_streaming_complete?: boolean;
  app_data_dir?: string;
  acceptance_isolation_at_launch?: AcceptanceIsolationSnapshot;
  ocr_preflight?: OcrPreflightMetrics;
  runtime_attestation?: InstalledRuntimeTupleAttestation;
  ocr_completion?: OcrCompletionMetrics;
  ocr_page_records?: OcrPageRecordEvidence;
  ocr_execution_proof?: OcrExecutionProofSummary;
  ocr_truth?: OcrTruthEvaluation;
  ocr_semantic_evidence?: PrivacySafeOcrSemanticEvidence;
  acceptance_evidence?: Record<string, unknown>;
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
  readonly app_data_dir_within_controlled_root?: boolean;
  readonly reparse_points_absent: boolean;
}

export interface OcrPreflightMetrics {
  readonly mode: 'gpu-dml' | 'cpu-fallback';
  readonly contract_sha256: string;
  readonly worker_sha256: string | null;
  readonly ui_gpu_before_import: boolean;
  readonly source_import_enabled: boolean;
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
  expected_pages: number;
  expected_chunks: number;
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
  ownedCleanupObservation?: OwnedCleanupObservation;
}

export type OwnedCleanupObservation =
  | OwnedCleanupProof
  | OwnedCleanupEvidenceUnavailable;

export interface OwnedCleanupProof {
  readonly ownedProcessPids: number[]; readonly remainingOwnedProcessPids: number[];
  readonly ownedListenerPorts: number[]; readonly remainingOwnedListenerPorts: number[];
  readonly ocrModelWorkerPids: number[]; readonly remainingOcrModelWorkerPids: number[];
}

export interface OwnedCleanupEvidenceUnavailable {
  readonly evidenceUnavailable: {
    readonly source: 'windows_listener_snapshot';
    readonly stage: 'before_close';
  };
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
  acceptanceVideoPaths?: string[];
  acceptanceTracePaths?: string[];
  acceptanceTraceOwned?: boolean;
  acceptanceConsoleErrors?: string[];
  acceptancePageErrors?: string[];
  acceptanceCaptureSequence?: number;
  acceptanceCaptureActive?: boolean;
}
