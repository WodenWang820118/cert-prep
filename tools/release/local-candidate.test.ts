import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateAssembledRuntimes } from './local-candidate.ts';

test('assembled candidates revalidate backend and Capture Runtime assets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-local-candidate-'));
  try {
    const generated = join(root, 'generated');
    const runtime = join(root, 'candidate', 'release', 'runtimes');
    mkdirSync(generated, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    const backendName = 'cert-prep-backend-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip';
    writeFileSync(join(generated, backendName), 'backend');
    const backendManifest = {
      schema_version: 1,
      kind: 'python_backend',
      version: '0.1.0-alpha.1',
      target: 'x86_64-pc-windows-msvc',
      entrypoint: 'cert-prep-backend.exe',
      artifact: { file_name: backendName, sha256: sha256('backend'), bytes: 7, url: null },
    };
    writeJson(join(generated, 'backend-runtime-manifest.json'), backendManifest);

    const captureName = 'capture-runtime-x86_64-pc-windows-msvc.exe';
    const captureManifest = {
      manifestVersion: '1',
      runtimeVersion: '0.3.10',
      apiVersion: '1.0',
      captureDocumentSchemaVersion: '1',
      platform: 'windows',
      arch: 'x86_64',
      fileName: captureName,
      bytes: 7,
      sha256: sha256('capture'),
      schemaFileName: 'capture-document-v1.schema.json',
      schemaSha256: '0'.repeat(64),
    };
    writeFileSync(join(generated, captureName), 'capture');
    writeFileSync(join(generated, captureManifest.schemaFileName), '{}');
    writeJson(join(generated, 'capture-runtime-manifest.json'), captureManifest);
    for (const name of [
      backendName,
      'backend-runtime-manifest.json',
      captureName,
      captureManifest.schemaFileName,
      'capture-runtime-manifest.json',
    ]) {
      const source = join(generated, name);
      writeFileSync(join(runtime, name), requireBytes(source));
    }

    await validateAssembledRuntimes(
      join(root, 'candidate'),
      generated,
      {
        backend: { bytes: 7, sha256: sha256('backend') },
        capture_runtime: { bytes: 7, sha256: sha256('capture') },
      },
    );
    assert.ok(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireBytes(path: string): Buffer {
  return readFileSync(path);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}
