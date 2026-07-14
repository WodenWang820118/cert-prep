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
  buildStreamingBaselineReport,
  buildProductionSummary,
  type StreamingBaselineReport,
  writeStreamingBaselineArtifacts,
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

    assert.equal(summary.schema_version, 4);
    assert.equal(summary.status, 'passed');
    assert.equal(summary.acceptance_lane, 'none');
    assert.equal(summary.acceptance_isolation_at_launch, null);
    assert.equal(summary.policy_model, 'qwen3.5:4b');
    assert.equal(summary.provider_preference, 'auto');
    assert.equal(summary.llm_provider, 'fastflowlm');
    assert.equal(summary.checks.fastflowlm_exact_job_attribution, true);
    assert.equal(summary.checks.fastflowlm_no_job_fallback, true);
    assert.equal(summary.checks.generation_ready_at_start, true);
    assert.equal(summary.checks.resources_released_at_end, true);
    assert.equal(summary.checks.windowsml_ocr_process_observed, true);
    assert.equal(summary.checks.ocr_uses_amd_igpu, true);
    assert.equal(summary.checks.ocr_avoids_nvidia_dgpu, true);
    assert.doesNotMatch(
      JSON.stringify(summary),
      /commandLine|parentPid|C:\\\\Users|Bearer\s+/i,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('XDNA2 acceptance lane binds auto selection to exact FastFlow evidence', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-production-summary-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writePassingResourceSummary(outDir);
    const run = productionRunState(workspaceRoot, outDir);
    run.options.acceptanceLane = 'xdna2-fastflow';
    recordPassingAcceptanceIsolation(run);
    const report = productionReport();

    const summary = buildProductionSummary(run, report);

    assert.equal(summary.status, 'passed');
    assert.equal(summary.acceptance_lane, 'xdna2-fastflow');
    assert.equal(summary.checks.acceptance_lane_preference_exact, true);
    assert.equal(summary.checks.acceptance_lane_provider_exact, true);
    assert.equal(summary.checks.acceptance_lane_model_exact, true);
    assert.equal(summary.checks.acceptance_lane_no_fallback, true);
    assert.equal(summary.checks.acceptance_lane_fresh_run_isolation, true);
    assert.equal(summary.checks.acceptance_lane_process_isolation, true);

    const selection = run.metrics.generation_readiness_at_start?.provider_selection;
    const job = run.metrics.streaming_questions.job_snapshots[0]?.jobs[0];
    assert.ok(selection);
    assert.ok(job);
    selection.selected_provider = 'ollama';
    selection.effective_provider = 'ollama';
    job.configured_provider = 'ollama';
    job.effective_provider = 'ollama';

    const providerDrift = buildProductionSummary(run, report);
    assert.equal(providerDrift.status, 'failed');
    assert.equal(
      providerDrift.checks.acceptance_lane_provider_exact,
      false,
    );

    selection.selected_provider = 'fastflowlm';
    selection.effective_provider = 'fastflowlm';
    job.configured_provider = 'fastflowlm';
    job.effective_provider = 'fastflowlm';
    run.processBaseline.all.push({
      pid: 91,
      parentPid: 1,
      name: 'flm.exe',
      executablePath: 'C:\\FastFlowLM\\flm.exe',
      commandLine: 'flm serve',
      creationDate: '20260713000000.000000+000',
      workingSetBytes: 1,
    });
    const contaminatedBaseline = buildProductionSummary(run, report);
    assert.equal(contaminatedBaseline.status, 'failed');
    assert.equal(
      contaminatedBaseline.checks.acceptance_lane_process_isolation,
      false,
    );

    run.processBaseline.all.length = 0;
    delete run.metrics.acceptance_isolation_at_launch;
    const missingFreshnessEvidence = buildProductionSummary(run, report);
    assert.equal(missingFreshnessEvidence.status, 'failed');
    assert.equal(
      missingFreshnessEvidence.checks.acceptance_lane_fresh_run_isolation,
      false,
    );
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
    assert.equal(summary.checks.fastflowlm_exact_job_attribution, true);
    assert.equal(summary.checks.fastflowlm_no_job_fallback, true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary accepts FastFlowLM usable output when closeout health is unavailable', () => {
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
    delete run.metrics.llm_effective_model;
    run.metrics.llm_health = {
      provider: 'fastflowlm',
      available: false,
      model: 'qwen3.5:4b',
      configured_model: 'qwen3.5:4b',
      effective_model: null,
      fallback_models: ['qwen3.5:2b'],
      fallback_reason: null,
      detail: 'server unavailable after generation completed',
    };
    const report = productionReport();
    report.runtime.llm_effective_model = null;
    report.runtime.llm_health = run.metrics.llm_health;

    const summary = buildProductionSummary(run, report);

    assert.equal(summary.status, 'passed');
    assert.equal(summary.selected_model, 'qwen3.5:4b');
    assert.equal(summary.checks.fastflowlm_exact_job_attribution, true);
    assert.equal(summary.checks.fastflowlm_health_available, undefined);
    assert.equal(summary.checks.selected_model_produced_usable_questions, true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary does not use health as FastFlowLM execution evidence', () => {
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
    const report = productionReport();
    report.runtime.llm_health = null;

    const summary = buildProductionSummary(run, report);

    assert.equal(summary.status, 'passed');
    assert.equal(summary.checks.fastflowlm_health_available, undefined);
    assert.equal(summary.checks.fastflowlm_exact_job_attribution, true);
    assert.equal(summary.checks.selected_model_produced_usable_questions, true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary aligns Ollama policy, profile alias, and job attribution', () => {
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
    const profileModel = 'cert-prep-qwen3.5-4b-study-8k';
    const run = productionRunState(workspaceRoot, outDir);
    const readiness = run.metrics.generation_readiness_at_start;
    const selection = readiness?.provider_selection;
    const job = run.metrics.streaming_questions.job_snapshots[0]?.jobs[0];
    assert.ok(readiness);
    assert.ok(selection);
    assert.ok(job);

    run.metrics.llm_provider = 'ollama';
    run.metrics.llm_configured_model = profileModel;
    run.metrics.llm_effective_model = profileModel;
    run.metrics.llm_fallback_reason = null;
    run.metrics.llm_health = {
      provider: 'ollama',
      available: true,
      model: profileModel,
      configured_model: profileModel,
      effective_model: profileModel,
      fallback_models: ['cert-prep-qwen3.5-2b-study-4k'],
      fallback_reason: null,
      detail: 'profile model available',
    };
    selection.selected_provider = 'ollama';
    selection.effective_provider = 'ollama';
    selection.configured_model = 'qwen3.5:4b';
    selection.effective_model = profileModel;
    selection.selection_reason = 'provider_selection_reported';
    selection.fallback_reason = 'provider_fallback_reported';
    selection.hardware_compatible = false;
    selection.requires_terms_acceptance = false;
    selection.terms_accepted = false;
    selection.terms_version = null;
    selection.runtime_requirement_kind = 'ollama';
    selection.model_requirement_kind = 'ollama_model';
    readiness.runtime_requirements = [
      {
        kind: 'ollama',
        available: true,
        version: '0.12.0',
        installed_path_verified: true,
      },
      {
        kind: 'ollama_model',
        available: true,
        version: profileModel,
        installed_path_verified: false,
      },
    ];
    job.configured_provider = 'ollama';
    job.configured_model = profileModel;
    job.effective_provider = 'ollama';
    job.effective_model = profileModel;
    job.fallback_reason = null;
    run.metrics.resources_released_at_end = {
      captured_at: '2026-06-23T00:01:00.000Z',
      released: true,
      pre_close_captured_at: '2026-06-23T00:00:55.000Z',
      pre_close_release_proven: true,
      pre_close_stable_empty_snapshots: 2,
      stable_empty_snapshots: 2,
      observed_owned_processes: [],
      alive_owned_processes: [],
    };

    const report = productionReport();
    report.runtime.llm_provider = 'auto';
    report.runtime.llm_configured_model = profileModel;
    report.runtime.llm_effective_model = profileModel;
    report.runtime.llm_fallback_models = [
      'cert-prep-qwen3.5-2b-study-4k',
    ];
    report.runtime.llm_health = run.metrics.llm_health;

    const summary = buildProductionSummary(run, report);

    assert.equal(summary.status, 'passed');
    assert.equal(summary.provider_preference, 'auto');
    assert.equal(summary.configured_model, profileModel);
    assert.equal(summary.effective_model, profileModel);
    assert.equal(summary.checks.generation_ready_at_start, true);
    assert.equal(summary.checks.reasoning_uses_nvidia_dgpu, true);
    assert.equal(summary.checks.fastflowlm_exact_job_attribution, undefined);

    run.metrics.resources_released_at_end.observed_owned_processes = [
      { pid: 99, name: 'flm.exe' },
    ];
    const conflictingProviderSummary = buildProductionSummary(run, report);
    assert.equal(conflictingProviderSummary.status, 'failed');
    assert.equal(
      conflictingProviderSummary.checks.resources_released_at_end,
      false,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Ollama fallback lane keeps provider and model reasons separate and fails closed', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-production-summary-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writePassingResourceSummary(outDir);
    const run = productionRunState(workspaceRoot, outDir);
    const report = productionReport();
    configureOllamaFallbackAcceptance(run, report);

    const summary = buildProductionSummary(run, report);

    assert.equal(summary.status, 'passed');
    assert.equal(summary.acceptance_lane, 'ollama-fallback');
    assert.equal(
      summary.provider_fallback_reason,
      'FastFlowLM terms were declined.',
    );
    assert.equal(summary.model_fallback_reason, null);
    assert.equal(summary.fallback_reason, null);
    assert.equal(summary.checks.acceptance_lane_route_persisted, true);
    assert.equal(summary.checks.acceptance_lane_runtime_real, true);
    assert.equal(summary.checks.acceptance_lane_job_evidence_bound, true);
    assert.equal(summary.checks.acceptance_lane_ollama_model_released, true);
    assert.equal(summary.checks.acceptance_lane_no_overrides_or_fake, true);

    assert.ok(run.metrics.ollama_fallback_acceptance);
    run.metrics.ollama_fallback_acceptance.fake_provider_observed = true;
    const fakeSummary = buildProductionSummary(run, report);
    assert.equal(fakeSummary.status, 'failed');
    assert.equal(
      fakeSummary.checks.acceptance_lane_no_overrides_or_fake,
      false,
    );

    run.metrics.ollama_fallback_acceptance.fake_provider_observed = false;
    run.metrics.ollama_fallback_acceptance.model_fallback_reason =
      run.metrics.ollama_fallback_acceptance.provider_fallback_reason;
    const conflatedSummary = buildProductionSummary(run, report);
    assert.equal(conflatedSummary.status, 'failed');
    assert.equal(
      conflatedSummary.checks.acceptance_lane_model_fallback_reason_separate,
      false,
    );
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
    const job = run.metrics.streaming_questions.job_snapshots[0]?.jobs[0];
    assert.ok(job);
    job.configured_provider = 'ollama';
    job.effective_provider = 'ollama';
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
    assert.equal(summary.checks.fastflowlm_exact_job_attribution, undefined);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary rejects FastFlowLM low-RAM fallback in the XDNA lane', () => {
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
    run.metrics.llm_effective_model = 'qwen3.5:2b';
    run.metrics.llm_fallback_reason =
      'Available system RAM 3.0 GiB is below the 6.0 GiB required for qwen3.5:4b; using fallback qwen3.5:2b.';
    const job = run.metrics.streaming_questions.job_snapshots[0]?.jobs[0];
    assert.ok(job);
    job.effective_model = 'qwen3.5:2b';
    job.fallback_reason = run.metrics.llm_fallback_reason;
    const report = productionReport();
    report.runtime.llm_effective_model = 'qwen3.5:2b';
    report.runtime.llm_fallback_reason = run.metrics.llm_fallback_reason;
    report.runtime.llm_health = {
      provider: 'fastflowlm',
      available: true,
      model: 'qwen3.5:4b',
      configured_model: 'qwen3.5:4b',
      effective_model: 'qwen3.5:2b',
      fallback_models: ['qwen3.5:2b'],
      fallback_reason: run.metrics.llm_fallback_reason,
      detail: 'model available via fallback qwen3.5:2b',
    };

    const summary = buildProductionSummary(run, report);

    assert.equal(summary.status, 'failed');
    assert.equal(summary.selected_model, 'qwen3.5:2b');
    assert.equal(summary.checks.fastflowlm_exact_job_attribution, false);
    assert.equal(summary.checks.fastflowlm_no_job_fallback, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary includes completed video evidence when recording is enabled', () => {
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
        },
      }),
      'utf8',
    );
    const video = completedVideoArtifact();
    const run = productionRunState(workspaceRoot, outDir);
    run.options.recordVideo = true;
    run.metrics.video_artifacts = [video];
    const report = productionReport();
    report.artifacts.video_recordings = [video];

    const summary = buildProductionSummary(run, report);

    assert.equal(summary.status, 'passed');
    assert.equal(summary.checks.video_recording_completed, true);
    assert.deepEqual(summary.artifacts.video_recordings, [video]);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('streaming baseline report includes video evidence when recording is enabled', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-baseline-video-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writeFileSync(join(workspaceRoot, 'fixture.pdf'), 'fixture', 'utf8');
    const video = completedVideoArtifact();
    const run = productionRunState(workspaceRoot, outDir);
    run.options.recordVideo = true;
    run.metrics.video_artifacts = [video];

    const report = buildStreamingBaselineReport(run);

    assert.equal(report.checks.video_recording_completed, true);
    assert.deepEqual(report.artifacts.video_recordings, [video]);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('streaming baseline report omits video check when recording is disabled', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-baseline-video-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writeFileSync(join(workspaceRoot, 'fixture.pdf'), 'fixture', 'utf8');

    const report = buildStreamingBaselineReport(
      productionRunState(workspaceRoot, outDir),
    );

    assert.equal(report.checks.video_recording_completed, undefined);
    assert.equal(report.artifacts.video_recordings, undefined);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary fails when requested video evidence is missing', () => {
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
        },
      }),
      'utf8',
    );
    const run = productionRunState(workspaceRoot, outDir);
    run.options.recordVideo = true;

    const summary = buildProductionSummary(run, productionReport());

    assert.equal(summary.status, 'failed');
    assert.equal(summary.checks.video_recording_completed, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('streaming baseline does not treat missing cleanup evidence as no residue', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-baseline-cleanup-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writeFileSync(join(workspaceRoot, 'fixture.pdf'), 'fixture', 'utf8');

    const report = buildStreamingBaselineReport(
      productionRunState(workspaceRoot, outDir),
    );

    assert.equal(report.status, 'failed');
    assert.equal(report.checks.graceful_close, false);
    assert.equal(report.checks.no_residual_processes, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary stays incomplete before cleanup finalization', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-production-summary-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writePassingResourceSummary(outDir);

    const summary = buildProductionSummary(
      productionRunState(workspaceRoot, outDir),
      productionReport(),
      { finalized: false },
    );

    assert.equal(summary.status, 'incomplete');
    assert.equal(summary.checks.cleanup_finalized, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('final artifact write keeps baseline and production failures consistent', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-production-write-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writeFileSync(join(workspaceRoot, 'fixture.pdf'), 'fixture', 'utf8');
    writePassingResourceSummary(outDir);
    const run = productionRunState(workspaceRoot, outDir);
    delete run.metrics.generation_readiness_at_start;
    run.metrics.ui_timings_ms.parse_complete_visible = 100;
    run.metrics.streaming_questions.first_usable_question_visible_ms = 101;
    run.metrics.streaming_questions.question_snapshots = [
      {
        elapsed_ms: 101,
        source: 'question-drafts',
        item_count: 8,
        usable_question_count: 8,
      },
    ];
    run.metrics.final_close = passingCloseSummary();
    run.metrics.process_cleanup = {
      node_cleanup_summary: {
        baseline_node_count: 0,
        closed_count: 0,
        closed: [],
      },
      new_node_helpers_closed: [],
      residue_after_close: [],
    };

    writeStreamingBaselineArtifacts(run, {
      finalized: true,
      recordFailure: true,
    });

    const baseline = JSON.parse(
      readFileSync(join(outDir, 'streaming-baseline.json'), 'utf8'),
    ) as { status: string };
    const production = JSON.parse(
      readFileSync(join(outDir, 'production-summary.json'), 'utf8'),
    ) as { status: string };
    assert.equal(baseline.status, 'failed');
    assert.equal(production.status, 'failed');
    assert.match(run.metrics.errors.join('\n'), /production checks failed/i);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary fails closed when readiness or release evidence is missing', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-production-summary-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writePassingResourceSummary(outDir);

    const missingReadiness = productionRunState(workspaceRoot, outDir);
    delete missingReadiness.metrics.generation_readiness_at_start;
    const readinessSummary = buildProductionSummary(
      missingReadiness,
      productionReport(),
    );
    assert.equal(readinessSummary.status, 'failed');
    assert.equal(readinessSummary.checks.generation_ready_at_start, false);

    const missingRelease = productionRunState(workspaceRoot, outDir);
    delete missingRelease.metrics.resources_released_at_end;
    const releaseSummary = buildProductionSummary(
      missingRelease,
      productionReport(),
    );
    assert.equal(releaseSummary.status, 'failed');
    assert.equal(releaseSummary.checks.resources_released_at_end, false);

    const unobservedRelease = productionRunState(workspaceRoot, outDir);
    assert.ok(unobservedRelease.metrics.resources_released_at_end);
    unobservedRelease.metrics.resources_released_at_end.observed_owned_processes = [];
    assert.equal(
      buildProductionSummary(unobservedRelease, productionReport()).checks
        .resources_released_at_end,
      false,
    );

    const singlePreCloseSnapshot = productionRunState(workspaceRoot, outDir);
    assert.ok(singlePreCloseSnapshot.metrics.resources_released_at_end);
    singlePreCloseSnapshot.metrics.resources_released_at_end.pre_close_stable_empty_snapshots = 1;
    assert.equal(
      buildProductionSummary(singlePreCloseSnapshot, productionReport()).checks
        .resources_released_at_end,
      false,
    );

    const untrustedReadiness = productionRunState(workspaceRoot, outDir);
    const runtimeRequirement =
      untrustedReadiness.metrics.generation_readiness_at_start?.runtime_requirements.find(
        (requirement) => requirement.kind === 'fastflowlm',
      );
    assert.ok(runtimeRequirement);
    runtimeRequirement.installed_path_verified = false;
    assert.equal(
      buildProductionSummary(untrustedReadiness, productionReport()).checks
        .generation_ready_at_start,
      false,
    );

    const mismatchedPreference = productionRunState(workspaceRoot, outDir);
    assert.ok(mismatchedPreference.metrics.generation_readiness_at_start);
    assert.ok(
      mismatchedPreference.metrics.generation_readiness_at_start
        .provider_selection,
    );
    mismatchedPreference.metrics.generation_readiness_at_start.provider_selection.preference =
      'fastflowlm';
    assert.equal(
      buildProductionSummary(mismatchedPreference, productionReport()).checks
        .generation_ready_at_start,
      false,
    );

    const emptyExam = productionRunState(workspaceRoot, outDir);
    emptyExam.metrics.full_exam_question_count = 0;
    const emptyExamSummary = buildProductionSummary(
      emptyExam,
      productionReport(),
    );
    assert.equal(emptyExamSummary.status, 'failed');
    assert.equal(emptyExamSummary.checks.full_exam_questions_present, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary rejects usable output without persisted job attribution', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-production-summary-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writePassingResourceSummary(outDir);
    const run = productionRunState(workspaceRoot, outDir);
    run.metrics.streaming_questions.job_snapshots = [];

    const summary = buildProductionSummary(run, productionReport());

    assert.equal(summary.status, 'failed');
    assert.equal(summary.selected_model, null);
    assert.equal(summary.llm_provider, null);
    assert.equal(summary.checks.producing_job_attribution_present, false);
    assert.equal(summary.checks.supported_effective_provider, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production summary rejects incomplete and mixed producing-job attribution', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-production-summary-'));
  try {
    const outDir = join(workspaceRoot, 'out');
    mkdirSync(outDir);
    writePassingResourceSummary(outDir);
    const incompleteRun = productionRunState(workspaceRoot, outDir);
    const incompleteJob =
      incompleteRun.metrics.streaming_questions.job_snapshots[0]?.jobs[0];
    assert.ok(incompleteJob);
    incompleteJob.effective_model = null;
    incompleteJob.attribution_complete = false;

    const incompleteSummary = buildProductionSummary(
      incompleteRun,
      productionReport(),
    );
    assert.equal(incompleteSummary.status, 'failed');
    assert.equal(incompleteSummary.selected_model, null);
    assert.equal(
      incompleteSummary.checks.producing_job_attribution_complete,
      false,
    );

    const mixedRun = productionRunState(workspaceRoot, outDir);
    const snapshot = mixedRun.metrics.streaming_questions.job_snapshots[0];
    assert.ok(snapshot);
    snapshot.jobs.push({
      id: 'job-2',
      status: 'succeeded',
      generated_count: 1,
      configured_provider: 'fastflowlm',
      configured_model: 'qwen3.5:4b',
      effective_provider: 'fastflowlm',
      effective_model: 'qwen3.5:2b',
      fallback_reason: 'low memory fallback',
      attribution_complete: true,
    });
    snapshot.item_count = 2;
    snapshot.status_counts = { succeeded: 2 };
    snapshot.generated_count = 9;

    const mixedSummary = buildProductionSummary(mixedRun, productionReport());
    assert.equal(mixedSummary.status, 'failed');
    assert.equal(mixedSummary.selected_model, null);
    assert.equal(mixedSummary.checks.fastflowlm_exact_job_attribution, false);

    const zeroOutputFallbackRun = productionRunState(workspaceRoot, outDir);
    const zeroOutputSnapshot =
      zeroOutputFallbackRun.metrics.streaming_questions.job_snapshots[0];
    assert.ok(zeroOutputSnapshot);
    zeroOutputSnapshot.jobs.push({
      id: 'job-zero-output-fallback',
      status: 'succeeded',
      generated_count: 0,
      configured_provider: 'fastflowlm',
      configured_model: 'qwen3.5:4b',
      effective_provider: 'fastflowlm',
      effective_model: 'qwen3.5:2b',
      fallback_reason: 'low memory fallback',
      attribution_complete: true,
    });
    zeroOutputSnapshot.item_count = 2;
    zeroOutputSnapshot.status_counts = { succeeded: 2 };
    const zeroOutputReport = productionReport();
    zeroOutputReport.streaming.job_count = 2;
    zeroOutputReport.streaming.final_status_counts = { succeeded: 2 };
    zeroOutputReport.streaming.completion_state.total_count = 2;
    zeroOutputReport.streaming.completion_state.terminal_count = 2;
    zeroOutputReport.streaming.completion_state.succeeded_count = 2;

    const zeroOutputSummary = buildProductionSummary(
      zeroOutputFallbackRun,
      zeroOutputReport,
    );
    assert.equal(zeroOutputSummary.status, 'failed');
    assert.equal(zeroOutputSummary.producing_jobs.length, 1);
    assert.equal(zeroOutputSummary.succeeded_jobs.length, 2);
    assert.equal(zeroOutputSummary.checks.fastflowlm_exact_job_attribution, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function recordPassingAcceptanceIsolation(run: SmokeRunState): void {
  run.metrics.acceptance_isolation_at_launch = {
    captured_at: '2026-07-13T00:00:00.000Z',
    out_dir_created_by_runner: true,
    app_data_dir_created_by_runner: true,
    app_data_dir_empty_at_launch: true,
    paths_within_workspace_run_root: true,
    reparse_points_absent: true,
  };
}

function writePassingResourceSummary(outDir: string): void {
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
}

function configureOllamaFallbackAcceptance(
  run: SmokeRunState,
  report: StreamingBaselineReport,
): void {
  const profileModel = 'cert-prep-qwen3.5-4b-study-8k';
  const readiness = run.metrics.generation_readiness_at_start;
  const selection = readiness?.provider_selection;
  const job = run.metrics.streaming_questions.job_snapshots[0]?.jobs[0];
  assert.ok(readiness);
  assert.ok(selection);
  assert.ok(job);

  run.options.acceptanceLane = 'ollama-fallback';
  run.options.ollamaFallbackTrigger = 'declined-terms';
  recordPassingAcceptanceIsolation(run);
  run.metrics.llm_provider = 'ollama';
  run.metrics.llm_configured_model = profileModel;
  run.metrics.llm_effective_model = profileModel;
  run.metrics.provider_fallback_reason = 'FastFlowLM terms were declined.';
  run.metrics.model_fallback_reason = null;
  run.metrics.llm_fallback_reason = null;
  Object.assign(selection, {
    selected_provider: 'ollama',
    effective_provider: 'ollama',
    configured_model: 'qwen3.5:4b',
    effective_model: profileModel,
    selection_reason: 'provider_selection_reported',
    fallback_reason: 'provider_fallback_reported',
    hardware_compatible: true,
    requires_terms_acceptance: false,
    terms_accepted: false,
    terms_version: null,
    runtime_requirement_kind: 'ollama',
    model_requirement_kind: 'ollama_model',
  });
  readiness.runtime_requirements = [
    {
      kind: 'ollama',
      available: true,
      version: '0.12.0',
      installed_path_verified: true,
    },
    {
      kind: 'ollama_model',
      available: true,
      version: profileModel,
      installed_path_verified: false,
    },
  ];
  Object.assign(job, {
    configured_provider: 'ollama',
    configured_model: profileModel,
    effective_provider: 'ollama',
    effective_model: profileModel,
    fallback_reason: null,
  });
  run.metrics.resources_released_at_end = {
    captured_at: '2026-06-23T00:01:00.000Z',
    released: true,
    pre_close_captured_at: '2026-06-23T00:00:55.000Z',
    pre_close_release_proven: true,
    pre_close_stable_empty_snapshots: 2,
    stable_empty_snapshots: 2,
    observed_owned_processes: [],
    alive_owned_processes: [],
  };
  const routedSelection = {
    captured_at: '2026-06-23T00:00:05.000Z',
    preference: 'auto' as const,
    selected_provider: 'ollama' as const,
    effective_provider: 'ollama' as const,
    configured_model: 'qwen3.5:4b',
    effective_model: profileModel,
    provider_fallback_reason: 'FastFlowLM terms were declined.',
    hardware_compatible: true,
    requires_terms_acceptance: false,
    terms_accepted: false,
    terms_version: null,
    runtime_requirement_kind: 'ollama' as const,
    model_requirement_kind: 'ollama_model' as const,
  };
  run.metrics.ollama_fallback_acceptance = {
    schema_version: 1,
    trigger: 'declined-terms',
    trigger_mode: 'persisted_terms_decision',
    overrides_used: false,
    fake_provider_observed: false,
    decision_endpoint:
      '/llm/provider-selection/fastflowlm-terms-decision',
    selection_before: {
      ...routedSelection,
      captured_at: '2026-06-23T00:00:00.000Z',
      selected_provider: 'fastflowlm',
      effective_provider: 'fastflowlm',
      provider_fallback_reason: null,
      requires_terms_acceptance: true,
      terms_version: '0.9.43',
      runtime_requirement_kind: 'fastflowlm',
      model_requirement_kind: 'fastflowlm_model',
    },
    selection_after_route: routedSelection,
    selection_after_restart: {
      ...routedSelection,
      captured_at: '2026-06-23T00:00:10.000Z',
    },
    provider_fallback_reason: 'FastFlowLM terms were declined.',
    model_fallback_reason: null,
    runtime: {
      requirement_version: '0.12.0',
      installed_path_verified: true,
      api_version: '0.12.0',
      installed_models: [`${profileModel}:latest`],
      profile: {
        profile_enabled: true,
        profile_id: 'qwen3.5-4b-study-8k',
        support_status: 'supported',
        selection_reason: 'Selected the default profile.',
        effective_model: profileModel,
        base_model: 'qwen3.5:4b',
        modelfile_sha256: 'a'.repeat(64),
        fallback_models: ['cert-prep-qwen3.5-2b-study-4k'],
        inventory: {
          schema_version: 1,
          platform: 'Windows',
          platform_version: '11',
          architecture: 'AMD64',
          cpu_name: 'AMD Ryzen AI',
          total_ram_bytes: 16 * 1024 ** 3,
          available_ram_bytes: 8 * 1024 ** 3,
          accelerators: [],
          warnings: [],
        },
      },
    },
    job_attribution: [job],
    usable_question_count: 8,
    full_exam_question_count: 8,
    resource_release: {
      captured_at: '2026-06-23T00:00:50.000Z',
      effective_model: profileModel,
      loaded_models: [],
      released: true,
    },
  };

  report.runtime.llm_provider = 'auto';
  report.runtime.llm_configured_model = profileModel;
  report.runtime.llm_effective_model = profileModel;
  report.runtime.llm_fallback_models = [
    'cert-prep-qwen3.5-2b-study-4k',
  ];
  report.runtime.llm_fallback_reason = null;
  report.runtime.llm_health = {
    provider: 'ollama',
    available: true,
    model: profileModel,
    configured_model: profileModel,
    effective_model: profileModel,
    fallback_models: ['cert-prep-qwen3.5-2b-study-4k'],
    fallback_reason: null,
    detail: 'profile model available',
    profile_id: 'qwen3.5-4b-study-8k',
    base_model: 'qwen3.5:4b',
    modelfile_sha256: 'a'.repeat(64),
    profile_reason: 'Selected the default profile.',
    profile_warnings: [],
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
      llmProvider: 'auto',
      ollamaModel: 'qwen3.5:4b',
      ollamaFallbackModels: ['qwen3.5:2b'],
      waitForStreamingComplete: true,
      streamingCompleteTimeoutMs: 300000,
      skipGpuSampling: false,
      productionSummary: true,
      allowOcrChunkVariance: true,
      verifyStreamingPracticeReady: true,
      recordVideo: false,
    },
    metrics: {
      status: 'completed',
      started_at: '2026-06-23T00:00:00.000Z',
      out_dir: outDir,
      screenshots: [],
      ui_timings_ms: {},
      observations: [],
      errors: [],
      llm_provider: 'auto',
      llm_model: 'qwen3.5:4b',
      llm_effective_model: 'qwen3.5:4b',
      llm_fallback_models: ['qwen3.5:2b'],
      generation_readiness_at_start: {
        captured_at: '2026-06-23T00:00:00.000Z',
        ready: true,
        provider_selection: {
          preference: 'auto',
          selected_provider: 'fastflowlm',
          effective_provider: 'fastflowlm',
          configured_model: 'qwen3.5:4b',
          effective_model: 'qwen3.5:4b',
          selection_reason: 'Compatible XDNA2 hardware selected FastFlowLM.',
          fallback_reason: null,
          hardware_compatible: true,
          requires_terms_acceptance: true,
          terms_accepted: true,
          terms_version: '0.9.43',
          runtime_requirement_kind: 'fastflowlm',
          model_requirement_kind: 'fastflowlm_model',
        },
        runtime_requirements: [
          {
            kind: 'fastflowlm',
            available: true,
            version: '0.9.43',
            installed_path_verified: true,
          },
          {
            kind: 'fastflowlm_model',
            available: true,
            version: 'qwen3.5:4b',
            installed_path_verified: false,
          },
        ],
        blockers: [],
      },
      resources_released_at_end: {
        captured_at: '2026-06-23T00:01:00.000Z',
        released: true,
        pre_close_captured_at: '2026-06-23T00:00:55.000Z',
        pre_close_release_proven: true,
        pre_close_stable_empty_snapshots: 2,
        stable_empty_snapshots: 2,
        observed_owned_processes: [
          {
            pid: 99,
            name: 'flm.exe',
          },
        ],
        alive_owned_processes: [],
      },
      full_exam_question_count: 8,
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
        job_snapshots: [
          {
            elapsed_ms: 1_000,
            source: 'draft-jobs',
            item_count: 1,
            status_counts: { succeeded: 1 },
            generated_count: 8,
            jobs: [
              {
                id: 'job-1',
                status: 'succeeded',
                generated_count: 8,
                configured_provider: 'fastflowlm',
                configured_model: 'qwen3.5:4b',
                effective_provider: 'fastflowlm',
                effective_model: 'qwen3.5:4b',
                fallback_reason: null,
                attribution_complete: true,
              },
            ],
          },
        ],
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
    videoRecording: null,
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

function completedVideoArtifact() {
  return {
    path: 'out/01-acceptance-recording.webm',
    bytes: 123,
    sha256: 'video-sha',
    capture_source: 'playwright_screencast' as const,
    status: 'completed' as const,
    started_at: '2026-06-23T00:00:00.000Z',
    finished_at: '2026-06-23T00:01:00.000Z',
  };
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
      llm_provider: 'auto',
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
      job_count: 1,
      final_status_counts: { succeeded: 1 },
      completion_state: {
        total_count: 1,
        active_count: 0,
        terminal_count: 1,
        succeeded_count: 1,
        failed_count: 0,
        skipped_count: 0,
        all_terminal: true,
        all_succeeded: true,
      },
      generated_count: 8,
      question_count: 8,
      usable_question_count: 8,
      first_usable_after_parse_complete: true,
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
      first_usable_after_parse_complete: true,
      all_jobs_terminal: true,
      all_jobs_succeeded: true,
      generated_equals_usable: true,
      no_streaming_blocker: true,
      streaming_practice_ready: true,
    },
    errors: [],
  };
}
