import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { bytesToMb, collectBundleArtifacts } from './files.mts';
import { validatePackagedResourceContract } from './resource-contract.mts';
import { createPackageQaReport, validateBundleArtifacts } from './report.mts';

const tempRoots: string[] = [];

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
  const msiDir = join(bundleRoot, 'msi');
  mkdirSync(nsisDir, { recursive: true });
  mkdirSync(msiDir, { recursive: true });
  writeFileSync(
    join(nsisDir, 'Cert Prep_0.1.0_x64-setup.exe'),
    Buffer.alloc(2048),
  );
  writeFileSync(
    join(msiDir, 'Cert Prep_0.1.0_x64_en-US.msi'),
    Buffer.alloc(1024),
  );

  const artifacts = collectBundleArtifacts(bundleRoot, workspaceRoot);

  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    [
      'apps/cert-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Cert Prep_0.1.0_x64_en-US.msi',
      'apps/cert-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Cert Prep_0.1.0_x64-setup.exe',
    ],
  );
  assert.deepEqual(
    artifacts.map((artifact) => artifact.bytes),
    [1024, 2048],
  );
  assert.equal(bytesToMb(1024 * 1024 * 1.5), 1.5);
});

test('bundle gate requires exactly one alpha MSI and NSIS pair', () => {
  const workspaceRoot = makeTempWorkspace();
  const bundleRoot = join(workspaceRoot, 'bundle');
  const msiRoot = join(bundleRoot, 'msi');
  const nsisRoot = join(bundleRoot, 'nsis');
  mkdirSync(msiRoot, { recursive: true });
  mkdirSync(nsisRoot, { recursive: true });
  writeFileSync(join(msiRoot, 'Cert Prep_0.1.0-alpha.1_x64_en-US.msi'), 'msi');
  writeFileSync(
    join(nsisRoot, 'Cert Prep_0.1.0-alpha.1_x64-setup.exe'),
    'nsis',
  );
  validateBundleArtifacts(collectBundleArtifacts(bundleRoot, workspaceRoot));

  writeFileSync(join(msiRoot, 'Cert Prep_0.1.0_x64_en-US.msi'), 'stale');
  assert.throws(
    () =>
      validateBundleArtifacts(
        collectBundleArtifacts(bundleRoot, workspaceRoot),
      ),
    /stale or unexpected bundles/,
  );
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
  writeFileSync(
    join(resourceRoot, 'release-metadata.json'),
    JSON.stringify({
      schema_version: 1,
      version: '0.1.0-alpha.1',
      windows_msi_version: '0.1.0.1',
      python_runtime_version: '3.12',
      release_tag: 'cert-prep-v0.1.0-alpha.1',
      channel: 'unsigned_public_alpha',
      distribution_mode: 'release',
      signed: false,
      warnings: {
        smartscreen: 'Unsigned public Alpha.',
        production_ready: false,
      },
      sha256_verification: { required: true, algorithm: 'SHA-256' },
      runtime_assets: {
        backend: {
          file_name: backendName,
          sha256: sha256('runtime'),
          bytes: Buffer.byteLength('runtime'),
        },
        windowsml_ocr: {
          file_name: ocrName,
          sha256: sha256('ocr'),
          bytes: Buffer.byteLength('ocr'),
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
        windows: { wix: { version: '0.1.0.1' } },
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
  assert.equal(contract.evidence_scope, 'static_tauri_release_resources');
  assert.equal(contract.installer_contents_verified, false);
  assert.equal(contract.fresh_install_verified, false);
  assert.equal(contract.alpha_release_gate, 'blocked_pending_clean_install');
  assert.equal(contract.resource_files.length, 4);
  assert.equal(contract.legal_files.length, 4);
  assert.equal(contract.channel, 'unsigned_public_alpha');
  assert.equal(contract.windows_msi_version, '0.1.0.1');
  assert.equal(contract.python_runtime_version, '3.12');
  assert.equal(contract.target, 'x86_64-pc-windows-msvc');

  const bundleRoot = join(workspaceRoot, 'bundle');
  mkdirSync(join(bundleRoot, 'msi'), { recursive: true });
  mkdirSync(join(bundleRoot, 'nsis'), { recursive: true });
  writeFileSync(
    join(bundleRoot, 'msi', 'Cert Prep_0.1.0-alpha.1_x64_en-US.msi'),
    'msi',
  );
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
