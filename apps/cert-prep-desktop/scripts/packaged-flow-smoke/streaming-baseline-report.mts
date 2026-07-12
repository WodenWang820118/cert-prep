import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  EXPECTED_BASELINE_CHUNKS,
  EXPECTED_BASELINE_PAGES,
  latestStreamingJobSnapshot,
  latestStreamingQuestionSnapshot,
  refreshFirstChunkGateMetrics,
} from './streaming-capture.mts';
import { streamingJobCompletionState } from './streaming-evidence.mts';
import { isRecord, normalizePath } from './text-utils.mts';
import { videoEvidencePassed } from './video-evidence.mts';
import type { PublicProcessRecord } from '../process-lifecycle/processes.mts';
import type {
  GenerationReadinessSnapshot,
  LlmHealthSnapshot,
  ResourceSamplingArtifacts,
  ResourcesReleasedAtEndSnapshot,
  SmokeRunState,
  StreamingDraftJobAttribution,
  StreamingJobCompletionState,
  VideoArtifact,
} from './types.mts';

export interface StreamingBaselineReport {
  schema_version: 1;
  status: 'passed' | 'failed';
  generated_at: string;
  git_commit: string | null;
  artifacts: {
    out_dir: string;
    metrics_json: string;
    baseline_json: string;
    baseline_markdown: string;
    screenshots: string[];
    video_recordings?: VideoArtifact[];
    gpu_sampling?: string;
    resource_sampling?: ResourceSamplingArtifacts;
  };
  input: {
    pdf_path: string;
    pdf_bytes: number;
    pdf_sha256: string;
    expected_pages: 46;
    expected_chunks: 46;
  };
  runtime: {
    exe_path: string;
    app_data_dir: string | null;
    llm_model: string;
    llm_configured_model: string;
    llm_effective_model: string | null;
    llm_fallback_models: string[];
    llm_fallback_reason: string | null;
    llm_health: LlmHealthSnapshot | null;
    ocr_provider: string;
    ocr_page_workers: number;
    streaming_draft_page_limit: number | null;
    streaming_draft_workers: number | null;
    streaming_complete_timeout_ms: number;
    llm_provider: string;
  };
  timings_ms: Record<string, number | null>;
  ocr_completion: {
    pages_processed: number | null;
    total_pages: number | null;
    chunks: number | null;
  };
  streaming: {
    job_count: number;
    final_status_counts: Record<string, number>;
    completion_state: StreamingJobCompletionState;
    generated_count: number;
    question_count: number;
    usable_question_count: number;
    first_usable_after_parse_complete: boolean;
    practice_ready_from_streamed_questions: boolean;
    job_snapshot_count: number;
    question_snapshot_count: number;
    blocker: string | null;
  };
  cleanup: {
    gracefulExited: boolean | null;
    fallbackUsed: boolean | null;
    exitCode: number | null;
    residualProcesses: PublicProcessRecord[];
    nodeClosedCount: number | null;
  };
  checks: Record<string, boolean>;
  errors: string[];
}

interface GpuRoutingChecks {
  windowsml_ocr_process_observed?: boolean;
  ocr_uses_amd_igpu?: boolean;
  ocr_avoids_nvidia_dgpu?: boolean;
  reasoning_uses_nvidia_dgpu?: boolean;
  gpu_luid_map_usable?: boolean;
  [key: string]: unknown;
}

interface PackagedStreamingProductionSummary {
  schema_version: 3;
  status: 'incomplete' | 'passed' | 'failed';
  generated_at: string;
  selected_model: string | null;
  configured_model: string | null;
  effective_model: string | null;
  fallback_models: string[];
  fallback_reason: string | null;
  llm_health: LlmHealthSnapshot | null;
  llm_provider: string | null;
  provider_preference: string;
  configured_provider: string | null;
  generation_ready_at_start: GenerationReadinessSnapshot | null;
  succeeded_jobs: StreamingDraftJobAttribution[];
  producing_jobs: StreamingDraftJobAttribution[];
  resources_released_at_end: ResourcesReleasedAtEndSnapshot | null;
  full_exam_question_count: number | null;
  artifacts: {
    production_summary_json: string;
    baseline_json: string;
    baseline_markdown: string;
    metrics_json: string;
    video_recordings?: VideoArtifact[];
    resource_sampling?: ResourceSamplingArtifacts;
  };
  timings_ms: StreamingBaselineReport['timings_ms'];
  ocr_completion: StreamingBaselineReport['ocr_completion'];
  streaming: StreamingBaselineReport['streaming'];
  gpu_routing_checks: GpuRoutingChecks | null;
  checks: Record<string, boolean>;
  errors: string[];
}

