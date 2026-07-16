import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildProductionSummary,
  buildStreamingBaselineReport,
  writeStreamingBaselineArtifacts,
} from './streaming-baseline-report.mts';
import type { SmokeRunState } from './types.mts';

test('Ollama-only production summary binds readiness to exact job attribution', () => {
  const fixture = productionFixture();
  try {
    const report = buildStreamingBaselineReport(fixture.run);
    const summary = buildProductionSummary(fixture.run, report);

    assert.equal(report.status, 'passed');
    assert.equal(summary.schema_version, 5);
    assert.equal(summary.status, 'passed');
    assert.equal(summary.provider_policy, 'ollama-only-alpha');
    assert.equal(summary.provider_preference, 'ollama');
    assert.equal(summary.llm_provider, 'ollama');
    assert.equal(summary.checks.ollama_provider_exact, true);
    assert.equal(summary.checks.provider_no_fallback, true);
    assert.equal(summary.checks.generation_ready_at_start, true);
    assert.equal(summary.checks.resources_released_at_end, true);
    assert.equal(summary.checks.acceptance_fresh_run_isolation, true);
    assert.equal(summary.checks.windowsml_ocr_process_observed, true);
    assert.equal(summary.checks.reasoning_uses_nvidia_dgpu, true);
  } finally {
    fixture.cleanup();
  }
});

test('Ollama-only production summary fails closed without NVIDIA reasoning evidence', () => {
  const fixture = productionFixture();
  try {
    writeFileSync(
      join(fixture.outDir, 'windows-resource-summary.json'),
      JSON.stringify({
        gpu_routing_checks: {
          windowsml_ocr_process_observed: true,
          ocr_uses_amd_igpu: true,
          ocr_avoids_nvidia_dgpu: true,
          reasoning_uses_nvidia_dgpu: false,
          gpu_luid_map_usable: true,
        },
      }),
    );

    const summary = buildProductionSummary(
      fixture.run,
      buildStreamingBaselineReport(fixture.run),
    );

    assert.equal(summary.status, 'failed');
    assert.equal(summary.checks.windowsml_ocr_process_observed, true);
    assert.equal(summary.checks.ocr_uses_amd_igpu, true);
    assert.equal(summary.checks.ocr_avoids_nvidia_dgpu, true);
    assert.equal(summary.checks.reasoning_uses_nvidia_dgpu, false);
  } finally {
    fixture.cleanup();
  }
});

test('production summary rejects a non-Ollama effective provider', () => {
  const fixture = productionFixture();
  try {
    const job =
      fixture.run.metrics.streaming_questions.job_snapshots[0]?.jobs[0];
    assert.ok(job);
    job.configured_provider = 'fake';
    job.effective_provider = 'fake';

    const summary = buildProductionSummary(
      fixture.run,
      buildStreamingBaselineReport(fixture.run),
    );

    assert.equal(summary.status, 'failed');
    assert.equal(summary.checks.ollama_provider_exact, false);
    assert.equal(summary.checks.generation_ready_at_start, false);
  } finally {
    fixture.cleanup();
  }
});

test('production summary keeps provider and model fallback evidence separate', () => {
  const fixture = productionFixture();
  try {
    fixture.run.metrics.provider_fallback_reason = 'provider registry rerouted';
    fixture.run.metrics.model_fallback_reason = 'lower resource model selected';

    const summary = buildProductionSummary(
      fixture.run,
      buildStreamingBaselineReport(fixture.run),
    );

    assert.equal(summary.status, 'failed');
    assert.equal(
      summary.provider_fallback_reason,
      'provider registry rerouted',
    );
    assert.equal(
      summary.model_fallback_reason,
      'lower resource model selected',
    );
    assert.equal(summary.checks.provider_no_fallback, false);
  } finally {
    fixture.cleanup();
  }
});

test('production summary fails closed without readiness or release evidence', () => {
  const fixture = productionFixture();
  try {
    delete fixture.run.metrics.generation_readiness_at_start;
    delete fixture.run.metrics.resources_released_at_end;

    const summary = buildProductionSummary(
      fixture.run,
      buildStreamingBaselineReport(fixture.run),
    );

    assert.equal(summary.status, 'failed');
    assert.equal(summary.checks.generation_ready_at_start, false);
    assert.equal(summary.checks.resources_released_at_end, false);
  } finally {
    fixture.cleanup();
  }
});

test('production summary stays incomplete before cleanup finalization', () => {
  const fixture = productionFixture();
  try {
    const summary = buildProductionSummary(
      fixture.run,
      buildStreamingBaselineReport(fixture.run),
      { finalized: false },
    );

    assert.equal(summary.status, 'incomplete');
    assert.equal(summary.checks.cleanup_finalized, false);
  } finally {
    fixture.cleanup();
  }
});

test('artifact writer persists passing baseline and Ollama-only summary', () => {
  const fixture = productionFixture();
  try {
    writeStreamingBaselineArtifacts(fixture.run, { finalized: true });

    const baseline = JSON.parse(
      readFileSync(join(fixture.outDir, 'streaming-baseline.json'), 'utf8'),
    ) as { status: string };
    const production = JSON.parse(
      readFileSync(join(fixture.outDir, 'production-summary.json'), 'utf8'),
    ) as { status: string; provider_policy: string };
    assert.equal(baseline.status, 'passed');
    assert.equal(production.status, 'passed');
    assert.equal(production.provider_policy, 'ollama-only-alpha');
    assert.deepEqual(fixture.run.metrics.errors, []);
  } finally {
    fixture.cleanup();
  }
});

