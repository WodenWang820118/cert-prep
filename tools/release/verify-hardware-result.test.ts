import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  buildValidResilienceEvidence,
  buildValidSessionRestartEvidence,
} from '../../apps/cert-prep-desktop/scripts/packaged-resilience/evidence-fixtures.mts';

import {
  HARDWARE_CANCELLATION_CHECKS,
  deriveReleaseIdentity,
  sha256File,
  writeJson,
} from './release-lib.ts';
import { verifyHardwareEvidence } from './verify-hardware-result.ts';

const acceptanceRunId = 'acceptance-run-0001';
const candidateId = 'e'.repeat(64);
const amdLuid = '0x00000000_0x000136c5';
const softwareLuid = '0x00000000_0x00000001';
const unknownLuid = '0x00000000_0x00000002';

async function writeAcceptancePdfFixture(root, evidenceRoot) {
  const inputRoot = join(root, 'acceptance-pdfs');
  mkdirSync(inputRoot, { recursive: true });
  const pdfs = [];
  const pdfPaths = [];
  for (let index = 0; index < 4; index += 1) {
    const fileName = `acceptance-${index + 1}.pdf`;
    const path = join(inputRoot, fileName);
    writeFileSync(path, `%PDF-1.7 fixture-${index + 1}`);
    pdfPaths.push(path);
    pdfs.push({
      logicalId: `acceptance-${index + 1}`,
      fileName,
      bytes: statSync(path).size,
      sha256: await sha256File(path),
    });
  }
  const manifest = {
    schemaVersion: 1,
    suiteId: 'public-alpha-b3-v1',
    pdfs,
  };
  const manifestPath = join(
    inputRoot,
    'alpha-acceptance-pdf-manifest.json',
  );
  const evidenceManifestPath = join(
    evidenceRoot,
    'alpha-acceptance-pdf-manifest.json',
  );
  writeJson(manifestPath, manifest);
  writeJson(evidenceManifestPath, manifest);
  const manifestSha256 = await sha256File(manifestPath);
  assert.equal(await sha256File(evidenceManifestPath), manifestSha256);
  return {
    inputRoot,
    manifest,
    manifestPath,
    manifestSha256,
    evidenceReference: {
      path: 'alpha-acceptance-pdf-manifest.json',
      bytes: statSync(evidenceManifestPath).size,
      sha256: manifestSha256,
      candidateId,
      acceptanceRunId,
    },
    pdfPaths,
  };
}

