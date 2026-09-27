import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureRuntimeInstallationCompleted,
  parseAcceptanceOcrPreflight,
  parseInstalledRuntimeTupleAttestation,
  pythonRuntimeReadyPattern,
  pythonRuntimeStartupState,
} from './runtime-install-flow.mts';

test('Capture Runtime installation accepts its completed terminal status', () => {
  assert.equal(captureRuntimeInstallationCompleted('completed'), true);
  assert.equal(captureRuntimeInstallationCompleted('succeeded'), true);
  assert.equal(captureRuntimeInstallationCompleted('running'), false);
  assert.equal(captureRuntimeInstallationCompleted(null), false);
});

test('python runtime readiness requires a backend-ready detail', () => {
  for (const text of [
    'Projects',
    'Select or create a project',
    'Workspace ready',
    'Python 3.12',
    'Python backend runtime installation queued.',
    'Status: Python backend runtime is ready.',
    'Python backend runtime is ready. Continue',
    'Python 3.12.12 / development',
  ]) {
    assert.equal(pythonRuntimeReadyPattern().test(text), false, text);
  }

  for (const text of [
    'Python backend runtime is ready.',
    'Python backend runtime is running.',
    'Python backend runtime is already running.',
    'Python 3.12.12 / packaged',
  ]) {
    assert.equal(pythonRuntimeReadyPattern().test(text), true, text);
  }

  assert.equal(
    pythonRuntimeReadyPattern().test(
      'Python backend\r\n  Python backend runtime is ready.  \r\nOllama',
    ),
    true,
  );
});

test('python runtime startup state waits through the initial shell race', () => {
  assert.equal(pythonRuntimeStartupState('Cert Prep\nProjects'), 'pending');
  assert.equal(
    pythonRuntimeStartupState(
      'Python backend runtime is not installed.\nInstall runtime',
    ),
    'installable',
  );
  assert.equal(
    pythonRuntimeStartupState(
      'Python backend runtime is ready.\nInstall runtime',
    ),
    'ready',
  );
});

test('Phase 1 OCR preflight requires the authenticated GPU and exact worker identity', () => {
  const expected = {
    runtimeArtifactSha256: 'a'.repeat(64),
    contractSetSha256: 'b'.repeat(64),
    workerArchiveSha256: 'c'.repeat(64),
    workerExecutableSha256: 'd'.repeat(64),
    preflightMode: 'gpu-dml' as const,
  };

  assert.deepEqual(
    parseAcceptanceOcrPreflight(
      {
        ready: true,
        ocrCompute: {
          mode: 'gpu-dml',
          contractSha256: expected.contractSetSha256,
          workerSha256: expected.workerExecutableSha256,
        },
      },
      expected,
    ),
    {
      mode: 'gpu-dml',
      contract_sha256: expected.contractSetSha256,
      worker_sha256: expected.workerExecutableSha256,
      ui_gpu_before_import: false,
      source_import_enabled: false,
    },
  );

  assert.throws(
    () =>
      parseAcceptanceOcrPreflight(
        {
          ready: true,
          ocrCompute: {
            mode: 'cpu-fallback',
            contractSha256: expected.contractSetSha256,
            workerSha256: expected.workerExecutableSha256,
          },
        },
        expected,
      ),
    /CPU fallback/u,
  );
  assert.throws(
    () =>
      parseAcceptanceOcrPreflight(
        {
          ready: true,
          ocrCompute: {
            mode: 'gpu-dml',
            contractSha256: expected.contractSetSha256,
            workerSha256: 'e'.repeat(64),
          },
        },
        expected,
      ),
    /worker SHA does not match/u,
  );
});

test('installed-app attestation binds wheel, staged runtime, worker, contract and live handshake', () => {
  const expected = {
    runtimeArtifactSha256: 'a'.repeat(64),
    contractSetSha256: 'b'.repeat(64),
    workerArchiveSha256: 'c'.repeat(64),
    workerExecutableSha256: 'd'.repeat(64),
    preflightMode: 'gpu-dml' as const,
    installedExecutableSha256: 'e'.repeat(64),
    installedRuntimeManifestIdentitySha256: 'f'.repeat(64),
    installedRuntimeCoreSha256: 'a'.repeat(64),
    installedRuntimeCoreBytes: 12,
  };
  const payload = {
    schema_version: 1,
    candidate: {
      runtime_version: '0.4.2',
      runtime_core_sha256: expected.runtimeArtifactSha256,
      runtime_core_bytes: expected.installedRuntimeCoreBytes,
      runtime_manifest_identity_sha256: expected.installedRuntimeManifestIdentitySha256,
      worker_archive_sha256: expected.workerArchiveSha256,
      worker_archive_bytes: 34,
      worker_executable_sha256: expected.workerExecutableSha256,
      contract_set_sha256: expected.contractSetSha256,
      python_wheel: {
        file_name: 'capture_runtime_client-0.4.2-py3-none-any.whl',
        sha256: '1'.repeat(64),
        bytes: 56,
        package_name: 'capture-runtime-client',
        package_version: '0.4.2',
        contract_set_sha256: expected.contractSetSha256,
        generated_models: { worker_sha256: true, pdf_page_numbers: true },
      },
    },
    observed: {
      ready: true,
      runtime_version: '0.4.2',
      api_version: '2.0',
      capture_document_schema_version: '2',
      contract_set_sha256: expected.contractSetSha256,
      worker_executable_sha256: expected.workerExecutableSha256,
      mode: 'gpu-dml',
    },
  };

  const attestation = parseInstalledRuntimeTupleAttestation(payload, expected);
  assert.equal(attestation.candidate.python_wheel.contract_set_sha256, expected.contractSetSha256);
  assert.equal(attestation.observed.mode, 'gpu-dml');

  assert.throws(
    () =>
      parseInstalledRuntimeTupleAttestation(
        {
          ...payload,
          candidate: {
            ...payload.candidate,
            worker_archive_sha256: '9'.repeat(64),
          },
        },
        expected,
      ),
    /candidate tuple did not match/u,
  );
});
