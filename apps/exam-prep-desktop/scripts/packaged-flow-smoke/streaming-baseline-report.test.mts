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

test('production summary does not fail WindowsML OCR when NPU prepass was not scheduled', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'exam-prep-production-summary-'));
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
    writeFileSync(
      join(outDir, 'xrt-smi-summary.json'),
      JSON.stringify({
        npu_detected: true,
        power_watts_available: true,
      }),
      'utf8',
    );

    const run = productionRunState(workspaceRoot, outDir);
    const summary = buildProductionSummary(run, productionReport());

    assert.equal(summary.schema_version, 2);
    assert.equal(summary.status, 'passed');
    assert.equal(summary.windowsml_npu_prepass_evidence?.available, false);
    assert.equal(
      summary.windowsml_npu_hardware_observation?.scheduling_scope,
      'attempted_not_scheduled',
    );
    assert.equal('windowsml_npu_prepass_evidence' in summary.checks, false);
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
      exePath: join(workspaceRoot, 'Exam Prep.exe'),
      pdfPath: join(workspaceRoot, 'fixture.pdf'),
      cdpPort: 9222,
      ocrProvider: 'windowsml',
      ocrPageWorkers: 1,
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
      windowsml_npu_prepass_evidence: {
        source: 'document_ocr_fallback_reason',
        available: false,
        attempted: true,
        ocr_device: 'amd_windowsml:0',
        fallback_reason:
          'npu_prepass_unavailable=vitisai_events_missing;vitisai_events=0;cpu_events=5',
        vitisai_events: 0,
        cpu_events: 5,
        reason: 'attempted_not_scheduled',
      },
      practice_ready_from_streamed_questions: true,
      streaming_questions: {
        job_snapshots: [],
        question_snapshots: [],
        status_counts: {},
      },
      resource_sampling: {
        windows_summary_json: 'out/windows-resource-summary.json',
        xrt_smi_summary_json: 'out/xrt-smi-summary.json',
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
        xrt_smi_summary_json: 'out/xrt-smi-summary.json',
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
      exe_path: 'Exam Prep.exe',
      app_data_dir: null,
      llm_model: 'qwen3.5:4b',
      llm_configured_model: 'qwen3.5:4b',
      llm_effective_model: 'qwen3.5:4b',
      llm_fallback_models: ['qwen3.5:2b'],
      llm_fallback_reason: null,
      llm_health: {
        provider: 'ollama',
        available: true,
        model: 'qwen3.5:4b',
        configured_model: 'qwen3.5:4b',
        effective_model: 'qwen3.5:4b',
        fallback_models: ['qwen3.5:2b'],
        fallback_reason: null,
        detail: 'model available',
      },
      ocr_provider: 'windowsml',
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
