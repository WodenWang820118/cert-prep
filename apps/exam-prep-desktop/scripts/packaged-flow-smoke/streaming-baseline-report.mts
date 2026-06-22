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
import type {
  LlmHealthSnapshot,
  PublicProcessRecord,
  ResourceSamplingArtifacts,
  SmokeRunState,
  StreamingJobCompletionState,
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
    first_usable_before_parse_complete: boolean;
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
  directml_ocr_process_observed?: boolean;
  ocr_uses_amd_igpu?: boolean;
  ocr_avoids_nvidia_dgpu?: boolean;
  reasoning_uses_nvidia_dgpu?: boolean;
  gpu_luid_map_usable?: boolean;
  [key: string]: unknown;
}

interface PackagedStreamingProductionSummary {
  schema_version: 1;
  status: 'passed' | 'failed';
  generated_at: string;
  selected_model: string | null;
  configured_model: string;
  effective_model: string | null;
  fallback_models: string[];
  fallback_reason: string | null;
  llm_health: LlmHealthSnapshot | null;
  artifacts: {
    production_summary_json: string;
    baseline_json: string;
    baseline_markdown: string;
    metrics_json: string;
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
    recordFailure = true,
  }: {
    readonly recordFailure?: boolean;
  } = {},
): void {
  if (!run.options.waitForStreamingComplete) {
    return;
  }

  let report = buildStreamingBaselineReport(run);
  let productionSummary = run.options.productionSummary
    ? buildProductionSummary(run, report)
    : null;
  if (
    report.status === 'failed' &&
    recordFailure &&
    productionSummary?.status !== 'passed'
  ) {
    run.metrics.errors.push('Streaming baseline checks failed.');
    report = buildStreamingBaselineReport(run);
    productionSummary = run.options.productionSummary
      ? buildProductionSummary(run, report)
      : null;
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
    productionSummary ??= buildProductionSummary(run, report);
    if (productionSummary.status === 'failed' && recordFailure) {
      run.metrics.errors.push('Packaged streaming production checks failed.');
      report = buildStreamingBaselineReport(run);
      productionSummary = buildProductionSummary(run, report);
    }
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

function buildStreamingBaselineReport(run: SmokeRunState): StreamingBaselineReport {
  const latestJob = latestStreamingJobSnapshot(run);
  const latestQuestion = latestStreamingQuestionSnapshot(run);
  const finalStatusCounts = latestJob?.status_counts ?? {};
  const completionState = streamingJobCompletionState(finalStatusCounts);
  refreshFirstChunkGateMetrics(run);
  const timings = run.metrics.ui_timings_ms;
  const firstUsable =
    run.metrics.streaming_questions.first_usable_question_visible_ms;
  const parseComplete = timings.parse_complete_visible;
  const firstUsableBeforeParseComplete =
    firstUsable !== undefined &&
    parseComplete !== undefined &&
    firstUsable < parseComplete;
  const chunksAccepted = acceptedOcrChunkCount(run);
  const checks = {
    no_script_errors: run.metrics.errors.length === 0,
    graceful_close: run.metrics.final_close?.gracefulExited === true,
    no_residual_processes:
      (run.metrics.final_close?.residualProcesses.length ?? 0) === 0 &&
      (run.metrics.process_cleanup?.residue_after_close.length ?? 0) === 0,
    ocr_completed_46_pages:
      run.metrics.ocr_completion?.pages_processed === EXPECTED_BASELINE_PAGES &&
      run.metrics.ocr_completion?.total_pages === EXPECTED_BASELINE_PAGES,
    ...(run.options.allowOcrChunkVariance
      ? { ocr_chunks_present: chunksAccepted }
      : { ocr_completed_46_chunks: chunksAccepted }),
    first_chunk_under_gate: run.metrics.first_chunk_under_gate,
    first_usable_before_parse_complete: firstUsableBeforeParseComplete,
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
      first_usable_before_parse_complete: firstUsableBeforeParseComplete,
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

function buildProductionSummary(
  run: SmokeRunState,
  report: StreamingBaselineReport,
): PackagedStreamingProductionSummary {
  const gpuRoutingChecks = readGpuRoutingChecks(run);
  const configuredModel =
    run.metrics.llm_configured_model ?? report.runtime.llm_configured_model;
  const effectiveModel =
    run.metrics.llm_effective_model ?? report.runtime.llm_effective_model;
  const selectedModel = effectiveModel;
  const checks = {
    no_script_errors: run.metrics.errors.length === 0,
    ocr_completed_expected_pages:
      report.ocr_completion.pages_processed === EXPECTED_BASELINE_PAGES &&
      report.ocr_completion.total_pages === EXPECTED_BASELINE_PAGES,
    ocr_chunks_present: acceptedOcrChunkCount(run),
    directml_ocr_process_observed: routingBoolean(
      gpuRoutingChecks,
      'directml_ocr_process_observed',
    ),
    ocr_uses_amd_igpu: routingBoolean(gpuRoutingChecks, 'ocr_uses_amd_igpu'),
    ocr_avoids_nvidia_dgpu: routingBoolean(
      gpuRoutingChecks,
      'ocr_avoids_nvidia_dgpu',
    ),
    reasoning_uses_nvidia_dgpu: routingBoolean(
      gpuRoutingChecks,
      'reasoning_uses_nvidia_dgpu',
    ),
    streaming_jobs_succeeded: report.streaming.completion_state.all_succeeded,
    selected_model_produced_usable_questions:
      selectedModel !== null && report.streaming.usable_question_count > 0,
    streaming_practice_ready:
      report.streaming.practice_ready_from_streamed_questions,
  };
  const productionSummaryPath = join(run.options.outDir, 'production-summary.json');

  return {
    schema_version: 1,
    status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
    generated_at: report.generated_at,
    selected_model: selectedModel,
    configured_model: configuredModel,
    effective_model: effectiveModel,
    fallback_models:
      run.metrics.llm_fallback_models ?? report.runtime.llm_fallback_models,
    fallback_reason:
      run.metrics.llm_fallback_reason ?? report.runtime.llm_fallback_reason,
    llm_health: run.metrics.llm_health ?? report.runtime.llm_health,
    artifacts: {
      production_summary_json: normalizePath(
        relative(run.options.workspaceRoot, productionSummaryPath),
      ),
      baseline_json: report.artifacts.baseline_json,
      baseline_markdown: report.artifacts.baseline_markdown,
      metrics_json: report.artifacts.metrics_json,
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

function readGpuRoutingChecks(run: SmokeRunState): GpuRoutingChecks | null {
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
    if (!isRecord(payload) || !isRecord(payload.gpu_routing_checks)) {
      return null;
    }
    return payload.gpu_routing_checks as GpuRoutingChecks;
  } catch {
    return null;
  }
}

function routingBoolean(
  checks: GpuRoutingChecks | null,
  key: keyof GpuRoutingChecks,
): boolean {
  return checks?.[key] === true;
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
