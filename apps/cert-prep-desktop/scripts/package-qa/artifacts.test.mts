import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateCaptureArtifactBytes } from '../capture-runtime-contract.mts';
import { CAPTURE_DOCUMENT_SCHEMA_SHA256 } from './constants.mts';
import { bytesToMb, collectBundleArtifacts } from './files.mts';
import { validatePackagedResourceContract } from './resource-contract.mts';
import { createPackageQaReport, validateBundleArtifacts } from './report.mts';

const tempRoots: string[] = [];
const canonicalSchemaFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../test-fixtures/capture-document-v1.schema.json',
);

afterEach(() => {
  while (tempRoots.length > 0) {
    const tempRoot = tempRoots.pop();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

test('collectBundleArtifacts records sorted relative paths and sizes', () => {
  const workspaceRoot = makeTempWorkspace();
  const bundleRoot = join(
    workspaceRoot,
    'apps/cert-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle',
  );
  const nsisDir = join(bundleRoot, 'nsis');
  mkdirSync(nsisDir, { recursive: true });
  writeFileSync(
    join(nsisDir, 'Cert Prep_0.1.0_x64-setup.exe'),
    Buffer.alloc(2048),
  );

  const artifacts = collectBundleArtifacts(bundleRoot, workspaceRoot);

  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    [
      'apps/cert-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Cert Prep_0.1.0_x64-setup.exe',
    ],
  );
  assert.deepEqual(
    artifacts.map((artifact) => artifact.bytes),
    [2048],
  );
  assert.equal(bytesToMb(1024 * 1024 * 1.5), 1.5);
});

test('bundle gate requires exactly one alpha NSIS installer', () => {
  const workspaceRoot = makeTempWorkspace();
  const bundleRoot = join(workspaceRoot, 'bundle');
  const nsisRoot = join(bundleRoot, 'nsis');
  mkdirSync(nsisRoot, { recursive: true });
  writeFileSync(
    join(nsisRoot, 'Cert Prep_0.1.0-alpha.1_x64-setup.exe'),
    'nsis',
  );
  validateBundleArtifacts(collectBundleArtifacts(bundleRoot, workspaceRoot));

  writeFileSync(join(nsisRoot, 'Cert Prep_0.1.0_x64-setup.exe'), 'stale');
  assert.throws(
    () =>
      validateBundleArtifacts(
        collectBundleArtifacts(bundleRoot, workspaceRoot),
      ),
    /stale or unexpected bundles/,
  );
});

test('package QA shares the bounded Capture executable bytes contract', () => {
  for (const bytes of [1, 536_870_912]) {
    assert.equal(
      validateCaptureArtifactBytes(
        bytes,
        'Packaged Capture runtime executable',
      ),
      bytes,
    );
  }
  for (const bytes of [
    0,
    536_870_913,
    1.5,
    '15',
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        validateCaptureArtifactBytes(
          bytes,
          'Packaged Capture runtime executable',
        ),
      /bytes must be between 1 and 536870912/,
    );
  }
});

test('packaged resource contract proves hybrid resources and rejects dev references', async () => {
  const workspaceRoot = makeTempWorkspace();
  const resourceRoot = join(workspaceRoot, 'release', 'resources');
  mkdirSync(resourceRoot, { recursive: true });
  const backendName =
    'cert-prep-backend-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip';
  const ocrName =
    'cert-prep-ocr-windowsml-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip';
  writeFileSync(join(resourceRoot, backendName), 'runtime');
  const backendManifestPath = join(
    resourceRoot,
    'backend-runtime-manifest.json',
  );
  writeFileSync(
    backendManifestPath,
    JSON.stringify({
      kind: 'python_backend',
      version: '0.1.0-alpha.1',
      target: 'x86_64-pc-windows-msvc',
      entrypoint: 'backend.exe',
      artifact: {
        file_name: backendName,
        sha256: sha256('runtime'),
        bytes: Buffer.byteLength('runtime'),
        url: null,
      },
    }),
  );
  const ocrManifestPath = join(
    resourceRoot,
    'windowsml-ocr-runtime-manifest.json',
  );
  writeFileSync(
    ocrManifestPath,
    JSON.stringify({
      kind: 'windowsml_ocr',
      version: '0.1.0-alpha.1',
      target: 'x86_64-pc-windows-msvc',
      entrypoint: 'ocr.exe',
      artifact: {
        file_name: ocrName,
        sha256: sha256('ocr'),
        bytes: Buffer.byteLength('ocr'),
        url: `https://github.com/example/cert-prep/releases/download/cert-prep-v0.1.0-alpha.1/${ocrName}`,
      },
    }),
  );
  const captureName = 'capture-runtime-x86_64-pc-windows-msvc.exe';
  const captureSchemaName = 'capture-document-v1.schema.json';
  const captureSchema = canonicalCaptureDocumentSchemaBytes();
  assert.equal(sha256(captureSchema), CAPTURE_DOCUMENT_SCHEMA_SHA256);
  writeFileSync(join(resourceRoot, captureName), 'capture-runtime');
  writeFileSync(join(resourceRoot, captureSchemaName), captureSchema);
  const captureManifestPath = join(
    resourceRoot,
    'capture-runtime-manifest.json',
  );
  writeFileSync(
    captureManifestPath,
    JSON.stringify({
      manifestVersion: '1',
      runtimeVersion: '0.1.0',
      apiVersion: '1.0',
      captureDocumentSchemaVersion: '1',
      platform: 'windows',
      arch: 'x86_64',
      fileName: captureName,
      bytes: Buffer.byteLength('capture-runtime'),
      sha256: sha256('capture-runtime'),
      schemaFileName: captureSchemaName,
      schemaSha256: CAPTURE_DOCUMENT_SCHEMA_SHA256,
      runtimeRequirements: {
        'windowsml-ocr': {
          artifactUrl:
            'https://github.com/example/capture-workbench/releases/download/v0.1.0/capture-windowsml-ocr-v1.zip',
          artifactFileName: 'capture-windowsml-ocr-v1.zip',
          bytes: 123_456,
          sha256: '2'.repeat(64),
        },
      },
    }),
  );
  writeFileSync(
    join(resourceRoot, 'release-metadata.json'),
    JSON.stringify({
      schema_version: 1,
      version: '0.1.0-alpha.1',
      python_runtime_version: '3.12',
      release_tag: 'cert-prep-v0.1.0-alpha.1',
      channel: 'unsigned_public_alpha',
      distribution_profile: 'public_unsigned_alpha',
      publishable: true,
      distribution_mode: 'release',
      signed: false,
      warnings: {
        smartscreen: 'Unsigned public Alpha.',
        production_ready: false,
      },
      sha256_verification: { required: true, algorithm: 'SHA-256' },
      runtime_assets: {
        backend: {
          distribution: 'bundled',
          file_name: backendName,
          sha256: sha256('runtime'),
          bytes: Buffer.byteLength('runtime'),
        },
        windowsml_ocr: {
          distribution: 'github_release_download',
          file_name: ocrName,
          sha256: sha256('ocr'),
          bytes: Buffer.byteLength('ocr'),
        },
        capture_runtime: {
          distribution: 'explicit_staged_artifact',
          file_name: captureName,
          runtime_version: '0.1.0',
          api_version: '1.0',
          capture_document_schema_version: '1',
          sha256: sha256('capture-runtime'),
          bytes: Buffer.byteLength('capture-runtime'),
          schema_file_name: captureSchemaName,
          schema_sha256: CAPTURE_DOCUMENT_SCHEMA_SHA256,
          structuring_mode: 'host',
          runtime_requirements: {
            'windowsml-ocr': {
              artifactUrl:
                'https://github.com/example/capture-workbench/releases/download/v0.1.0/capture-windowsml-ocr-v1.zip',
              artifactFileName: 'capture-windowsml-ocr-v1.zip',
              bytes: 123_456,
              sha256: '2'.repeat(64),
            },
          },
        },
      },
    }),
  );
  const legalRoot = join(workspaceRoot, 'release', 'legal');
  mkdirSync(legalRoot, { recursive: true });
  for (const name of [
    'LICENSE',
    'PRIVACY.md',
    'CHANGELOG.md',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    writeFileSync(join(legalRoot, name), name);
  }
  const tauriConfig = join(workspaceRoot, 'tauri.conf.json');
  writeFileSync(
    tauriConfig,
    JSON.stringify({
      bundle: {
        targets: ['nsis'],
        resources: {
          'generated-resources/*': 'resources/',
          '../../../LICENSE': 'legal/LICENSE',
          '../../../PRIVACY.md': 'legal/PRIVACY.md',
          '../../../CHANGELOG.md': 'legal/CHANGELOG.md',
          '../../../THIRD_PARTY_NOTICES.md': 'legal/THIRD_PARTY_NOTICES.md',
        },
      },
    }),
  );

  const contract = validatePackagedResourceContract({
    resourceRoot,
    tauriConfig,
    workspaceRoot,
  });

  assert.equal(contract.backend_bundled, true);
  assert.equal(contract.windowsml_ocr_bundled, false);
  assert.equal(contract.capture_runtime_bundled, true);
  assert.equal(contract.capture_structuring_mode, 'host');
  assert.equal(contract.evidence_scope, 'static_tauri_release_resources');
  assert.equal(contract.installer_contents_verified, false);
  assert.equal(contract.fresh_install_verified, false);
  assert.equal(contract.alpha_release_gate, 'blocked_pending_clean_install');
  assert.equal(contract.resource_files.length, 7);
  assert.equal(contract.legal_files.length, 4);
  assert.equal(contract.channel, 'unsigned_public_alpha');
  assert.equal(contract.python_runtime_version, '3.12');
  assert.equal(contract.target, 'x86_64-pc-windows-msvc');

  const bundleRoot = join(workspaceRoot, 'bundle');
  mkdirSync(join(bundleRoot, 'nsis'), { recursive: true });
  writeFileSync(
    join(bundleRoot, 'nsis', 'Cert Prep_0.1.0-alpha.1_x64-setup.exe'),
    'nsis',
  );
  const report = await createPackageQaReport({
    workspaceRoot,
    bundleRoot,
    packagedResourceRoot: resourceRoot,
    tauriConfig,
  });
  assert.deepEqual(report.assessment, {
    status: 'blocked',
    evidence_scope: 'static_tauri_release_resources',
    blockers: ['installer_contents_not_verified', 'fresh_install_not_verified'],
  });
  const publishedContract = report.package
    .resource_contract as unknown as Record<string, unknown>;
  assert.equal(publishedContract.distribution_profile, 'public_unsigned_alpha');
  assert.equal(publishedContract.publishable, true);

  const packagedCaptureManifest = JSON.parse(
    readFileSync(captureManifestPath, 'utf8'),
  );
  for (const bytes of [
    0,
    536_870_913,
    1.5,
    '15',
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    writeFileSync(
      captureManifestPath,
      JSON.stringify({ ...packagedCaptureManifest, bytes }),
    );
    assert.throws(
      () =>
        validatePackagedResourceContract({
          resourceRoot,
          tauriConfig,
          workspaceRoot,
        }),
      /Packaged Capture runtime executable bytes must be between 1 and 536870912/,
    );
  }
  writeFileSync(captureManifestPath, JSON.stringify(packagedCaptureManifest));

  writeFileSync(
    ocrManifestPath,
    JSON.stringify({
      kind: 'windowsml_ocr',
      version: '0.1.0-alpha.1',
      target: 'x86_64-pc-windows-msvc',
      entrypoint: 'ocr.exe',
      artifact: {
        file_name: ocrName,
        sha256: sha256('ocr'),
        bytes: Buffer.byteLength('ocr'),
        url: 'file:///C:/software-dev/cert-prep/ocr.zip',
      },
    }),
  );
  assert.throws(
    () =>
      validatePackagedResourceContract({
        resourceRoot,
        tauriConfig,
        workspaceRoot,
      }),
    /versioned GitHub Release URL/,
  );

  writeFileSync(
    ocrManifestPath,
    JSON.stringify({
      kind: 'windowsml_ocr',
      version: '0.1.0-alpha.1',
      target: 'x86_64-pc-windows-msvc',
      entrypoint: 'ocr.exe',
      artifact: {
        file_name: ocrName,
        sha256: sha256('ocr'),
        bytes: Buffer.byteLength('ocr'),
        url: `https://github.com/example/cert-prep/releases/download/cert-prep-v0.1.0-alpha.1/${ocrName}`,
      },
    }),
  );
  writeFileSync(join(resourceRoot, backendName), 'tampered-runtime');
  assert.throws(
    () =>
      validatePackagedResourceContract({
        resourceRoot,
        tauriConfig,
        workspaceRoot,
      }),
    /byte count|checksum/,
  );

  writeFileSync(join(resourceRoot, backendName), 'runtime');
  writeFileSync(join(resourceRoot, captureSchemaName), '{}');
  assert.throws(
    () =>
      validatePackagedResourceContract({
        resourceRoot,
        tauriConfig,
        workspaceRoot,
      }),
    /Capture document schema checksum/,
  );

  writeFileSync(join(resourceRoot, captureSchemaName), captureSchema);
  const captureManifest = JSON.parse(
    readFileSync(captureManifestPath, 'utf8'),
  );
  captureManifest.runtimeRequirements['windowsml-ocr'].artifactUrl =
    'https://example.test/capture-windowsml-ocr-v1.zip?token=secret';
  writeFileSync(captureManifestPath, JSON.stringify(captureManifest));
  assert.throws(
    () =>
      validatePackagedResourceContract({
        resourceRoot,
        tauriConfig,
        workspaceRoot,
      }),
    /artifactUrl is not canonical HTTPS/,
  );

  captureManifest.runtimeRequirements['windowsml-ocr'].artifactUrl =
    'https://github.com/example/capture-workbench/releases/download/v0.1.0/capture-windowsml-ocr-v1.zip';
  writeFileSync(captureManifestPath, JSON.stringify(captureManifest));
  writeFileSync(join(resourceRoot, 'stale-runtime.zip'), 'stale');
  assert.throws(
    () =>
      validatePackagedResourceContract({
        resourceRoot,
        tauriConfig,
        workspaceRoot,
      }),
    /exactly the declared backend ZIP/,
  );
});

/** Creates an isolated workspace tree because artifact paths are report-relative. */
function makeTempWorkspace(): string {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-package-qa-'));
  tempRoots.push(workspaceRoot);
  return workspaceRoot;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalCaptureDocumentSchemaBytes(): string {
  return readFileSync(canonicalSchemaFixturePath, 'utf8')
    .replaceAll('\r\n', '\n')
    .replaceAll('\n', '\r\n');
}
