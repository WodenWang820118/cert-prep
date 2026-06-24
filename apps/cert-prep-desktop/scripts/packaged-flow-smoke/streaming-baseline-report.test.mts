import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildProductionSummary,
  type StreamingBaselineReport,
} from './streaming-baseline-report.mts';
import type { SmokeRunState } from './types.mts';

test('production summary passes when WindowsML OCR is routed to AMD iGPU', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-production-summary-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writeFileSync(
      join(outDir, 'windows-resource-summary.json'),
      JSON.stringify({
        gpu_routing_checks: {
          windowsml_ocr_process_observed: true,
          ocr_uses_amd_igpu: true,
          ocr_avoids_nvidia_dgpu: true,
          reasoning_uses_nvidia_dgpu: true,
          gpu_luid_map_usable: true,
        },
      }),
      'utf8',
    );
    const run = productionRunState(workspaceRoot, outDir);
    const summary = buildProductionSummary(run, productionReport());

    assert.equal(summary.schema_version, 2);
    assert.equal(summary.status, 'passed');
    assert.equal(summary.checks.fastflowlm_health_available, true);
    assert.equal(summary.checks.fastflowlm_selected_configured_model, true);
    assert.equal(summary.checks.fastflowlm_no_fallback, true);
    assert.equal(summary.checks.windowsml_ocr_process_observed, true);
    assert.equal(summary.checks.ocr_uses_amd_igpu, true);
    assert.equal(summary.checks.ocr_avoids_nvidia_dgpu, true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary accepts FastFlowLM NPU reasoning without NVIDIA dGPU usage', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-production-summary-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writeFileSync(
      join(outDir, 'windows-resource-summary.json'),
      JSON.stringify({
        gpu_routing_checks: {
          windowsml_ocr_process_observed: true,
          ocr_uses_amd_igpu: true,
          ocr_avoids_nvidia_dgpu: true,
          reasoning_uses_nvidia_dgpu: false,
          gpu_luid_map_usable: true,
        },
      }),
      'utf8',
    );
    const summary = buildProductionSummary(
      productionRunState(workspaceRoot, outDir),
      productionReport(),
    );

    assert.equal(summary.status, 'passed');
    assert.equal(summary.checks.reasoning_uses_nvidia_dgpu, undefined);
    assert.equal(summary.checks.fastflowlm_health_available, true);
    assert.equal(summary.checks.fastflowlm_selected_configured_model, true);
    assert.equal(summary.checks.fastflowlm_no_fallback, true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary still requires NVIDIA dGPU usage for Ollama reasoning', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-production-summary-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writeFileSync(
      join(outDir, 'windows-resource-summary.json'),
      JSON.stringify({
        gpu_routing_checks: {
          windowsml_ocr_process_observed: true,
          ocr_uses_amd_igpu: true,
          ocr_avoids_nvidia_dgpu: true,
          reasoning_uses_nvidia_dgpu: false,
          gpu_luid_map_usable: true,
        },
      }),
      'utf8',
    );
    const run = productionRunState(workspaceRoot, outDir);
    run.options.llmProvider = 'ollama';
    run.metrics.llm_provider = 'ollama';
    const report = productionReport();
    report.runtime.llm_provider = 'ollama';
    report.runtime.llm_health = {
      provider: 'ollama',
      available: true,
      model: 'qwen3.5:4b',
      configured_model: 'qwen3.5:4b',
      effective_model: 'qwen3.5:4b',
      fallback_models: ['qwen3.5:2b'],
      fallback_reason: null,
      detail: 'model available',
    };

    const summary = buildProductionSummary(run, report);

    assert.equal(summary.status, 'failed');
    assert.equal(summary.checks.reasoning_uses_nvidia_dgpu, false);
    assert.equal(summary.checks.fastflowlm_health_available, undefined);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function productionRunState(
  workspaceRoot: string,
  outDir: string,
): SmokeRunState {
  return {
    options: {
      workspaceRoot,
      outDir,
      exePath: join(workspaceRoot, 'Cert Prep.exe'),
      pdfPath: join(workspaceRoot, 'fixture.pdf'),
      cdpPort: 9222,
      ocrProvider: 'windowsml',
      ocrPageWorkers: 1,
      llmProvider: 'fastflowlm',
      ollamaModel: 'qwen3.5:4b',
      ollamaFallbackModels: ['qwen3.5:2b'],
      waitForStreamingComplete: true,
      streamingCompleteTimeoutMs: 300000,
      skipGpuSampling: false,
      productionSummary: true,
      allowOcrChunkVariance: true,
      verifyStreamingPracticeReady: true,
    },
    metrics: {
      status: 'completed',
      started_at: '2026-06-23T00:00:00.000Z',
      out_dir: outDir,
      screenshots: [],
      ui_timings_ms: {},
      observations: [],
      errors: [],
      llm_provider: 'fastflowlm',
      llm_model: 'qwen3.5:4b',
      llm_effective_model: 'qwen3.5:4b',
      llm_fallback_models: ['qwen3.5:2b'],
      ocr_provider: 'windowsml',
      first_chunk_gate_ms: 15000,
      first_chunk_under_gate: true,
      ocr_completion: {
        pages_processed: 46,
        total_pages: 46,
        chunks: 46,
        expected_pages: 46,
        expected_chunks: 46,
      },
      practice_ready_from_streamed_questions: true,
      streaming_questions: {
        job_snapshots: [],
        question_snapshots: [],
        status_counts: {},
      },
      resource_sampling: {
        windows_summary_json: 'out/windows-resource-summary.json',
      },
    },
    app: null,
    appExit: null,
    nvidia: null,
    resourceSampling: null,
    browser: null,
    page: null,
    port: 9222,
    processBaseline: { all: [], nodePids: new Set() },
    uploadedDocument: null,
    streamingDraftParseStartedAt: null,
    streamingDraftCaptureOpen: false,
    streamingApiPollErrorCaptured: false,
  } as unknown as SmokeRunState;
}

function productionReport(): StreamingBaselineReport {
  return {
    schema_version: 1,
    status: 'passed',
    generated_at: '2026-06-23T00:00:00.000Z',
    git_commit: null,
    artifacts: {
      out_dir: 'out',
      metrics_json: 'out/metrics.json',
      baseline_json: 'out/streaming-baseline.json',
      baseline_markdown: 'out/streaming-baseline.md',
      screenshots: [],
      resource_sampling: {
        windows_summary_json: 'out/windows-resource-summary.json',
      },
    },
    input: {
      pdf_path: 'fixture.pdf',
      pdf_bytes: 1,
      pdf_sha256: 'sha256',
      expected_pages: 46,
      expected_chunks: 46,
    },
    runtime: {
      exe_path: 'Cert Prep.exe',
      app_data_dir: null,
      llm_model: 'qwen3.5:4b',
      llm_configured_model: 'qwen3.5:4b',
      llm_effective_model: 'qwen3.5:4b',
      llm_fallback_models: ['qwen3.5:2b'],
      llm_fallback_reason: null,
      llm_health: {
        provider: 'fastflowlm',
        available: true,
        model: 'qwen3.5:4b',
        configured_model: 'qwen3.5:4b',
        effective_model: 'qwen3.5:4b',
        fallback_models: ['qwen3.5:2b'],
        fallback_reason: null,
        detail: 'model available',
      },
      ocr_provider: 'windowsml',
      llm_provider: 'fastflowlm',
      ocr_page_workers: 1,
      streaming_draft_page_limit: 1,
      streaming_draft_workers: 1,
      streaming_complete_timeout_ms: 300000,
    },
    timings_ms: {},
    ocr_completion: {
      pages_processed: 46,
      total_pages: 46,
      chunks: 46,
    },
    streaming: {
      job_count: 10,
      final_status_counts: { succeeded: 10 },
      completion_state: {
        total_count: 10,
        active_count: 0,
        terminal_count: 10,
        succeeded_count: 10,
        failed_count: 0,
        skipped_count: 0,
        all_terminal: true,
        all_succeeded: true,
      },
      generated_count: 8,
      question_count: 8,
      usable_question_count: 8,
      first_usable_before_parse_complete: true,
      practice_ready_from_streamed_questions: true,
      job_snapshot_count: 1,
      question_snapshot_count: 1,
      blocker: null,
    },
    cleanup: {
      gracefulExited: true,
      fallbackUsed: false,
      exitCode: 0,
      residualProcesses: [],
      nodeClosedCount: 0,
    },
    checks: {
      no_script_errors: true,
      graceful_close: true,
      no_residual_processes: true,
      ocr_completed_46_pages: true,
      ocr_chunks_present: true,
      first_chunk_under_gate: true,
      first_usable_before_parse_complete: true,
      all_jobs_terminal: true,
      all_jobs_succeeded: true,
      generated_equals_usable: true,
      no_streaming_blocker: true,
      streaming_practice_ready: true,
    },
    errors: [],
  };
}
