import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  bytesToMb,
  collectBundleArtifacts,
  collectSidecars,
  resolveSingleSidecar,
  summarizeLlmHealth,
  summarizeOcrHealth,
  targetTripleFromSidecarName,
} from './package-qa.mjs';

const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

test('collectBundleArtifacts records sorted relative paths and sizes', () => {
  const workspaceRoot = makeTempWorkspace();
  const bundleRoot = join(
    workspaceRoot,
    'apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle'
  );
  const nsisDir = join(bundleRoot, 'nsis');
  const msiDir = join(bundleRoot, 'msi');
  mkdirSync(nsisDir, { recursive: true });
  mkdirSync(msiDir, { recursive: true });
  writeFileSync(join(nsisDir, 'Exam Prep_0.1.0_x64-setup.exe'), Buffer.alloc(2048));
  writeFileSync(join(msiDir, 'Exam Prep_0.1.0_x64_en-US.msi'), Buffer.alloc(1024));

  const artifacts = collectBundleArtifacts(bundleRoot, workspaceRoot);

  assert.deepEqual(
    artifacts.map(artifact => artifact.path),
    [
      'apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Exam Prep_0.1.0_x64_en-US.msi',
      'apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Exam Prep_0.1.0_x64-setup.exe',
    ]
  );
  assert.deepEqual(
    artifacts.map(artifact => artifact.bytes),
    [1024, 2048]
  );
  assert.equal(bytesToMb(1024 * 1024 * 1.5), 1.5);
});

test('resolveSingleSidecar requires exactly one target-suffixed sidecar', () => {
  const workspaceRoot = makeTempWorkspace();
  const sidecarDir = join(workspaceRoot, 'apps/exam-prep-desktop/src-tauri/binaries');
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(
    join(sidecarDir, 'exam-prep-backend-x86_64-pc-windows-msvc.exe'),
    'sidecar'
  );
  writeFileSync(join(sidecarDir, 'readme.txt'), 'ignored');

  const sidecar = resolveSingleSidecar(collectSidecars(sidecarDir, workspaceRoot));

  assert.equal(
    sidecar.path,
    'apps/exam-prep-desktop/src-tauri/binaries/exam-prep-backend-x86_64-pc-windows-msvc.exe'
  );
  assert.equal(
    targetTripleFromSidecarName('exam-prep-backend-x86_64-pc-windows-msvc.exe'),
    'x86_64-pc-windows-msvc'
  );
});

test('resolveSingleSidecar fails when stale sidecars remain', () => {
  const workspaceRoot = makeTempWorkspace();
  const sidecarDir = join(workspaceRoot, 'apps/exam-prep-desktop/src-tauri/binaries');
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(
    join(sidecarDir, 'exam-prep-backend-x86_64-pc-windows-msvc.exe'),
    'sidecar'
  );
  writeFileSync(
    join(sidecarDir, 'exam-prep-backend-aarch64-pc-windows-msvc.exe'),
    'sidecar'
  );

  assert.throws(
    () => resolveSingleSidecar(collectSidecars(sidecarDir, workspaceRoot)),
    /Expected exactly one synced sidecar/
  );
});

test('health summaries keep OCR fallback and LLM model state', () => {
  assert.deepEqual(
    summarizeOcrHealth({
      provider: 'paddle',
      engine: 'paddleocr',
      available: true,
      detail: 'ready',
      selected_device: 'cpu',
      cuda_available: false,
      gpu_count: 0,
      fallback_reason: 'cuda_unavailable',
      extra: 'ignored',
    }),
    {
      provider: 'paddle',
      engine: 'paddleocr',
      available: true,
      detail: 'ready',
      selected_device: 'cpu',
      cuda_available: false,
      gpu_count: 0,
      fallback_reason: 'cuda_unavailable',
    }
  );

  assert.deepEqual(
    summarizeLlmHealth({
      provider: 'ollama',
      model: 'gemma4:12b',
      available: false,
      detail: 'model not found',
      extra: 'ignored',
    }),
    {
      provider: 'ollama',
      model: 'gemma4:12b',
      available: false,
      detail: 'model not found',
    }
  );
});

function makeTempWorkspace() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'exam-prep-package-qa-'));
  tempRoots.push(workspaceRoot);
  return workspaceRoot;
}
