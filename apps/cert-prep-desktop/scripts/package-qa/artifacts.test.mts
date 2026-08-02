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
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('collectBundleArtifacts records sorted relative paths and sizes', () => {
  const workspaceRoot = makeTempWorkspace();
  const bundleRoot = join(workspaceRoot, 'bundle');
  mkdirSync(join(bundleRoot, 'nsis'), { recursive: true });
  writeFileSync(join(bundleRoot, 'nsis', 'Cert Prep_0.1.0_x64-setup.exe'), Buffer.alloc(2048));

  const artifacts = collectBundleArtifacts(bundleRoot, workspaceRoot);
  assert.deepEqual(artifacts.map((artifact) => artifact.bytes), [2048]);
  assert.equal(bytesToMb(1024 * 1024 * 1.5), 1.5);
});

test('bundle gate requires exactly one alpha NSIS installer', () => {
  const workspaceRoot = makeTempWorkspace();
  const bundleRoot = join(workspaceRoot, 'bundle');
  const nsisRoot = join(bundleRoot, 'nsis');
  mkdirSync(nsisRoot, { recursive: true });
  writeFileSync(join(nsisRoot, 'Cert Prep_0.1.0-alpha.1_x64-setup.exe'), 'nsis');
  validateBundleArtifacts(collectBundleArtifacts(bundleRoot, workspaceRoot));
  writeFileSync(join(nsisRoot, 'Cert Prep_0.1.0_x64-setup.exe'), 'stale');
  assert.throws(
    () => validateBundleArtifacts(collectBundleArtifacts(bundleRoot, workspaceRoot)),
    /stale or unexpected bundles/,
  );
});

test('package QA shares the bounded Capture executable bytes contract', () => {
  for (const bytes of [1, 536_870_912]) {
    assert.equal(validateCaptureArtifactBytes(bytes, 'Packaged Capture runtime executable'), bytes);
  }
  for (const bytes of [0, 536_870_913, 1.5, '15', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validateCaptureArtifactBytes(bytes, 'Packaged Capture runtime executable'),
      /bytes must be between 1 and 536870912/,
    );
  }
});

test('packaged resource contract contains only backend and Capture Runtime assets', async () => {
  const fixture = createResourceFixture();
  const contract = validatePackagedResourceContract(fixture);

  assert.equal(contract.backend_bundled, true);
  assert.equal(contract.capture_runtime_bundled, true);
  assert.equal(contract.capture_structuring_mode, 'host');
  assert.equal(contract.resource_files.length, 6);
  assert.equal(contract.legal_files.length, 4);
  assert.equal(contract.channel, 'unsigned_public_alpha');

  const bundleRoot = join(fixture.workspaceRoot, 'bundle');
  mkdirSync(join(bundleRoot, 'nsis'), { recursive: true });
  writeFileSync(join(bundleRoot, 'nsis', 'Cert Prep_0.1.0-alpha.1_x64-setup.exe'), 'nsis');
  const report = await createPackageQaReport({
    workspaceRoot: fixture.workspaceRoot,
    bundleRoot,
    packagedResourceRoot: fixture.resourceRoot,
    tauriConfig: fixture.tauriConfig,
  });
  assert.equal(report.package.resource_contract.capture_runtime_bundled, true);

  writeFileSync(join(fixture.resourceRoot, 'windowsml-ocr-runtime-manifest.json'), 'legacy');
  assert.throws(
    () => validatePackagedResourceContract(fixture),
    /cert-prep-owned WindowsML OCR runtime manifest must not be bundled/,
  );
});

function createResourceFixture(): {
  workspaceRoot: string;
  resourceRoot: string;
  tauriConfig: string;
} {
  const workspaceRoot = makeTempWorkspace();
  const resourceRoot = join(workspaceRoot, 'release', 'resources');
  mkdirSync(resourceRoot, { recursive: true });
  const backendName = 'cert-prep-backend-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip';
  const captureName = 'capture-runtime-x86_64-pc-windows-msvc.exe';
  const schemaName = 'capture-document-v1.schema.json';
  const captureSchema = canonicalCaptureDocumentSchemaBytes();
  writeFileSync(join(resourceRoot, backendName), 'runtime');
  writeJson(join(resourceRoot, 'backend-runtime-manifest.json'), {
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
  });
  writeFileSync(join(resourceRoot, captureName), 'capture-runtime');
  writeFileSync(join(resourceRoot, schemaName), captureSchema);
  const captureManifest = {
    manifestVersion: '1',
    runtimeVersion: '0.3.8',
    apiVersion: '1.0',
    captureDocumentSchemaVersion: '1',
    platform: 'windows',
    arch: 'x86_64',
    fileName: captureName,
    bytes: Buffer.byteLength('capture-runtime'),
    sha256: sha256('capture-runtime'),
    schemaFileName: schemaName,
    schemaSha256: CAPTURE_DOCUMENT_SCHEMA_SHA256,
  };
  writeJson(join(resourceRoot, 'capture-runtime-manifest.json'), captureManifest);
  writeJson(join(resourceRoot, 'release-metadata.json'), {
    schema_version: 1,
    version: '0.1.0-alpha.1',
    python_runtime_version: '3.12',
    release_tag: 'cert-prep-v0.1.0-alpha.1',
    channel: 'unsigned_public_alpha',
    distribution_profile: 'public_unsigned_alpha',
    publishable: true,
    distribution_mode: 'release',
    signed: false,
    warnings: { smartscreen: 'Unsigned public Alpha.', production_ready: false },
    sha256_verification: { required: true, algorithm: 'SHA-256' },
    runtime_assets: {
      backend: {
        distribution: 'bundled',
        file_name: backendName,
        sha256: sha256('runtime'),
        bytes: Buffer.byteLength('runtime'),
      },
      capture_runtime: {
        distribution: 'versioned_release_artifact_staged',
        file_name: captureName,
        runtime_version: '0.3.8',
        api_version: '1.0',
        capture_document_schema_version: '1',
        sha256: sha256('capture-runtime'),
        bytes: Buffer.byteLength('capture-runtime'),
        schema_file_name: schemaName,
        schema_sha256: CAPTURE_DOCUMENT_SCHEMA_SHA256,
        structuring_mode: 'host',
      },
    },
  });
  const legalRoot = join(workspaceRoot, 'release', 'legal');
  mkdirSync(legalRoot, { recursive: true });
  for (const name of ['LICENSE', 'PRIVACY.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md']) {
    writeFileSync(join(legalRoot, name), name);
  }
  const tauriConfig = join(workspaceRoot, 'tauri.conf.json');
  writeJson(join(workspaceRoot, 'tauri.conf.json'), {
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
  });
  return { workspaceRoot, resourceRoot, tauriConfig };
}

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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}