async function writeProductionEvidence(evidenceRoot) {
  const artifacts = {
    windows_summary_json: 'windows-resource-summary.json',
    windows_counters_csv: 'windows-resource-sampling.csv',
    windows_dxgi_adapters_json: 'windows-dxgi-adapters.json',
  };
  const routing = {
    windowsml_ocr_process_observed: true,
    ocr_uses_amd_igpu: true,
    gpu_luid_map_usable: true,
  };
  const dxgiAdapters = [
    { luid: amdLuid, adapter_kind: 'amd_igpu' },
    { luid: softwareLuid, adapter_kind: 'software' },
    { luid: unknownLuid, adapter_kind: 'unknown' },
  ];
  writeJson(join(evidenceRoot, artifacts.windows_dxgi_adapters_json), {
    status: 'completed',
    generated_at: '2026-07-11T01:00:01.250Z',
    adapters: dxgiAdapters,
  });
  writeJson(join(evidenceRoot, artifacts.windows_summary_json), {
    finalized_at: '2026-07-11T01:00:03.000Z',
    artifacts,
    dxgi_adapters: dxgiAdapters,
    named_target_process_gpu_usage: [
      {
        pid: 42,
        luid: amdLuid,
        name: 'cert-prep-ocr-windowsml-runtime.exe',
        adapter_kind: 'amd_igpu',
        metrics: { shared_usage: { max: 8192 } },
      },
    ],
    gpu_routing_checks: routing,
  });
  writeFileSync(
    join(evidenceRoot, artifacts.windows_counters_csv),
    `timestamp,source,path,pid,name,metric,value,unit\n"2026-07-11T01:00:02.000Z","windows_process","Win32_Process","42","cert-prep-ocr-windowsml-runtime.exe","working_set_bytes","1024","bytes"\n"2026-07-11T01:00:02.500Z","windows_process","Win32_Process","77","llama-server.exe","working_set_bytes","2048","bytes"\n"2026-07-11T01:00:03.000Z","windows_gpu_counter","\\\\MSI\\GPU Process Memory(pid_42_luid_${amdLuid}_phys_0)\\Shared Usage","","","\\\\MSI\\GPU Process Memory(pid_42_luid_${amdLuid}_phys_0)\\Shared Usage","8192","raw"\n`,
  );
  writeJson(join(evidenceRoot, 'production-summary.json'), {
    schema_version: 6,
    status: 'passed',
    generated_at: '2026-07-11T01:00:03.500Z',
    provider_policy: 'ollama-only-alpha',
    policy_model: 'qwen3.5:4b',
    selected_model: 'qwen3.5:4b',
    llm_provider: 'ollama',
    provider_preference: 'ollama',
    configured_provider: 'ollama',
    configured_model: 'qwen3.5:4b',
    effective_model: 'qwen3.5:4b',
    provider_fallback_reason: null,
    model_fallback_reason: null,
    fallback_reason: null,
    execution_mode: 'cpu',
    execution_warning: 'Supported acceleration was not confirmed; using CPU.',
    llm_health: {
      provider: 'ollama',
      available: true,
      model: 'qwen3.5:4b',
      configured_model: 'qwen3.5:4b',
      effective_model: 'qwen3.5:4b',
      fallback_models: [],
      fallback_reason: null,
      execution_mode: 'cpu',
      execution_warning: 'Supported acceleration was not confirmed; using CPU.',
      detail: 'Ollama and the configured model are available.',
    },
    generation_ready_at_start: {
      captured_at: '2026-07-11T01:00:01.500Z',
      ready: true,
      provider_selection: {
        preference: 'ollama',
        selected_provider: 'ollama',
        effective_provider: 'ollama',
        configured_model: 'qwen3.5:4b',
        effective_model: 'qwen3.5:4b',
        fallback_reason: null,
      },
      blockers: [],
    },
    resources_released_at_end: {
      captured_at: '2026-07-11T01:00:03.500Z',
      released: true,
      pre_close_captured_at: '2026-07-11T01:00:03.000Z',
      pre_close_release_proven: true,
      pre_close_stable_empty_snapshots: 2,
      stable_empty_snapshots: 2,
      alive_owned_processes: [],
    },
    full_exam_question_count: 8,
    succeeded_jobs: [
      {
        configured_provider: 'ollama',
        effective_provider: 'ollama',
        configured_model: 'qwen3.5:4b',
        effective_model: 'qwen3.5:4b',
        fallback_reason: null,
        attribution_complete: true,
      },
    ],
    artifacts: {
      production_summary_json: 'production-summary.json',
      resource_sampling: artifacts,
    },
    gpu_routing_checks: routing,
    checks: {
      ollama_provider_exact: true,
      ollama_model_exact: true,
      provider_no_fallback: true,
      model_no_fallback: true,
      execution_mode_supported: true,
      execution_warning_consistent: true,
      generation_ready_at_start: true,
      resources_released_at_end: true,
      full_exam_questions_present: true,
      windowsml_ocr_process_observed: true,
      ocr_uses_amd_igpu: true,
    },
  });
  const boundArtifact = async (path) => ({
    path,
    bytes: statSync(join(evidenceRoot, path)).size,
    sha256: await sha256File(join(evidenceRoot, path)),
    candidateId,
    acceptanceRunId,
  });
  return {
    productionSummary: await boundArtifact('production-summary.json'),
    gpuTelemetry: {
      windowsResourceSummary: await boundArtifact(
        artifacts.windows_summary_json,
      ),
      windowsResourceSampling: await boundArtifact(
        artifacts.windows_counters_csv,
      ),
      windowsDxgiAdapters: await boundArtifact(
        artifacts.windows_dxgi_adapters_json,
      ),
    },
  };
}