function productionFixture(): {
  readonly run: SmokeRunState;
  readonly outDir: string;
  cleanup(): void;
} {
  const workspaceRoot = mkdtempSync(
    join(tmpdir(), 'cert-prep-production-summary-'),
  );
  const outDir = join(workspaceRoot, 'out');
  const pdfPath = join(workspaceRoot, 'fixture.pdf');
  mkdirSync(outDir);
  writeFileSync(pdfPath, 'fixture');
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
  );

  const run = {
    options: {
      workspaceRoot,
      outDir,
      exePath: join(workspaceRoot, 'Cert Prep.exe'),
      pdfPath,
      appDataDir: join(outDir, 'app-data'),
      cdpPort: 9222,
      ocrProvider: 'windowsml',
      ocrPageWorkers: 1,
      llmProvider: 'ollama',
      ollamaModel: 'qwen3.5:4b',
      ollamaFallbackModels: ['qwen3.5:2b'],
      acceptanceIsolation: true,
      waitForStreamingComplete: true,
      streamingCompleteTimeoutMs: 300_000,
      skipGpuSampling: false,
      productionSummary: true,
      allowOcrChunkVariance: true,
      verifyStreamingPracticeReady: true,
      recordVideo: false,
    },
    metrics: {
      status: 'completed',
      started_at: '2026-07-16T00:00:00.000Z',
      out_dir: outDir,
      screenshots: [],
      ui_timings_ms: {
        first_chunk_visible: 100,
        parse_complete_visible: 500,
      },
      observations: [],
      errors: [],
      llm_provider: 'ollama',
      llm_model: 'qwen3.5:4b',
      llm_configured_model: 'qwen3.5:4b',
      llm_effective_model: 'qwen3.5:4b',
      llm_fallback_models: ['qwen3.5:2b'],
      provider_fallback_reason: null,
      model_fallback_reason: null,
      generation_readiness_at_start: {
        captured_at: '2026-07-16T00:00:01.000Z',
        ready: true,
        provider_selection: {
          preference: 'ollama',
          selected_provider: 'ollama',
          effective_provider: 'ollama',
          configured_model: 'qwen3.5:4b',
          effective_model: 'qwen3.5:4b',
          selection_reason: 'provider_selection_reported',
          fallback_reason: null,
          runtime_requirement_kind: 'ollama',
          model_requirement_kind: 'ollama_model',
        },
        runtime_requirements: [
          {
            kind: 'ollama',
            available: true,
            version: '0.12.0',
            installed_path_verified: true,
          },
          {
            kind: 'ollama_model',
            available: true,
            version: 'qwen3.5:4b',
            installed_path_verified: false,
          },
        ],
        blockers: [],
      },
      resources_released_at_end: {
        captured_at: '2026-07-16T00:01:00.000Z',
        released: true,
        pre_close_captured_at: '2026-07-16T00:00:55.000Z',
        pre_close_release_proven: true,
        pre_close_stable_empty_snapshots: 2,
        stable_empty_snapshots: 2,
        observed_owned_processes: [{ pid: 99, name: 'ollama.exe' }],
        alive_owned_processes: [],
      },
      acceptance_isolation_at_launch: {
        captured_at: '2026-07-16T00:00:00.000Z',
        out_dir_created_by_runner: true,
        app_data_dir_created_by_runner: true,
        app_data_dir_empty_at_launch: true,
        paths_within_workspace_run_root: true,
        reparse_points_absent: true,
      },
      full_exam_question_count: 8,
      ocr_provider: 'windowsml',
      first_chunk_gate_ms: 15_000,
      first_chunk_under_gate: true,
      ocr_completion: {
        pages_processed: 46,
        total_pages: 46,
        chunks: 46,
        expected_pages: 46,
        expected_chunks: 46,
      },
      practice_ready_from_streamed_questions: true,
      final_close: passingCloseSummary(),
      process_cleanup: {
        node_cleanup_summary: {
          baseline_node_count: 0,
          closed_count: 0,
          closed: [],
        },
        new_node_helpers_closed: [],
        residue_after_close: [],
      },
      streaming_questions: {
        first_question_visible_ms: 900,
        first_usable_question_visible_ms: 1_000,
        all_jobs_terminal_ms: 1_500,
        job_snapshots: [
          {
            elapsed_ms: 1_500,
            source: 'draft-jobs',
            item_count: 1,
            status_counts: { succeeded: 1 },
            generated_count: 8,
            jobs: [
              {
                id: 'job-1',
                status: 'succeeded',
                generated_count: 8,
                configured_provider: 'ollama',
                configured_model: 'qwen3.5:4b',
                effective_provider: 'ollama',
                effective_model: 'qwen3.5:4b',
                fallback_reason: null,
                attribution_complete: true,
              },
            ],
          },
        ],
        question_snapshots: [
          {
            elapsed_ms: 1_000,
            source: 'question-drafts',
            item_count: 8,
            usable_question_count: 8,
          },
        ],
        status_counts: { succeeded: 1 },
      },
      resource_sampling: {
        windows_summary_json: 'out/windows-resource-summary.json',
      },
    },
    app: null,
    appExit: null,
    nvidia: null,
    resourceSampling: null,
    videoRecording: null,
    browser: null,
    page: null,
    port: 9222,
    processBaseline: { all: [], nodePids: new Set<number>() },
    projectApi: null,
    uploadedDocument: null,
    streamingDraftParseStartedAt: null,
    streamingDraftCaptureOpen: false,
    streamingApiPollErrorCaptured: false,
  } as SmokeRunState;

  return {
    run,
    outDir,
    cleanup: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

function passingCloseSummary() {
  return {
    label: 'final cleanup',
    app_pid: 42,
    normal_close_requested: true,
    exited_after_normal_close: true,
    forced: false,
    residue: [],
    gracefulExited: true,
    fallbackUsed: false,
    exitCode: 0,
    residualProcesses: [],
  };
}