export function writeStreamingBaselineArtifacts(
  run: SmokeRunState,
  {
    finalized,
    recordFailure = true,
  }: {
    readonly finalized: boolean;
    readonly recordFailure?: boolean;
  },
): void {
  if (!run.options.waitForStreamingComplete) {
    return;
  }

  let report = buildStreamingBaselineReport(run);
  let productionSummary = run.options.productionSummary
    ? buildProductionSummary(run, report, { finalized })
    : null;
  if (
    report.status === 'failed' &&
    finalized &&
    recordFailure &&
    productionSummary?.status !== 'passed'
  ) {
    run.metrics.errors.push('Streaming baseline checks failed.');
    report = buildStreamingBaselineReport(run);
    productionSummary = run.options.productionSummary
      ? buildProductionSummary(run, report, { finalized })
      : null;
  }
  if (
    productionSummary?.status === 'failed' &&
    finalized &&
    recordFailure
  ) {
    run.metrics.errors.push('Packaged streaming production checks failed.');
    report = buildStreamingBaselineReport(run);
    productionSummary = buildProductionSummary(run, report, { finalized });
  }
  const jsonPath = join(run.options.outDir, 'streaming-baseline.json');
  const markdownPath = join(run.options.outDir, 'streaming-baseline.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderStreamingBaselineMarkdown(report));
  run.metrics.streaming_baseline = {
    status: report.status,
    json: normalizePath(relative(run.options.workspaceRoot, jsonPath)),
    markdown: normalizePath(relative(run.options.workspaceRoot, markdownPath)),
  };
  if (run.options.productionSummary) {
    productionSummary ??= buildProductionSummary(run, report, { finalized });
    const productionSummaryPath = join(run.options.outDir, 'production-summary.json');
    writeFileSync(
      productionSummaryPath,
      `${JSON.stringify(productionSummary, null, 2)}\n`,
    );
    run.metrics.production_summary = normalizePath(
      relative(run.options.workspaceRoot, productionSummaryPath),
    );
  }
}

export function buildStreamingBaselineReport(
  run: SmokeRunState,
): StreamingBaselineReport {
  const latestJob = latestStreamingJobSnapshot(run);
  const latestQuestion = latestStreamingQuestionSnapshot(run);
  const finalStatusCounts = latestJob?.status_counts ?? {};
  const completionState = streamingJobCompletionState(finalStatusCounts);
  refreshFirstChunkGateMetrics(run);
  const timings = run.metrics.ui_timings_ms;
  const firstUsable =
    run.metrics.streaming_questions.first_usable_question_visible_ms;
  const parseComplete = timings.parse_complete_visible;
  const firstUsableAfterParseComplete =
    firstUsable !== undefined &&
    parseComplete !== undefined &&
    firstUsable >= parseComplete;
  const chunksAccepted = acceptedOcrChunkCount(run);
  const checks = {
    no_script_errors: run.metrics.errors.length === 0,
    graceful_close: run.metrics.final_close?.gracefulExited === true,
    no_residual_processes:
      run.metrics.final_close !== undefined &&
      run.metrics.process_cleanup !== undefined &&
      run.metrics.final_close.residualProcesses.length === 0 &&
      run.metrics.process_cleanup.residue_after_close.length === 0,
    ocr_completed_46_pages:
      run.metrics.ocr_completion?.pages_processed === EXPECTED_BASELINE_PAGES &&
      run.metrics.ocr_completion?.total_pages === EXPECTED_BASELINE_PAGES,
    ...(run.options.allowOcrChunkVariance
      ? { ocr_chunks_present: chunksAccepted }
      : { ocr_completed_46_chunks: chunksAccepted }),
    first_chunk_under_gate: run.metrics.first_chunk_under_gate,
    first_usable_after_parse_complete: firstUsableAfterParseComplete,
    all_jobs_terminal: completionState.all_terminal,
    all_jobs_succeeded: completionState.all_succeeded,
    generated_equals_usable:
      (latestJob?.generated_count ?? 0) > 0 &&
      latestJob?.generated_count === latestQuestion?.usable_question_count,
    no_streaming_blocker: !run.metrics.streaming_questions.blocker,
    ...(run.options.verifyStreamingPracticeReady
      ? {
          streaming_practice_ready:
            run.metrics.practice_ready_from_streamed_questions === true,
        }
      : {}),
    ...(run.options.recordVideo
      ? { video_recording_completed: videoEvidencePassed(run) }
      : {}),
  };
  const status = Object.values(checks).every(Boolean) ? 'passed' : 'failed';
  const metricsPath = join(run.options.outDir, 'metrics.json');
  const baselineJsonPath = join(run.options.outDir, 'streaming-baseline.json');
  const baselineMarkdownPath = join(run.options.outDir, 'streaming-baseline.md');

  return {
    schema_version: 1,
    status,
    generated_at: new Date().toISOString(),
    git_commit: currentGitCommit(run),
    artifacts: {
      out_dir: normalizePath(relative(run.options.workspaceRoot, run.options.outDir)),
      metrics_json: normalizePath(relative(run.options.workspaceRoot, metricsPath)),
      baseline_json: normalizePath(
        relative(run.options.workspaceRoot, baselineJsonPath),
      ),
      baseline_markdown: normalizePath(
        relative(run.options.workspaceRoot, baselineMarkdownPath),
      ),
      screenshots: run.metrics.screenshots,
      ...(run.metrics.video_artifacts?.length
        ? { video_recordings: run.metrics.video_artifacts }
        : {}),
      ...(run.metrics.gpu_sampling ? { gpu_sampling: run.metrics.gpu_sampling } : {}),
      ...(run.metrics.resource_sampling
        ? { resource_sampling: run.metrics.resource_sampling }
        : {}),
    },
    input: {
      pdf_path: normalizePath(relative(run.options.workspaceRoot, run.options.pdfPath)),
      pdf_bytes: statSync(run.options.pdfPath).size,
      pdf_sha256: sha256File(run.options.pdfPath),
      expected_pages: EXPECTED_BASELINE_PAGES,
      expected_chunks: EXPECTED_BASELINE_CHUNKS,
    },
    runtime: {
      exe_path: normalizePath(relative(run.options.workspaceRoot, run.options.exePath)),
      app_data_dir: run.options.appDataDir
        ? normalizePath(relative(run.options.workspaceRoot, run.options.appDataDir))
        : null,
      llm_provider: run.options.llmProvider,
      llm_model: run.options.ollamaModel,
      llm_configured_model:
        run.metrics.llm_configured_model ?? run.options.ollamaModel,
      llm_effective_model: run.metrics.llm_effective_model ?? null,
      llm_fallback_models:
        run.metrics.llm_fallback_models ?? run.options.ollamaFallbackModels,
      llm_fallback_reason: run.metrics.llm_fallback_reason ?? null,
      llm_health: run.metrics.llm_health ?? null,
      ocr_provider: run.options.ocrProvider,
      ocr_page_workers: run.options.ocrPageWorkers,
      streaming_draft_page_limit: run.options.streamingDraftPageLimit ?? null,
      streaming_draft_workers: run.options.streamingDraftWorkers ?? null,
      streaming_complete_timeout_ms: run.options.streamingCompleteTimeoutMs,
    },
    timings_ms: {
      upload_to_processing_visible: timings.upload_to_processing_visible ?? null,
      first_chunk_gate_ms: run.metrics.first_chunk_gate_ms,
      first_chunk_visible: timings.first_chunk_visible ?? null,
      streaming_question_status_visible:
        timings.streaming_question_status_visible ?? null,
      first_streamed_question_visible:
        run.metrics.streaming_questions.first_question_visible_ms ?? null,
      first_usable_question_visible: firstUsable ?? null,
      parse_complete_visible: parseComplete ?? null,
      streaming_all_jobs_terminal:
        run.metrics.streaming_questions.all_jobs_terminal_ms ?? null,
      practice_ready_visible_ms: timings.practice_ready_visible_ms ?? null,
      practice_first_question_visible_ms:
        timings.practice_first_question_visible_ms ?? null,
    },
    ocr_completion: {
      pages_processed: run.metrics.ocr_completion?.pages_processed ?? null,
      total_pages: run.metrics.ocr_completion?.total_pages ?? null,
      chunks: run.metrics.ocr_completion?.chunks ?? null,
    },
    streaming: {
      job_count: latestJob?.item_count ?? 0,
      final_status_counts: finalStatusCounts,
      completion_state: completionState,
      generated_count: latestJob?.generated_count ?? 0,
      question_count: latestQuestion?.item_count ?? 0,
      usable_question_count: latestQuestion?.usable_question_count ?? 0,
      first_usable_after_parse_complete: firstUsableAfterParseComplete,
      practice_ready_from_streamed_questions:
        run.metrics.practice_ready_from_streamed_questions === true,
      job_snapshot_count: run.metrics.streaming_questions.job_snapshots.length,
      question_snapshot_count:
        run.metrics.streaming_questions.question_snapshots.length,
      blocker: run.metrics.streaming_questions.blocker ?? null,
    },
    cleanup: {
      gracefulExited: run.metrics.final_close?.gracefulExited ?? null,
      fallbackUsed: run.metrics.final_close?.fallbackUsed ?? null,
      exitCode: run.metrics.final_close?.exitCode ?? null,
      residualProcesses:
        run.metrics.final_close?.residualProcesses ??
        run.metrics.process_cleanup?.residue_after_close ??
        [],
      nodeClosedCount:
        run.metrics.process_cleanup?.node_cleanup_summary.closed_count ?? null,
    },
    checks,
    errors: run.metrics.errors,
  };
}

export function buildProductionSummary(
  run: SmokeRunState,
  report: StreamingBaselineReport,
  { finalized = true }: { readonly finalized?: boolean } = {},
): PackagedStreamingProductionSummary {
  const resourceSummary = readResourceSummary(run);
  const gpuRoutingChecks = readGpuRoutingChecks(resourceSummary);
  const finalJobs = latestStreamingJobSnapshot(run)?.jobs ?? [];
  const succeededJobs = finalJobs.filter((job) => job.status === 'succeeded');
  const producingJobs = succeededJobs.filter((job) => job.generated_count > 0);
  const configuredProvider = uniqueCompleteValue(
    succeededJobs.map((job) => job.configured_provider),
  );
  const configuredModel = uniqueCompleteValue(
    succeededJobs.map((job) => job.configured_model),
  );
  const effectiveProvider = uniqueCompleteValue(
    succeededJobs.map((job) => job.effective_provider),
  );
  const effectiveModel = uniqueCompleteValue(
    succeededJobs.map((job) => job.effective_model),
  );
  const fallbackReason = uniqueFallbackReason(succeededJobs);
  const llmHealth = run.metrics.llm_health ?? report.runtime.llm_health;
  const exactFastFlowLmJobs =
    succeededJobs.length > 0 &&
    succeededJobs.every(
      (job) =>
        job.attribution_complete &&
        job.configured_provider === 'fastflowlm' &&
        job.configured_model === 'qwen3.5:4b' &&
        job.effective_provider === 'fastflowlm' &&
        job.effective_model === 'qwen3.5:4b' &&
        job.fallback_reason === null,
  );
  const resourcesReleased = run.metrics.resources_released_at_end;
  const readinessAtStart = run.metrics.generation_readiness_at_start;
  const checks: Record<string, boolean> = {
    cleanup_finalized: finalized,
    smoke_completed: run.metrics.status === 'completed',
    no_script_errors: run.metrics.errors.length === 0,
    streaming_baseline_passed: report.status === 'passed',
    graceful_close: report.checks.graceful_close === true,
    no_residual_processes: report.checks.no_residual_processes === true,
    generation_ready_at_start: generationReadinessPassed(
      readinessAtStart,
      effectiveProvider,
      effectiveModel,
      report.runtime.llm_provider,
    ),
    final_job_evidence_complete:
      finalJobs.length === report.streaming.job_count &&
      finalJobs.length === report.streaming.completion_state.total_count &&
      finalJobs.every((job) => job.status !== null) &&
      succeededJobs.length ===
        report.streaming.completion_state.succeeded_count,
    succeeded_job_attribution_complete:
      succeededJobs.length > 0 &&
      succeededJobs.every((job) => job.attribution_complete),
    producing_job_attribution_present: producingJobs.length > 0,
    producing_job_attribution_complete:
      producingJobs.length > 0 &&
      producingJobs.every((job) => job.attribution_complete),
    producing_job_provider_consistent:
      configuredProvider !== null &&
      configuredProvider === effectiveProvider,
    resources_released_at_end: resourcesReleasedPassed(
      resourcesReleased,
      effectiveProvider,
    ),
    full_exam_questions_present:
      (run.metrics.full_exam_question_count ?? 0) > 0,
    ocr_completed_expected_pages:
      report.ocr_completion.pages_processed === EXPECTED_BASELINE_PAGES &&
      report.ocr_completion.total_pages === EXPECTED_BASELINE_PAGES,
    ocr_chunks_present: acceptedOcrChunkCount(run),
    ...(effectiveProvider === 'fastflowlm'
      ? {
          fastflowlm_exact_job_attribution: exactFastFlowLmJobs,
          fastflowlm_no_job_fallback:
            succeededJobs.length > 0 &&
            succeededJobs.every((job) => job.fallback_reason === null),
          provider_preference_auto: report.runtime.llm_provider === 'auto',
        }
      : effectiveProvider === 'ollama'
        ? {
          reasoning_uses_nvidia_dgpu: routingBoolean(
            gpuRoutingChecks,
            'reasoning_uses_nvidia_dgpu',
          ),
          }
        : { supported_effective_provider: false }),
    streaming_jobs_succeeded: report.streaming.completion_state.all_succeeded,
    selected_model_produced_usable_questions:
      effectiveModel !== null && report.streaming.usable_question_count > 0,
    streaming_practice_ready:
      report.streaming.practice_ready_from_streamed_questions,
    ...(run.options.recordVideo
      ? { video_recording_completed: videoEvidencePassed(run) }
      : {}),
  };
  Object.assign(checks, providerRoutingChecks(run, gpuRoutingChecks));
  const productionSummaryPath = join(run.options.outDir, 'production-summary.json');
  const checksPassed = Object.values(checks).every(Boolean);

  return {
    schema_version: 3,
    status: finalized ? (checksPassed ? 'passed' : 'failed') : 'incomplete',
    generated_at: report.generated_at,
    selected_model: effectiveModel,
    llm_provider: effectiveProvider,
    provider_preference: report.runtime.llm_provider,
    configured_provider: configuredProvider,
    configured_model: configuredModel,
    effective_model: effectiveModel,
    fallback_models:
      run.metrics.llm_fallback_models ?? report.runtime.llm_fallback_models,
    fallback_reason: fallbackReason,
    llm_health: llmHealth,
    generation_ready_at_start: readinessAtStart ?? null,
    succeeded_jobs: succeededJobs,
    producing_jobs: producingJobs,
    resources_released_at_end: resourcesReleased ?? null,
    full_exam_question_count: run.metrics.full_exam_question_count ?? null,
    artifacts: {
      production_summary_json: normalizePath(
        relative(run.options.workspaceRoot, productionSummaryPath),
      ),
      baseline_json: report.artifacts.baseline_json,
      baseline_markdown: report.artifacts.baseline_markdown,
      metrics_json: report.artifacts.metrics_json,
      ...(report.artifacts.video_recordings?.length
        ? { video_recordings: report.artifacts.video_recordings }
        : {}),
      ...(report.artifacts.resource_sampling
        ? { resource_sampling: report.artifacts.resource_sampling }
        : {}),
    },
    timings_ms: report.timings_ms,
    ocr_completion: report.ocr_completion,
    streaming: report.streaming,
    gpu_routing_checks: gpuRoutingChecks,
    checks,
    errors: run.metrics.errors,
  };
}

function uniqueCompleteValue(values: readonly (string | null)[]): string | null {
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  const unique = new Set(values);
  return unique.size === 1 ? (values[0] ?? null) : null;
}

function uniqueFallbackReason(
  jobs: readonly StreamingDraftJobAttribution[],
): string | null {
  if (jobs.length === 0 || jobs.every((job) => job.fallback_reason === null)) {
    return null;
  }
  const reasons = jobs.map((job) => job.fallback_reason);
  return uniqueCompleteValue(reasons);
}

function generationReadinessPassed(
  snapshot: GenerationReadinessSnapshot | undefined,
  effectiveProvider: string | null,
  effectiveModel: string | null,
  providerPreference: string,
): boolean {
  if (
    snapshot?.ready !== true ||
    snapshot.blockers.length > 0 ||
    snapshot.provider_selection === null ||
    effectiveProvider === null ||
    effectiveModel === null
  ) {
    return false;
  }
  const selection = snapshot.provider_selection;
  if (
    selection.preference !== providerPreference ||
    selection.selected_provider !== effectiveProvider ||
    selection.effective_provider !== effectiveProvider ||
    selection.configured_model !== effectiveModel ||
    selection.effective_model !== effectiveModel
  ) {
    return false;
  }

  if (effectiveProvider === 'fastflowlm') {
    return (
      selection.hardware_compatible === true &&
      selection.requires_terms_acceptance === true &&
      selection.terms_accepted === true &&
      selection.terms_version === '0.9.43' &&
      selection.fallback_reason === null &&
      selection.runtime_requirement_kind === 'fastflowlm' &&
      selection.model_requirement_kind === 'fastflowlm_model' &&
      runtimeRequirementAvailable(
        snapshot,
        'fastflowlm',
        '0.9.43',
        true,
      ) &&
      runtimeRequirementAvailable(
        snapshot,
        'fastflowlm_model',
        effectiveModel,
        false,
      )
    );
  }

  return (
    effectiveProvider === 'ollama' &&
    runtimeRequirementAvailable(snapshot, 'ollama', null, true) &&
    runtimeRequirementAvailable(snapshot, 'ollama_model', effectiveModel, false)
  );
}

function runtimeRequirementAvailable(
  snapshot: GenerationReadinessSnapshot,
  kind: string,
  version: string | null,
  requireInstalledPath: boolean,
): boolean {
  return snapshot.runtime_requirements.some(
    (requirement) =>
      requirement.kind === kind &&
      requirement.available === true &&
      (version === null || requirement.version === version) &&
      (!requireInstalledPath || requirement.installed_path_verified),
  );
}

function resourcesReleasedPassed(
  snapshot: ResourcesReleasedAtEndSnapshot | undefined,
  effectiveProvider: string | null,
): boolean {
  if (
    snapshot?.released !== true ||
    snapshot.stable_empty_snapshots < 2 ||
    snapshot.observed_owned_processes.length === 0 ||
    snapshot.alive_owned_processes.length > 0
  ) {
    return false;
  }
  return (
    effectiveProvider !== 'fastflowlm' ||
    snapshot.observed_owned_processes.some(
      (process) => process.name.toLowerCase() === 'flm.exe',
    )
  );
}

function providerRoutingChecks(
  run: SmokeRunState,
  gpuRoutingChecks: GpuRoutingChecks | null,
): Record<string, boolean> {
  if (run.options.ocrProvider === 'windowsml') {
    return {
      windowsml_ocr_process_observed: routingBoolean(
        gpuRoutingChecks,
        'windowsml_ocr_process_observed',
      ),
      ocr_uses_amd_igpu: routingBoolean(gpuRoutingChecks, 'ocr_uses_amd_igpu'),
      ocr_avoids_nvidia_dgpu: routingBoolean(
        gpuRoutingChecks,
        'ocr_avoids_nvidia_dgpu',
      ),
    };
  }
  return {};
}

function renderStreamingBaselineMarkdown(report: StreamingBaselineReport): string {
  return `# Packaged Streaming Baseline

- Status: ${report.status}
- Generated: ${report.generated_at}
- Git commit: ${report.git_commit ?? 'unknown'}
- Model: ${renderModelMarkdown(report)}
- PDF: ${report.input.pdf_path} (${report.input.pdf_bytes} bytes)
- OCR: ${report.ocr_completion.pages_processed}/${report.ocr_completion.total_pages} pages, ${report.ocr_completion.chunks} chunks
- First chunk visible: ${formatMaybeMs(report.timings_ms.first_chunk_visible)} (gate: ${formatMaybeMs(report.timings_ms.first_chunk_gate_ms)}, under gate: ${String(report.checks.first_chunk_under_gate)})
- First usable qwen question: ${formatMaybeMs(report.timings_ms.first_usable_question_visible)}
- Parse complete: ${formatMaybeMs(report.timings_ms.parse_complete_visible)}
- All streaming jobs terminal: ${formatMaybeMs(report.timings_ms.streaming_all_jobs_terminal)}
- Practice ready from streamed questions: ${String(report.streaming.practice_ready_from_streamed_questions)}
- Practice first question: ${formatMaybeMs(report.timings_ms.practice_first_question_visible_ms)}
- Jobs: ${report.streaming.job_count}, generated: ${report.streaming.generated_count}, usable questions: ${report.streaming.usable_question_count}
- Final job statuses: ${JSON.stringify(report.streaming.final_status_counts)}
- Graceful close: ${String(report.cleanup.gracefulExited)}, fallback used: ${String(report.cleanup.fallbackUsed)}, residual processes: ${report.cleanup.residualProcesses.length}

Artifacts:

- Metrics: ${report.artifacts.metrics_json}
- Baseline JSON: ${report.artifacts.baseline_json}
- Screenshots: ${report.artifacts.screenshots.length}
- Video recordings: ${report.artifacts.video_recordings?.length ?? 0}
${renderResourceSamplingMarkdown(report.artifacts.resource_sampling)}
`;
}

function renderModelMarkdown(report: StreamingBaselineReport): string {
  const configured = report.runtime.llm_configured_model;
  if (report.runtime.llm_health?.available === false) {
    return `${configured} (unavailable: ${report.runtime.llm_health.detail ?? 'provider unavailable'})`;
  }
  const effective = report.runtime.llm_effective_model ?? configured;
  if (effective !== configured) {
    return `${effective} (configured: ${configured}, fallback: ${report.runtime.llm_fallback_reason ?? 'active'})`;
  }
  return configured;
}

function readResourceSummary(run: SmokeRunState): Record<string, unknown> | null {
  const summaryPath = run.metrics.resource_sampling?.windows_summary_json;
  if (!summaryPath) {
    return null;
  }

  const absolutePath = join(run.options.workspaceRoot, summaryPath);
  if (!existsSync(absolutePath)) {
    return null;
  }

  try {
    const payload = JSON.parse(readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, ''));
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function readGpuRoutingChecks(
  resourceSummary: Record<string, unknown> | null,
): GpuRoutingChecks | null {
  const payload = recordField(resourceSummary, 'gpu_routing_checks');
  return payload === null ? null : (payload as GpuRoutingChecks);
}

function routingBoolean(
  checks: GpuRoutingChecks | null,
  key: keyof GpuRoutingChecks,
): boolean {
  return checks?.[key] === true;
}

function recordField(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const value = record?.[key];
  return isRecord(value) ? value : null;
}

function acceptedOcrChunkCount(run: SmokeRunState): boolean {
  const chunks = run.metrics.ocr_completion?.chunks;
  if (chunks === EXPECTED_BASELINE_CHUNKS) {
    return true;
  }
  return (
    run.options.allowOcrChunkVariance &&
    chunks !== null &&
    chunks !== undefined &&
    chunks > 0 &&
    chunks <= EXPECTED_BASELINE_CHUNKS
  );
}

function formatMaybeMs(value: number | null): string {
  return value === null ? 'n/a' : `${value} ms`;
}

function renderResourceSamplingMarkdown(
  artifacts: ResourceSamplingArtifacts | undefined,
): string {
  if (!artifacts) {
    return '';
  }
  const paths = [
    artifacts.nvidia_smi_csv,
    artifacts.windows_counters_csv,
    artifacts.windows_summary_json,
  ].filter((path): path is string => Boolean(path));
  if (paths.length === 0) {
    return '';
  }
  return `- Resource sampling: ${paths.join(', ')}`;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function currentGitCommit(run: SmokeRunState): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: run.options.workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