async function hardwareResult(
  plan,
  evidenceRoot,
  recording,
  recordingSha256,
  acceptancePdfFixture,
) {
  const candidate = {
    candidateId,
    version: plan.version,
    tag: plan.tag,
    commitSha: plan.commitSha,
    harnessSha256: 'c'.repeat(64),
  };
  const cancellation = {};
  const cancellationRoot = join(evidenceRoot, 'cancellation');
  mkdirSync(cancellationRoot, { recursive: true });
  for (const key of HARDWARE_CANCELLATION_CHECKS) {
    const path = join(cancellationRoot, `${key}.json`);
    writeJson(path, buildValidResilienceEvidence(key, { candidate }));
    cancellation[key] = {
      passed: true,
      path: `cancellation/${key}.json`,
      bytes: statSync(path).size,
      sha256: await sha256File(path),
    };
  }
  const sessionRestartPath = join(evidenceRoot, 'session-restart.json');
  writeJson(
    sessionRestartPath,
    buildValidSessionRestartEvidence({ candidate }),
  );
  const productionEvidence = await writeProductionEvidence(evidenceRoot);
  return {
    schemaVersion: 3,
    version: plan.version,
    tag: plan.tag,
    commitSha: plan.commitSha,
    candidateId,
    candidateShaVerified: true,
    harnessSha256: 'c'.repeat(64),
    cleanSnapshot: true,
    windowsMlProvider: 'windowsml',
    configuredProvider: 'ollama',
    effectiveProvider: 'ollama',
    configuredModel: 'qwen3.5:4b',
    effectiveModel: 'qwen3.5:4b',
    providerFallback: false,
    modelFallback: false,
    generationReadyAtStart: true,
    resourcesReleasedAtEnd: true,
    fullExamQuestionCountPositive: true,
    sessionRestartPassed: true,
    sessionRestart: {
      passed: true,
      path: 'session-restart.json',
      bytes: statSync(sessionRestartPath).size,
      sha256: await sha256File(sessionRestartPath),
    },
    cancellation,
    processResidueCount: 0,
    acceptancePdfManifest: acceptancePdfFixture.evidenceReference,
    pdfs: acceptancePdfFixture.manifest.pdfs.map((pdf) => ({
      ...pdf,
      usableQuestions: 1,
      fullExamQuestionCount: 1,
    })),
    acceptance: {
      runId: acceptanceRunId,
      startedAt: '2026-07-11T01:00:01.000Z',
      completedAt: '2026-07-11T01:00:04.000Z',
      completed: true,
    },
    ...productionEvidence,
    recording: {
      path: 'acceptance.webm',
      captureSource: 'playwright_screencast',
      bytes: recording.length,
      sha256: recordingSha256,
      acceptanceRunId,
      startedAt: '2026-07-11T01:00:00.000Z',
      completedAt: '2026-07-11T01:00:05.000Z',
    },
  };
}

const validProbe = async () => ({
  ffprobeSha256: 'd'.repeat(64),
  probe: {
    format: { format_name: 'matroska,webm', duration: '5.000000' },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'vp9',
        width: 1280,
        height: 720,
        nb_read_frames: '150',
      },
    ],
  },
});

function verificationOptions(acceptancePdfFixture, overrides = {}) {
  return {
    expectedHarnessSha256: 'c'.repeat(64),
    acceptancePdfManifestPath: acceptancePdfFixture.manifestPath,
    acceptancePdfManifestSha256: acceptancePdfFixture.manifestSha256,
    probeRecording: validProbe,
    ...overrides,
  };
}

