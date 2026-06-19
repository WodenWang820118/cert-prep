import type { Browser, Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';

export interface SmokeOptions {
  workspaceRoot: string;
  exePath: string;
  pdfPath: string;
  outDir: string;
  cdpPort: number;
  ocrPageWorkers: number;
  ollamaModel: string;
  streamingDraftPageLimit?: number;
  streamingDraftWorkers?: number;
  skipGpuSampling: boolean;
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
  approved_answer?: string;
  wrong_answer?: string;
  llm_model: string;
  streaming_draft_page_limit?: number;
  streaming_draft_workers?: number;
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
  streaming_drafts: StreamingDraftsMetrics;
  gpu_sampling?: string;
}

export interface StreamingDraftsMetrics {
  job_snapshots: StreamingDraftJobSnapshot[];
  draft_snapshots: StreamingQuestionDraftSnapshot[];
  status_counts: Record<string, number>;
  first_job_visible_ms?: number;
  first_status_visible_ms?: number;
  first_draft_visible_ms?: number;
  first_usable_question_visible_ms?: number;
  blocker?: string;
}

export interface StreamingDraftJobSnapshot {
  elapsed_ms: number;
  source: 'draft-jobs';
  item_count: number;
  status_counts: Record<string, number>;
  generated_count: number;
  blocker?: string;
}

export interface StreamingQuestionDraftSnapshot {
  elapsed_ms: number;
  source: 'question-drafts';
  item_count: number;
  usable_count: number;
}

export interface UploadedDocumentRef {
  apiBaseUrl: string;
  authorization: string | null;
  projectId: string;
  documentId: string;
}

export interface BackendRuntimeManifest {
  kind: string;
  version: string;
  target: string;
  entrypoint: string;
  artifact: {
    file_name: string;
    sha256: string;
    bytes: number;
    url?: string | null;
  };
}

export interface ProcessRecord {
  pid: number;
  parentPid: number;
  name: string;
  executablePath: string;
  commandLine: string;
}

export interface PublicProcessRecord {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
}

export interface ProcessSnapshot {
  all: ProcessRecord[];
  nodePids: Set<number>;
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

export interface SelectNodeHelpersOptions {
  beforeNodePids: ReadonlySet<number>;
  after: readonly ProcessRecord[];
  ownerPid: number;
  workspaceRoot: string;
  runMarker: string;
}

export interface SmokeRunState {
  options: SmokeOptions;
  metrics: SmokeMetrics;
  app: ChildProcess | null;
  appExit: ChildExitState | null;
  nvidia: ChildProcess | null;
  browser: Browser | null;
  page: Page | null;
  port: number;
  processBaseline: ProcessSnapshot;
  streamingDraftParseStartedAt: number | null;
  streamingDraftCaptureOpen: boolean;
  streamingApiPollErrorCaptured: boolean;
}
