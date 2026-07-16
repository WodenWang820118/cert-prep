import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  buildValidResilienceEvidence,
  buildValidSessionRestartEvidence,
} from '../../apps/cert-prep-desktop/scripts/packaged-resilience/evidence-fixtures.mts';

import {
  assembleCandidate,
  finalizeRelease,
  rejectFastFlowBinaryInArchive,
  validatePackageQa,
} from './assemble.ts';
import {
  HARDWARE_CANCELLATION_CHECKS,
  LOCAL_NONPUBLISHABLE_PROFILE,
  PUBLIC_UNSIGNED_ALPHA_PROFILE,
  deriveReleaseIdentity,
  listFiles,
  sha256File,
  writeJson,
} from './release-lib.ts';
import { validatePublishingInputs } from './publish-assets.ts';

async function writeHardwareProductionEvidence(hardware, candidateId) {
  const acceptanceRunId = 'acceptance-run-0001';
  const artifacts = {
    windows_summary_json: 'windows-resource-summary.json',
    windows_counters_csv: 'windows-resource-sampling.csv',
    windows_dxgi_adapters_json: 'windows-dxgi-adapters.json',
  };
  const amdLuid = '0x00000000_0x000136c5';
  const softwareLuid = '0x00000000_0x00000001';
  const unknownLuid = '0x00000000_0x00000002';
  const dxgiAdapters = [
    { luid: amdLuid, adapter_kind: 'amd_igpu' },
    { luid: softwareLuid, adapter_kind: 'software' },
    { luid: unknownLuid, adapter_kind: 'unknown' },
  ];
  const routing = {
    windowsml_ocr_process_observed: true,
    ocr_uses_amd_igpu: true,
    gpu_luid_map_usable: true,
  };
  writeJson(join(hardware, artifacts.windows_dxgi_adapters_json), {
    status: 'completed',
    generated_at: '2026-07-11T01:00:01.250Z',
    adapters: dxgiAdapters,
  });
  writeJson(join(hardware, artifacts.windows_summary_json), {
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
    join(hardware, artifacts.windows_counters_csv),
    `timestamp,source,path,pid,name,metric,value,unit\n"2026-07-11T01:00:02.000Z","windows_process","Win32_Process","42","cert-prep-ocr-windowsml-runtime.exe","working_set_bytes","1024","bytes"\n"2026-07-11T01:00:02.500Z","windows_process","Win32_Process","77","llama-server.exe","working_set_bytes","2048","bytes"\n"2026-07-11T01:00:03.000Z","windows_gpu_counter","\\\\MSI\\GPU Process Memory(pid_42_luid_${amdLuid}_phys_0)\\Shared Usage","","","\\\\MSI\\GPU Process Memory(pid_42_luid_${amdLuid}_phys_0)\\Shared Usage","8192","raw"\n`,
  );
  writeJson(join(hardware, 'production-summary.json'), {
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
    bytes: statSync(join(hardware, path)).size,
    sha256: await sha256File(join(hardware, path)),
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

test('candidate assembly proves hybrid runtime shape and writes release documents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-assemble-'));
  try {
    const workspace = join(root, 'workspace');
    const bundleRoot = join(root, 'bundle');
    const resources = join(root, 'generated-resources');
    const ocrRoot = join(root, 'ocr-runtime');
    const inventory = join(root, 'inventory');
    for (const path of [workspace, bundleRoot, resources, ocrRoot, inventory]) {
      mkdirSync(path, { recursive: true });
    }
    const plan = deriveReleaseIdentity({
      eventName: 'workflow_dispatch',
      refName: 'main',
      requestedVersion: '0.1.0-alpha.1',
      repository: 'owner/cert-prep',
      commitSha: 'a'.repeat(40),
    });
    const planPath = join(root, 'release-plan.json');
    writeJson(planPath, plan);
    writeFileSync(
      join(bundleRoot, 'Cert Prep_0.1.0-alpha.1_x64_en-US.msi'),
      'msi',
    );
    writeFileSync(
      join(bundleRoot, 'Cert Prep_0.1.0-alpha.1_x64-setup.exe'),
      'nsis',
    );

    const backendName = 'cert-prep-backend-runtime-0.1.0-alpha.1-x86_64.zip';
    const backendPath = join(resources, backendName);
    writeFileSync(backendPath, 'backend-runtime');
    writeJson(join(resources, 'backend-runtime-manifest.json'), {
      kind: 'python_backend',
      version: plan.version,
      target: plan.target,
      artifact: {
        file_name: backendName,
        bytes: Buffer.byteLength('backend-runtime'),
        sha256: await sha256File(backendPath),
        url: null,
      },
    });

    const ocrName = 'cert-prep-ocr-windowsml-runtime-0.1.0-alpha.1-x86_64.zip';
    const ocrPath = join(ocrRoot, ocrName);
    writeFileSync(ocrPath, 'ocr-runtime');
    const ocrManifest = {
      kind: 'windowsml_ocr',
      version: plan.version,
      target: plan.target,
      artifact: {
        file_name: ocrName,
        bytes: Buffer.byteLength('ocr-runtime'),
        sha256: await sha256File(ocrPath),
        url: `${plan.assetBaseUrl}/${ocrName}`,
      },
    };
    writeJson(
      join(resources, 'windowsml-ocr-runtime-manifest.json'),
      ocrManifest,
    );
    writeJson(
      join(ocrRoot, 'windowsml-ocr-runtime-manifest.json'),
      ocrManifest,
    );

    const packageQaPath = join(root, 'package-qa.json');
    writeJson(packageQaPath, {
      schema_version: 3,
      target: { rust_triple: plan.target },
      package: {
        resource_contract: {
          backend_bundled: true,
          windowsml_ocr_bundled: false,
          release_urls_only: true,
          distribution_profile: PUBLIC_UNSIGNED_ALPHA_PROFILE,
          publishable: true,
          version: plan.version,
          windows_msi_version: plan.windowsMsiVersion,
          python_runtime_version: plan.pythonRuntimeVersion,
          channel: plan.channel,
          signed: false,
        },
        size_gate: { status: 'passed' },
      },
    });
    for (const file of [
      'LICENSE',
      'PRIVACY.md',
      'CHANGELOG.md',
      'THIRD_PARTY_NOTICES.md',
    ]) {
      writeFileSync(join(workspace, file), `${file}\n`);
    }
    mkdirSync(join(workspace, 'tools', 'release'), { recursive: true });
    const acceptancePdfManifestBytes = readFileSync(
      join(import.meta.dirname, 'alpha-acceptance-pdf-manifest.json'),
    );
    const acceptancePdfManifest = JSON.parse(
      acceptancePdfManifestBytes.toString('utf8'),
    );
    writeFileSync(
      join(
        workspace,
        'tools',
        'release',
        'alpha-acceptance-pdf-manifest.json',
      ),
      acceptancePdfManifestBytes,
    );
    const payloadDeclaration = JSON.parse(
      readFileSync(
        join(import.meta.dirname, 'ocr-runtime-payload-declaration.json'),
        'utf8',
      ),
    );
    writeJson(
      join(
        workspace,
        'tools',
        'release',
        'ocr-runtime-payload-declaration.json',
      ),
      payloadDeclaration,
    );
    writeFileSync(
      join(workspace, 'tools', 'release', 'harness.txt'),
      'harness',
    );
    for (const harnessFile of [
      'assemble.ts',
      'release-lib.ts',
      'verify-hardware-result.ts',
    ]) {
      writeFileSync(
        join(workspace, 'tools', 'release', harnessFile),
        readFileSync(join(import.meta.dirname, harnessFile)),
      );
    }
    const resilienceContractPath = join(
      workspace,
      'apps',
      'cert-prep-desktop',
      'scripts',
      'packaged-resilience',
      'evidence-contract.mts',
    );
    mkdirSync(join(resilienceContractPath, '..'), { recursive: true });
    writeFileSync(
      resilienceContractPath,
      readFileSync(
        join(
          import.meta.dirname,
          '..',
          '..',
          'apps',
          'cert-prep-desktop',
          'scripts',
          'packaged-resilience',
          'evidence-contract.mts',
        ),
      ),
    );
    writeJson(join(inventory, 'node.json'), {
      MIT: [{ name: 'node-dependency', versions: ['1.0.0'], license: 'MIT' }],
    });
    writeJson(join(inventory, 'python.json'), [
      {
        name: 'python-dependency',
        version: '1.0.0',
        license: 'MIT',
        licenseTexts: [
          { name: 'LICENSE', text: 'MIT license text', primary: true },
        ],
      },
    ]);
    writeJson(join(inventory, 'ocr-python.json'), [
      {
        name: 'ocr-python-dependency',
        version: '1.0.0',
        license: 'Apache-2.0',
        licenseTexts: [
          {
            name: 'LICENSE',
            text: 'Apache license text',
            primary: true,
          },
        ],
      },
    ]);
    const payloadEntries = payloadDeclaration.payloadEntries.map(
      (path, index) => ({
        path,
        bytes: index + 1,
        sha256: String(index + 1).padStart(64, '0'),
      }),
    );
    const publicSources = payloadDeclaration.sourceArtifacts.map((source) => {
      const item = { ...source };
      delete item.payloadEntries;
      return item;
    });
    writeJson(join(inventory, 'ocr-runtime-payloads.json'), {
      schemaVersion: 1,
      artifact: {
        kind: 'windowsml_ocr',
        fileName: ocrName,
        bytes: ocrManifest.artifact.bytes,
        sha256: ocrManifest.artifact.sha256,
        manifestSha256: await sha256File(
          join(resources, 'windowsml-ocr-runtime-manifest.json'),
        ),
      },
      entrypoint: {
        path: payloadDeclaration.entrypoint,
        bytes: 10,
        sha256: 'f'.repeat(64),
      },
      entries: payloadEntries,
      components: [
        {
          ...payloadDeclaration.component,
          licenseTexts: [],
          sourceArtifacts: publicSources,
          files: payloadEntries,
        },
      ],
    });
    writeJson(join(inventory, 'cargo.json'), {
      packages: [
        {
          name: 'rust-dependency',
          version: '1.0.0',
          license: 'MIT',
          source: 'registry',
        },
      ],
    });

    const output = join(root, 'candidate');
    const result = await assembleCandidate({
      'workspace-root': workspace,
      plan: planPath,
      'bundle-root': bundleRoot,
      'generated-resources': resources,
      'ocr-runtime-root': ocrRoot,
      'package-qa': packageQaPath,
      'node-licenses': join(inventory, 'node.json'),
      'python-licenses': join(inventory, 'python.json'),
      'ocr-python-licenses': join(inventory, 'ocr-python.json'),
      'ocr-runtime-payloads': join(inventory, 'ocr-runtime-payloads.json'),
      'cargo-metadata': join(inventory, 'cargo.json'),
      output,
    });

    assert.match(result.candidateId, /^[0-9a-f]{64}$/);
    const candidateIdentity = JSON.parse(
      readFileSync(join(output, 'candidate.json'), 'utf8'),
    );
    assert.equal(
      candidateIdentity.distributionProfile,
      PUBLIC_UNSIGNED_ALPHA_PROFILE,
    );
    assert.equal(candidateIdentity.publishable, true);
    assert.equal(
      candidateIdentity.files.some((identity) =>
        identity.startsWith('harness/tools/release/'),
      ),
      true,
    );
    assert.equal(
      candidateIdentity.files.some((identity) =>
        identity.startsWith(
          'harness/apps/cert-prep-desktop/scripts/packaged-resilience/evidence-contract.mts:',
        ),
      ),
      true,
    );
    for (const [entrypoint, expectedError] of [
      [
        'verify-hardware-result.ts',
        /A pinned hardware harness SHA-256 is required/,
      ],
      ['assemble.ts', /--mode must be candidate or finalize/],
    ]) {
      const invocation = spawnSync(
        process.execPath,
        [join(output, 'harness', 'tools', 'release', entrypoint)],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(invocation.status, 1, invocation.stderr);
      assert.match(invocation.stderr, expectedError);
      assert.doesNotMatch(
        invocation.stderr,
        /ERR_MODULE_NOT_FOUND|Cannot find module/,
      );
    }
    assert.equal(
      readFileSync(join(output, 'release', 'runtimes', backendName), 'utf8'),
      'backend-runtime',
    );
    assert.equal(
      readFileSync(join(output, 'release', 'runtimes', ocrName), 'utf8'),
      'ocr-runtime',
    );
    assert.match(
      readFileSync(join(output, 'release', 'SHA256SUMS'), 'utf8'),
      /Cert Prep_/,
    );
    const metadata = JSON.parse(
      readFileSync(
        join(output, 'release', 'metadata', 'release-metadata.json'),
        'utf8',
      ),
    );
    assert.equal(metadata.channel, 'unsigned_public_alpha');
    assert.equal(
      metadata.artifacts.some((item) => item.fileName.endsWith('.spdx.json')),
      true,
    );
    const licenseInventory = JSON.parse(
      readFileSync(
        join(output, 'release', 'metadata', 'license-inventory.json'),
        'utf8',
      ),
    );
    assert.deepEqual(
      licenseInventory.artifactDependencies.map((item) => item.id),
      ['backend-runtime', 'msi', 'nsis', 'windowsml-ocr-runtime'],
    );
    for (const scope of licenseInventory.artifactDependencies) {
      const spdx = JSON.parse(
        readFileSync(
          join(
            output,
            'release',
            'metadata',
            `cert-prep-alpha-${scope.id}.spdx.json`,
          ),
          'utf8',
        ),
      );
      const cycloneDx = JSON.parse(
        readFileSync(
          join(
            output,
            'release',
            'metadata',
            `cert-prep-alpha-${scope.id}.cdx.json`,
          ),
          'utf8',
        ),
      );
      assert.equal(
        spdx.relationships.some(
          (relationship) => relationship.relationshipType === 'DEPENDS_ON',
        ),
        true,
      );
      assert.equal(cycloneDx.dependencies[0].dependsOn.length > 0, true);
      if (scope.id === 'windowsml-ocr-runtime') {
        assert.equal(
          spdx.files.filter((file) =>
            file.SPDXID.startsWith('SPDXRef-Payload-'),
          ).length,
          payloadDeclaration.payloadEntries.length,
        );
        assert.equal(
          cycloneDx.components.filter(
            (component) =>
              component.type === 'file' &&
              payloadDeclaration.payloadEntries.includes(component.name),
          ).length,
          payloadDeclaration.payloadEntries.length,
        );
      }
    }

    const hardware = join(root, 'hardware');
    const clean = join(root, 'clean');
    mkdirSync(hardware, { recursive: true });
    mkdirSync(clean, { recursive: true });
    const recordingPath = join(hardware, 'acceptance.webm');
    const recording = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from('recording'),
    ]);
    writeFileSync(recordingPath, recording);
    const candidate = {
      candidateId: result.candidateId,
      version: plan.version,
      tag: plan.tag,
      commitSha: plan.commitSha,
      harnessSha256: 'c'.repeat(64),
    };
    const cancellation = {};
    const cancellationRoot = join(hardware, 'cancellation');
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
    const sessionRestartPath = join(hardware, 'session-restart.json');
    writeJson(
      sessionRestartPath,
      buildValidSessionRestartEvidence({ candidate }),
    );
    const productionEvidence = await writeHardwareProductionEvidence(
      hardware,
      result.candidateId,
    );
    const acceptancePdfManifestPath = join(
      hardware,
      'alpha-acceptance-pdf-manifest.json',
    );
    writeFileSync(acceptancePdfManifestPath, acceptancePdfManifestBytes);
    const acceptancePdfManifestEvidence = {
      path: 'alpha-acceptance-pdf-manifest.json',
      bytes: statSync(acceptancePdfManifestPath).size,
      sha256: await sha256File(acceptancePdfManifestPath),
      candidateId: result.candidateId,
      acceptanceRunId: 'acceptance-run-0001',
    };
    writeJson(join(hardware, 'hardware-result.json'), {
      schemaVersion: 3,
      version: plan.version,
      tag: plan.tag,
      commitSha: plan.commitSha,
      candidateId: result.candidateId,
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
      acceptancePdfManifest: acceptancePdfManifestEvidence,
      pdfs: acceptancePdfManifest.pdfs.map((pdf) => ({
        ...pdf,
        usableQuestions: 1,
        fullExamQuestionCount: 1,
      })),
      acceptance: {
        runId: 'acceptance-run-0001',
        startedAt: '2026-07-11T01:00:01.000Z',
        completedAt: '2026-07-11T01:00:04.000Z',
        completed: true,
      },
      ...productionEvidence,
      recording: {
        path: 'acceptance.webm',
        captureSource: 'playwright_screencast',
        bytes: recording.length,
        sha256: await sha256File(recordingPath),
        acceptanceRunId: 'acceptance-run-0001',
        startedAt: '2026-07-11T01:00:00.000Z',
        completedAt: '2026-07-11T01:00:05.000Z',
      },
    });
    writeJson(join(hardware, 'recording-probe.json'), {
      schemaVersion: 1,
      acceptanceRunId: 'acceptance-run-0001',
      recording: {
        path: 'acceptance.webm',
        bytes: recording.length,
        sha256: await sha256File(recordingPath),
      },
      ffprobe: { sha256: 'd'.repeat(64) },
      formatNames: ['matroska', 'webm'],
      durationSeconds: 5,
      video: { codec: 'vp9', width: 1280, height: 720, frameCount: 150 },
    });
    for (const [kind, installerName] of [
      ['msi', 'Cert Prep_0.1.0-alpha.1_x64_en-US.msi'],
      ['nsis', 'Cert Prep_0.1.0-alpha.1_x64-setup.exe'],
    ]) {
      const installerPath = join(
        output,
        'release',
        'installers',
        installerName,
      );
      writeJson(join(clean, `clean-install-${kind}.json`), {
        schemaVersion: 1,
        packageKind: kind,
        version: plan.version,
        tag: plan.tag,
        commitSha: plan.commitSha,
        candidateId: result.candidateId,
        installer: installerName,
        installerSha256: await sha256File(installerPath),
        backendBundled: true,
        ocrBundled: false,
        publicOcrDownloadVerified: true,
        appLaunchVerified: true,
        freshAppDataVerified: true,
        backendInstallVerified: true,
        backendHealthVerified: true,
        backendVersion: plan.version,
        backendRuntimeMode: 'packaged',
        backendPythonVersion: '3.12.12',
        backendExecutable: 'cert-prep-backend.exe',
        backendPort: 43123,
      });
    }
    const finalOutput = join(root, 'final');
    const legacyNvidiaArtifact = join(hardware, 'nvidia-smi.csv');
    writeFileSync(legacyNvidiaArtifact, 'legacy telemetry');
    await assert.rejects(
      () =>
        finalizeRelease({
          candidate: output,
          'clean-evidence': clean,
          'hardware-evidence': hardware,
          output: finalOutput,
        }),
      /missing or undeclared files/,
    );
    rmSync(legacyNvidiaArtifact);
    await finalizeRelease({
      candidate: output,
      'clean-evidence': clean,
      'hardware-evidence': hardware,
      output: finalOutput,
    });
    const finalMetadata = JSON.parse(
      readFileSync(
        join(finalOutput, 'release', 'metadata', 'release-metadata.json'),
        'utf8',
      ),
    );
    assert.equal(finalMetadata.evidence.candidateId, result.candidateId);
    assert.equal(
      finalMetadata.evidence.hardware,
      'passed-cert-prep-alpha-hardware',
    );
    assert.equal(
      finalMetadata.evidence.productionSummarySha256,
      productionEvidence.productionSummary.sha256,
    );
    assert.equal(
      finalMetadata.evidence.acceptancePdfManifestSha256,
      acceptancePdfManifestEvidence.sha256,
    );
    assert.deepEqual(
      finalMetadata.evidence.gpuTelemetryReports,
      Object.fromEntries(
        Object.entries(productionEvidence.gpuTelemetry).map(([key, record]) => [
          key,
          record.sha256,
        ]),
      ),
    );
    const finalReleaseRoot = join(finalOutput, 'release');
    const finalPublishArgs = {
      mode: 'final',
      'candidate-root': output,
      'candidate-id': result.candidateId,
      'release-root': finalReleaseRoot,
      plan: join(finalReleaseRoot, 'metadata', 'release-plan.json'),
    };
    await assert.doesNotReject(validatePublishingInputs(finalPublishArgs));

    const injectedFinalFile = join(finalReleaseRoot, 'injected.exe');
    writeFileSync(injectedFinalFile, 'injected');
    await assert.rejects(
      () => validatePublishingInputs(finalPublishArgs),
      /missing or undeclared files/,
    );
    rmSync(injectedFinalFile);

    const finalLicensePath = join(finalReleaseRoot, 'legal', 'LICENSE');
    const originalFinalLicense = readFileSync(finalLicensePath);
    writeFileSync(finalLicensePath, 'changed license');
    await assert.rejects(
      () => validatePublishingInputs(finalPublishArgs),
      /artifact does not match metadata: legal\/LICENSE/,
    );
    writeFileSync(finalLicensePath, originalFinalLicense);

    const finalChecksumsPath = join(finalReleaseRoot, 'SHA256SUMS');
    const originalFinalChecksums = readFileSync(finalChecksumsPath, 'utf8');
    writeFileSync(finalChecksumsPath, `${'0'.repeat(64)} *bogus.txt\n`);
    await assert.rejects(
      () => validatePublishingInputs(finalPublishArgs),
      /SHA256SUMS does not cover the exact release files/,
    );
    writeFileSync(finalChecksumsPath, originalFinalChecksums);

    const finalMetadataPath = join(
      finalReleaseRoot,
      'metadata',
      'release-metadata.json',
    );
    const originalFinalMetadata = readFileSync(finalMetadataPath, 'utf8');
    writeFileSync(finalLicensePath, 'candidate drift');
    const driftedMetadata = JSON.parse(originalFinalMetadata);
    const licenseArtifact = driftedMetadata.artifacts.find(
      (artifact) => artifact.path === 'legal/LICENSE',
    );
    licenseArtifact.bytes = statSync(finalLicensePath).size;
    licenseArtifact.sha256 = await sha256File(finalLicensePath);
    writeJson(finalMetadataPath, driftedMetadata);
    await rewriteChecksums(finalReleaseRoot);
    await assert.rejects(
      () => validatePublishingInputs(finalPublishArgs),
      /changed candidate file: legal\/LICENSE/,
    );
    writeFileSync(finalLicensePath, originalFinalLicense);
    writeFileSync(finalMetadataPath, originalFinalMetadata);
    writeFileSync(finalChecksumsPath, originalFinalChecksums);

    const cleanMsiPath = join(clean, 'clean-install-msi.json');
    const cleanMsi = JSON.parse(readFileSync(cleanMsiPath, 'utf8'));
    writeJson(cleanMsiPath, { ...cleanMsi, candidateId: '0'.repeat(64) });
    await assert.rejects(
      () =>
        finalizeRelease({
          candidate: output,
          'clean-evidence': clean,
          'hardware-evidence': hardware,
          output: join(root, 'invalid-clean-final'),
        }),
      /Clean-install evidence contract failed: msi/,
    );
    writeJson(cleanMsiPath, cleanMsi);

    const extraCandidateFile = join(
      output,
      'release',
      'injected-but-undeclared.txt',
    );
    writeFileSync(extraCandidateFile, 'undeclared');
    await assert.rejects(
      () =>
        finalizeRelease({
          candidate: output,
          'clean-evidence': clean,
          'hardware-evidence': hardware,
          output: join(root, 'extra-candidate-final'),
        }),
      /does not exactly cover release and harness files/,
    );
    rmSync(extraCandidateFile);

    writeFileSync(
      join(output, 'harness', 'tools', 'release', 'harness.txt'),
      'tampered harness',
    );
    await assert.rejects(
      () =>
        finalizeRelease({
          candidate: output,
          'clean-evidence': clean,
          'hardware-evidence': hardware,
          output: join(root, 'invalid-harness-final'),
        }),
      /Candidate file identity does not match/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function rewriteChecksums(releaseRoot) {
  const files = listFiles(releaseRoot)
    .filter((path) => basename(path) !== 'SHA256SUMS')
    .sort();
  const lines = [];
  for (const path of files) {
    lines.push(`${await sha256File(path)} *${basename(path)}`);
  }
  writeFileSync(join(releaseRoot, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

test('archive gate rejects redistributed FastFlow executables', () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-fastflow-archive-'));
  try {
    const archive = join(root, 'runtime.zip');
    writeFileSync(
      archive,
      Buffer.from('PK\u0003\u0004runtime/flm.exe\u0000payload', 'latin1'),
    );
    assert.throws(
      () => rejectFastFlowBinaryInArchive(archive),
      /must not be redistributed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package QA accepts only exact public or local distribution pairs', () => {
  const publicPlan = deriveReleaseIdentity({
    eventName: 'workflow_dispatch',
    refName: 'main',
    requestedVersion: '0.1.0-alpha.1',
    repository: 'owner/cert-prep',
    commitSha: 'a'.repeat(40),
  });
  const publicReport = packageQaFixture(publicPlan, {
    release_urls_only: true,
    distribution_profile: PUBLIC_UNSIGNED_ALPHA_PROFILE,
    publishable: true,
    channel: publicPlan.channel,
  });
  assert.doesNotThrow(() => validatePackageQa(publicReport, publicPlan));
  assert.throws(
    () =>
      validatePackageQa(
        {
          ...publicReport,
          package: {
            ...publicReport.package,
            resource_contract: {
              ...publicReport.package.resource_contract,
              publishable: false,
            },
          },
        },
        publicPlan,
      ),
    /unsigned hybrid alpha contract/,
  );

  const localPlan = {
    ...publicPlan,
    channel: LOCAL_NONPUBLISHABLE_PROFILE,
    distributionProfile: LOCAL_NONPUBLISHABLE_PROFILE,
    publishable: false,
    tag: 'cert-prep-local-v0.1.0-alpha.1-aaaaaaaaaaaa',
    repository: 'local/nonpublishable',
    assetBaseUrl: 'file:///C:/cert-prep-local-runtime',
  };
  const localReport = packageQaFixture(localPlan, {
    release_urls_only: false,
    local_file_ocr_only: true,
    distribution_profile: LOCAL_NONPUBLISHABLE_PROFILE,
    publishable: false,
    channel: LOCAL_NONPUBLISHABLE_PROFILE,
  });
  assert.doesNotThrow(() => validatePackageQa(localReport, localPlan));
  assert.throws(
    () =>
      validatePackageQa(localReport, {
        ...localPlan,
        assetBaseUrl: publicPlan.assetBaseUrl,
      }),
    /exact supported distribution profile/,
  );
  assert.throws(
    () =>
      validatePackageQa(
        {
          ...localReport,
          package: {
            ...localReport.package,
            resource_contract: {
              ...localReport.package.resource_contract,
              distribution_profile: PUBLIC_UNSIGNED_ALPHA_PROFILE,
            },
          },
        },
        localPlan,
      ),
    /local nonpublishable candidate contract/,
  );
});

test('finalizer rejects local and mismatched candidates before touching output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-finalize-guard-'));
  try {
    const output = join(root, 'output');
    mkdirSync(output);
    const sentinel = join(output, 'sentinel.txt');
    writeFileSync(sentinel, 'keep');
    const localPlan = {
      schemaVersion: 1,
      channel: LOCAL_NONPUBLISHABLE_PROFILE,
      version: '0.1.0-alpha.1',
      tag: 'cert-prep-local-v0.1.0-alpha.1-aaaaaaaaaaaa',
      repository: 'local/nonpublishable',
      commitSha: 'a'.repeat(40),
      target: 'x86_64-pc-windows-msvc',
      assetBaseUrl: 'file:///C:/cert-prep-local-runtime',
      signed: false,
      distributionProfile: LOCAL_NONPUBLISHABLE_PROFILE,
      publishable: false,
    };
    const localCandidate = join(root, 'local-candidate');
    await writeMinimalCandidate(localCandidate, localPlan);
    await assert.rejects(
      () => finalizeRelease({ candidate: localCandidate, output }),
      /cannot be finalized or published/,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');

    const publicPlan = deriveReleaseIdentity({
      eventName: 'workflow_dispatch',
      refName: 'main',
      requestedVersion: '0.1.0-alpha.1',
      repository: 'owner/cert-prep',
      commitSha: 'a'.repeat(40),
    });
    const mismatchedCandidate = join(root, 'mismatched-candidate');
    await writeMinimalCandidate(mismatchedCandidate, publicPlan, {
      repository: 'other/cert-prep',
    });
    await assert.rejects(
      () => finalizeRelease({ candidate: mismatchedCandidate, output }),
      /does not match release plan: repository/,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function packageQaFixture(plan, contract) {
  return {
    schema_version: 3,
    target: { rust_triple: plan.target },
    package: {
      resource_contract: {
        backend_bundled: true,
        windowsml_ocr_bundled: false,
        version: plan.version,
        windows_msi_version: plan.windowsMsiVersion,
        python_runtime_version: plan.pythonRuntimeVersion,
        signed: false,
        ...contract,
      },
      size_gate: { status: 'passed' },
    },
  };
}

async function writeMinimalCandidate(root, plan, candidateOverrides = {}) {
  const releasePlanPath = join(
    root,
    'release',
    'metadata',
    'release-plan.json',
  );
  const harnessPath = join(root, 'harness', 'harness.txt');
  mkdirSync(join(root, 'release', 'metadata'), { recursive: true });
  mkdirSync(join(root, 'harness'), { recursive: true });
  writeJson(releasePlanPath, plan);
  writeFileSync(harnessPath, 'harness');
  const files = [
    `harness/harness.txt:${await sha256File(harnessPath)}`,
    `release/metadata/release-plan.json:${await sha256File(releasePlanPath)}`,
  ].sort();
  const candidateId = createHash('sha256')
    .update(files.join('\n'))
    .digest('hex');
  writeJson(join(root, 'candidate.json'), {
    schemaVersion: 1,
    candidateId,
    version: plan.version,
    tag: plan.tag,
    repository: plan.repository,
    commitSha: plan.commitSha,
    distributionProfile: plan.distributionProfile,
    publishable: plan.publishable,
    files,
    ...candidateOverrides,
  });
}