async function createVerifierFixture(root) {
  const evidenceRoot = join(root, 'evidence');
  mkdirSync(evidenceRoot, { recursive: true });
  const acceptancePdfFixture = await writeAcceptancePdfFixture(
    root,
    evidenceRoot,
  );
  const plan = deriveReleaseIdentity({
    eventName: 'workflow_dispatch',
    refName: 'main',
    requestedVersion: '0.1.0-alpha.1',
    repository: 'owner/cert-prep',
    commitSha: 'a'.repeat(40),
  });
  const planPath = join(root, 'plan.json');
  const resultPath = join(evidenceRoot, 'hardware-result.json');
  const recordingPath = join(evidenceRoot, 'acceptance.webm');
  const recording = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.from('recording'),
  ]);
  writeJson(planPath, plan);
  writeFileSync(recordingPath, recording);
  writeJson(
    resultPath,
    await hardwareResult(
      plan,
      evidenceRoot,
      recording,
      await sha256File(recordingPath),
      acceptancePdfFixture,
    ),
  );
  return {
    acceptancePdfFixture,
    evidenceRoot,
    planPath,
    resultPath,
  };
}

async function rewriteProductionSummary(fixture, mutate) {
  const result = JSON.parse(readFileSync(fixture.resultPath, 'utf8'));
  const productionSummaryPath = join(
    fixture.evidenceRoot,
    'production-summary.json',
  );
  const productionSummary = JSON.parse(
    readFileSync(productionSummaryPath, 'utf8'),
  );
  mutate(productionSummary);
  writeJson(productionSummaryPath, productionSummary);
  result.productionSummary.bytes = statSync(productionSummaryPath).size;
  result.productionSummary.sha256 = await sha256File(productionSummaryPath);
  writeJson(fixture.resultPath, result);
}

