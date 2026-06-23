import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  bytesToMb,
  collectBackendRuntimeArtifacts,
  collectBundleArtifacts,
  collectOcrRuntimeArtifacts,
} from './files.mts';
import {
  targetTripleFromRuntimeArtifactName,
  validateRuntimeManifest,
} from './manifest.mts';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const tempRoot = tempRoots.pop();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

test('collectOcrRuntimeArtifacts records optional OCR runtime zip and manifest', () => {
  const workspaceRoot = makeTempWorkspace();
  const runtimeRoot = join(
    workspaceRoot,
    'apps/cert-prep-backend/dist/ocr-runtime',
  );
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    join(runtimeRoot, 'cert-prep-ocr-runtime-x86_64-pc-windows-msvc.zip'),
    'zip',
  );
  writeFileSync(join(runtimeRoot, 'ocr-runtime-manifest.json'), '{}');

  const artifacts = collectOcrRuntimeArtifacts(runtimeRoot, workspaceRoot);

  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    [
      'apps/cert-prep-backend/dist/ocr-runtime/cert-prep-ocr-runtime-x86_64-pc-windows-msvc.zip',
      'apps/cert-prep-backend/dist/ocr-runtime/ocr-runtime-manifest.json',
    ],
  );
});

test('collectBackendRuntimeArtifacts records backend runtime zip and manifest', () => {
  const workspaceRoot = makeTempWorkspace();
  const runtimeRoot = join(
    workspaceRoot,
    'apps/cert-prep-backend/dist/backend-runtime',
  );
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    join(runtimeRoot, 'cert-prep-backend-runtime-x86_64-pc-windows-msvc.zip'),
    'zip',
  );
  writeFileSync(join(runtimeRoot, 'backend-runtime-manifest.json'), '{}');

  const artifacts = collectBackendRuntimeArtifacts(runtimeRoot, workspaceRoot);

  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    [
      'apps/cert-prep-backend/dist/backend-runtime/backend-runtime-manifest.json',
      'apps/cert-prep-backend/dist/backend-runtime/cert-prep-backend-runtime-x86_64-pc-windows-msvc.zip',
    ],
  );
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

test('validateRuntimeManifest checks optional URL, target, size, and checksum', () => {
  const workspaceRoot = makeTempWorkspace();
  const runtimeRoot = join(
    workspaceRoot,
    'apps/cert-prep-backend/dist/backend-runtime',
  );
  const resourceRoot = join(
    workspaceRoot,
    'apps/cert-prep-desktop/src-tauri/resources',
  );
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(resourceRoot, { recursive: true });
  const artifactPath = join(
    runtimeRoot,
    'cert-prep-backend-runtime-x86_64-pc-windows-msvc.zip',
  );
  writeFileSync(artifactPath, 'backend-runtime');
  const manifestPath = join(resourceRoot, 'backend-runtime-manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      kind: 'python_backend',
      version: '0.1.0',
      target: 'x86_64-pc-windows-msvc',
      entrypoint: 'cert-prep-backend.exe',
      artifact: {
        file_name: 'cert-prep-backend-runtime-x86_64-pc-windows-msvc.zip',
        sha256: sha256('backend-runtime'),
        bytes: Buffer.byteLength('backend-runtime'),
        url: 'https://example.test/cert-prep-backend-runtime-x86_64-pc-windows-msvc.zip',
      },
    }),
  );

  const summary = validateRuntimeManifest({
    manifestPath,
    runtimeRoot,
    workspaceRoot,
    expectedKind: 'python_backend',
    artifactPrefix: 'cert-prep-backend-runtime-',
  });

  assert.equal(summary.target, 'x86_64-pc-windows-msvc');
  assert.equal(
    summary.url,
    'https://example.test/cert-prep-backend-runtime-x86_64-pc-windows-msvc.zip',
  );
  assert.equal(
    targetTripleFromRuntimeArtifactName(
      'cert-prep-backend-runtime-x86_64-pc-windows-msvc.zip',
      'cert-prep-backend-runtime-',
    ),
    'x86_64-pc-windows-msvc',
  );

  writeFileSync(
    manifestPath,
    JSON.stringify({
      kind: 'python_backend',
      version: '0.1.0',
      target: 'x86_64-pc-windows-msvc',
      entrypoint: 'cert-prep-backend.exe',
      artifact: {
        file_name: 'cert-prep-backend-runtime-x86_64-pc-windows-msvc.zip',
        sha256: sha256('backend-runtime'),
        bytes: Buffer.byteLength('backend-runtime'),
        url: null,
      },
    }),
  );

  const localSummary = validateRuntimeManifest({
    manifestPath,
    runtimeRoot,
    workspaceRoot,
    expectedKind: 'python_backend',
    artifactPrefix: 'cert-prep-backend-runtime-',
  });

  assert.equal(localSummary.url, null);
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