test('hardware verifier requires a contained digest-matched WebM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-hardware-evidence-'));
  try {
    const evidenceRoot = join(root, 'evidence');
    mkdirSync(evidenceRoot, { recursive: true });
    const acceptancePdfFixture = await writeAcceptancePdfFixture(
      root,
      evidenceRoot,
    );
    const plan = deriveReleaseIdentity({
      eventName: 'workflow_dispatch',
      refName: 'main',
      requestedVersion: '0.1.0-alpha.1',
      repository: 'owner/cert-prep',
      commitSha: 'a'.repeat(40),
    });
    const planPath = join(root, 'plan.json');
    const resultPath = join(evidenceRoot, 'hardware-result.json');
    const recordingPath = join(evidenceRoot, 'acceptance.webm');
    const recording = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from('recording'),
    ]);
    writeJson(planPath, plan);
    writeFileSync(recordingPath, recording);
    writeJson(
      resultPath,
      await hardwareResult(
        plan,
        evidenceRoot,
        recording,
        await sha256File(recordingPath),
        acceptancePdfFixture,
      ),
    );

    await assert.doesNotReject(() =>
      verifyHardwareEvidence(
        resultPath,
        planPath,
        evidenceRoot,
        'e'.repeat(64),
        verificationOptions(acceptancePdfFixture),
      ),
    );

    const invalidRoutingResult = JSON.parse(
      readFileSync(resultPath, 'utf8'),
    );
    const resourceSummaryPath = join(
      evidenceRoot,
      'windows-resource-summary.json',
    );
    const invalidResourceSummary = JSON.parse(
      readFileSync(resourceSummaryPath, 'utf8'),
    );
    invalidResourceSummary.named_target_process_gpu_usage[0].metrics.shared_usage.max =
      0;
    writeJson(resourceSummaryPath, invalidResourceSummary);
    invalidRoutingResult.gpuTelemetry.windowsResourceSummary.bytes =
      statSync(resourceSummaryPath).size;
    invalidRoutingResult.gpuTelemetry.windowsResourceSummary.sha256 =
      await sha256File(resourceSummaryPath);
    writeJson(resultPath, invalidRoutingResult);
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          candidateId,
          verificationOptions(acceptancePdfFixture),
        ),
      /detailed GPU usage does not match raw Windows GPU telemetry/,
    );

    const missingAmdResult = await hardwareResult(
      plan,
      evidenceRoot,
      recording,
      await sha256File(recordingPath),
      acceptancePdfFixture,
    );
    const dxgiPath = join(evidenceRoot, 'windows-dxgi-adapters.json');
    const missingAmdDxgi = JSON.parse(readFileSync(dxgiPath, 'utf8'));
    missingAmdDxgi.adapters = missingAmdDxgi.adapters.filter(
      (adapter) => adapter.adapter_kind !== 'amd_igpu',
    );
    writeJson(dxgiPath, missingAmdDxgi);
    missingAmdResult.gpuTelemetry.windowsDxgiAdapters.bytes =
      statSync(dxgiPath).size;
    missingAmdResult.gpuTelemetry.windowsDxgiAdapters.sha256 =
      await sha256File(dxgiPath);
    writeJson(resultPath, missingAmdResult);
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          candidateId,
          verificationOptions(acceptancePdfFixture),
        ),
      /lacks the required AMD iGPU/,
    );

    const staleDxgiResult = await hardwareResult(
      plan,
      evidenceRoot,
      recording,
      await sha256File(recordingPath),
      acceptancePdfFixture,
    );
    const staleDxgi = JSON.parse(readFileSync(dxgiPath, 'utf8'));
    staleDxgi.generated_at = '2026-07-10T01:00:01.250Z';
    writeJson(dxgiPath, staleDxgi);
    staleDxgiResult.gpuTelemetry.windowsDxgiAdapters.bytes =
      statSync(dxgiPath).size;
    staleDxgiResult.gpuTelemetry.windowsDxgiAdapters.sha256 =
      await sha256File(dxgiPath);
    writeJson(resultPath, staleDxgiResult);
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          candidateId,
          verificationOptions(acceptancePdfFixture),
        ),
      /timestamp is stale or invalid: gpuTelemetry\.windowsDxgiAdapters\.generated_at/,
    );

    const staleResult = await hardwareResult(
      plan,
      evidenceRoot,
      recording,
      await sha256File(recordingPath),
      acceptancePdfFixture,
    );
    const productionSummaryPath = join(evidenceRoot, 'production-summary.json');
    const staleProductionSummary = JSON.parse(
      readFileSync(productionSummaryPath, 'utf8'),
    );
    staleProductionSummary.generated_at = '2026-07-10T01:00:03.500Z';
    writeJson(productionSummaryPath, staleProductionSummary);
    staleResult.productionSummary.bytes = statSync(productionSummaryPath).size;
    staleResult.productionSummary.sha256 =
      await sha256File(productionSummaryPath);
    writeJson(resultPath, staleResult);
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          candidateId,
          verificationOptions(acceptancePdfFixture),
        ),
      /timestamp is stale or invalid: productionSummary\.generated_at/,
    );

    const reusedResult = await hardwareResult(
      plan,
      evidenceRoot,
      recording,
      await sha256File(recordingPath),
      acceptancePdfFixture,
    );
    reusedResult.cancellation.ocr = { ...reusedResult.cancellation.upload };
    writeJson(resultPath, reusedResult);
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          candidateId,
          verificationOptions(acceptancePdfFixture),
        ),
      /Hardware evidence path is reused/,
    );

    const invalidRecording = Buffer.from('not-webm');
    writeFileSync(recordingPath, invalidRecording);
    writeJson(
      resultPath,
      await hardwareResult(
        plan,
        evidenceRoot,
        invalidRecording,
        await sha256File(recordingPath),
        acceptancePdfFixture,
      ),
    );
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          'e'.repeat(64),
          verificationOptions(acceptancePdfFixture),
        ),
      /WebM EBML header/,
    );

    writeFileSync(recordingPath, recording);
    writeJson(
      resultPath,
      await hardwareResult(
        plan,
        evidenceRoot,
        recording,
        await sha256File(recordingPath),
        acceptancePdfFixture,
      ),
    );
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          'e'.repeat(64),
          verificationOptions(acceptancePdfFixture, {
            probeRecording: async () => ({
              ffprobeSha256: 'd'.repeat(64),
              probe: {
                format: { format_name: 'matroska,webm', duration: '5' },
                streams: [
                  {
                    codec_type: 'video',
                    codec_name: 'vp9',
                    width: 1280,
                    height: 720,
                    nb_frames: '150',
                  },
                ],
              },
            }),
          }),
        ),
      /playable WebM video/,
    );

    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          'e'.repeat(64),
          verificationOptions(acceptancePdfFixture, {
            expectedHarnessSha256: 'b'.repeat(64),
          }),
        ),
      /pinned acceptance harness/,
    );
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          'e'.repeat(64),
          verificationOptions(acceptancePdfFixture, {
            probeRecording: undefined,
            ffprobePath: recordingPath,
            ffprobeSha256: '0'.repeat(64),
          }),
        ),
      /ffprobe digest/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hardware verifier accepts CPU reasoning without discrete-GPU telemetry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-gpu-adapters-'));
  try {
    const fixture = await createVerifierFixture(root);
    await assert.doesNotReject(() =>
      verifyHardwareEvidence(
        fixture.resultPath,
        fixture.planPath,
        fixture.evidenceRoot,
        candidateId,
        verificationOptions(fixture.acceptancePdfFixture),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hardware verifier accepts auto execution without a GPU claim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-auto-execution-'));
  try {
    const fixture = await createVerifierFixture(root);
    await rewriteProductionSummary(fixture, (summary) => {
      summary.execution_mode = 'auto';
      summary.execution_warning = null;
      summary.llm_health.execution_mode = 'auto';
      summary.llm_health.execution_warning = null;
    });
    await assert.doesNotReject(() =>
      verifyHardwareEvidence(
        fixture.resultPath,
        fixture.planPath,
        fixture.evidenceRoot,
        candidateId,
        verificationOptions(fixture.acceptancePdfFixture),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hardware verifier rejects inconsistent execution warnings', async (t) => {
  const scenarios = [
    { name: 'CPU without warning', mode: 'cpu', warning: null },
    { name: 'auto with warning', mode: 'auto', warning: 'unexpected warning' },
    { name: 'unknown mode', mode: 'gpu', warning: null },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = mkdtempSync(join(tmpdir(), 'cert-prep-execution-warning-'));
      try {
        const fixture = await createVerifierFixture(root);
        await rewriteProductionSummary(fixture, (summary) => {
          summary.execution_mode = scenario.mode;
          summary.execution_warning = scenario.warning;
        });
        await assert.rejects(
          () =>
            verifyHardwareEvidence(
              fixture.resultPath,
              fixture.planPath,
              fixture.evidenceRoot,
              candidateId,
              verificationOptions(fixture.acceptancePdfFixture),
            ),
          /execution mode or warning is invalid/,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('hardware verifier rejects execution metadata that was not captured from health', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-execution-health-'));
  try {
    const fixture = await createVerifierFixture(root);
    await rewriteProductionSummary(fixture, (summary) => {
      summary.llm_health.execution_warning = 'contradictory health warning';
    });
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          fixture.resultPath,
          fixture.planPath,
          fixture.evidenceRoot,
          candidateId,
          verificationOptions(fixture.acceptancePdfFixture),
        ),
      /health execution metadata is inconsistent/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hardware verifier still rejects provider or model fallback', async (t) => {
  const scenarios = [
    {
      name: 'provider fallback',
      mutate: (summary) => {
        summary.provider_fallback_reason = 'provider changed';
      },
    },
    {
      name: 'model fallback',
      mutate: (summary) => {
        summary.model_fallback_reason = 'model changed';
        summary.fallback_reason = 'model changed';
      },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = mkdtempSync(join(tmpdir(), 'cert-prep-fallback-contract-'));
      try {
        const fixture = await createVerifierFixture(root);
        await rewriteProductionSummary(fixture, scenario.mutate);
        await assert.rejects(
          () =>
            verifyHardwareEvidence(
              fixture.resultPath,
              fixture.planPath,
              fixture.evidenceRoot,
              candidateId,
              verificationOptions(fixture.acceptancePdfFixture),
            ),
          /exact Ollama alpha contract/,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('hardware verifier rejects exact acceptance PDF input drift', async (t) => {
  const scenarios = [
    {
      name: 'missing input',
      pattern: /exact reviewed set/,
      mutate: ({ acceptancePdfFixture }) => {
        rmSync(acceptancePdfFixture.pdfPaths[0]);
      },
    },
    {
      name: 'extra input',
      pattern: /exact reviewed set/,
      mutate: ({ acceptancePdfFixture }) => {
        writeFileSync(join(acceptancePdfFixture.inputRoot, 'extra.pdf'), 'extra');
      },
    },
    {
      name: 'duplicate input',
      pattern: /exact reviewed set/,
      mutate: ({ acceptancePdfFixture }) => {
        writeFileSync(
          join(acceptancePdfFixture.inputRoot, 'duplicate.pdf'),
          readFileSync(acceptancePdfFixture.pdfPaths[0]),
        );
      },
    },
    {
      name: 'renamed input',
      pattern: /exact reviewed set/,
      mutate: ({ acceptancePdfFixture }) => {
        const original = acceptancePdfFixture.pdfPaths[0];
        writeFileSync(
          join(acceptancePdfFixture.inputRoot, 'renamed.pdf'),
          readFileSync(original),
        );
        rmSync(original);
      },
    },
    {
      name: 'byte drift',
      pattern: /byte count drifted/,
      mutate: ({ acceptancePdfFixture }) => {
        writeFileSync(
          acceptancePdfFixture.pdfPaths[0],
          'byte drift has a different length',
        );
      },
    },
    {
      name: 'digest drift',
      pattern: /digest drifted/,
      mutate: ({ acceptancePdfFixture }) => {
        const path = acceptancePdfFixture.pdfPaths[0];
        const bytes = Buffer.from(readFileSync(path));
        bytes[bytes.length - 1] ^= 0xff;
        writeFileSync(path, bytes);
      },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = mkdtempSync(join(tmpdir(), 'cert-prep-pdf-drift-'));
      try {
        const fixture = await createVerifierFixture(root);
        scenario.mutate(fixture);
        await assert.rejects(
          () =>
            verifyHardwareEvidence(
              fixture.resultPath,
              fixture.planPath,
              fixture.evidenceRoot,
              candidateId,
              verificationOptions(fixture.acceptancePdfFixture),
            ),
          scenario.pattern,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('hardware verifier compares the exact result set before question counts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-pdf-result-drift-'));
  try {
    const fixture = await createVerifierFixture(root);
    const result = JSON.parse(readFileSync(fixture.resultPath, 'utf8'));
    result.pdfs[0].fileName = 'renamed.pdf';
    result.pdfs[0].usableQuestions = 0;
    result.pdfs[0].fullExamQuestionCount = 0;
    writeJson(fixture.resultPath, result);
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          fixture.resultPath,
          fixture.planPath,
          fixture.evidenceRoot,
          candidateId,
          verificationOptions(fixture.acceptancePdfFixture),
        ),
      /reviewed manifest exact set/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hardware verifier rejects a protected manifest digest mismatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-pdf-manifest-drift-'));
  try {
    const fixture = await createVerifierFixture(root);
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          fixture.resultPath,
          fixture.planPath,
          fixture.evidenceRoot,
          candidateId,
          verificationOptions(fixture.acceptancePdfFixture, {
            acceptancePdfManifestSha256: '0'.repeat(64),
          }),
        ),
      /manifest digest/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
