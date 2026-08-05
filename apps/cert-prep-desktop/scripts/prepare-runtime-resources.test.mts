import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
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

import {
  validateCaptureArtifactBytes,
} from './capture-runtime-contract.mts';
import { CAPTURE_DOCUMENT_SCHEMA_SHA256 } from './package-qa/constants.mts';
import { prepareRuntimeResources } from './prepare-runtime-resources.mts';

const tempRoots: string[] = [];
const canonicalSchemaFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../test-fixtures/capture-document-v1.schema.json',
);

afterEach(() => {
  while (tempRoots.length > 0) {
    const tempRoot = tempRoots.pop();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resources bundle the backend and published Capture Runtime contract only', async () => {
  const fixture = createFixture();
  const outputDir = join(fixture.workspaceRoot, 'generated-resources');
  await prepareRuntimeResources({ ...fixture, outputDir, mode: 'release' });

  const backend = readJson(join(outputDir, 'backend-runtime-manifest.json'));
  const metadata = readJson(join(outputDir, 'release-metadata.json'));
  const capture = readJson(join(outputDir, 'capture-runtime-manifest.json'));
  assert.equal(backend.artifact.url, null);
  assert.equal(metadata.runtime_assets.backend.distribution, 'bundled');
  assert.equal(metadata.runtime_assets.capture_runtime.structuring_mode, 'host');
  assert.equal(capture.runtimeVersion, '0.3.10');
  assert.equal(capture.apiVersion, '1.0');
  assert.equal(capture.captureDocumentSchemaVersion, '1');
  assert.equal(existsSync(join(outputDir, 'windowsml-ocr-runtime-manifest.json')), false);
  assert.deepEqual(readJson(join(outputDir, capture.schemaFileName)), canonicalCaptureDocumentSchema());
});

test('dev resources remain local and non-publishable without cert-prep OCR assets', async () => {
  const fixture = createFixture();
  const outputDir = join(fixture.workspaceRoot, 'generated-resources');
  await prepareRuntimeResources({ ...fixture, outputDir, mode: 'dev' });
  const metadata = readJson(join(outputDir, 'release-metadata.json'));
  assert.equal(metadata.release_tag, 'cert-prep-local-v0.1.0-alpha.1');
  assert.equal(metadata.channel, 'local_nonpublishable');
  assert.equal(metadata.publishable, false);
  assert.equal('windowsml_ocr' in metadata.runtime_assets, false);
});

test('Capture Runtime staging fails closed on missing or changed provenance', async () => {
  const fixture = createFixture();
  await assert.rejects(
    prepareRuntimeResources({
      workspaceRoot: fixture.workspaceRoot,
      backendRuntimeRoot: fixture.backendRuntimeRoot,
      outputDir: join(fixture.workspaceRoot, 'missing-capture'),
      mode: 'dev',
    }),
    /Capture runtime manifest was not staged/,
  );

  const manifest = readJson(fixture.captureRuntimeManifestPath);
  manifest.runtimeVersion = '0.2.0';
  writeJson(fixture.captureRuntimeManifestPath, manifest);
  await assert.rejects(
    prepareRuntimeResources({ ...fixture, outputDir: join(fixture.workspaceRoot, 'wrong-version'), mode: 'dev' }),
    /runtimeVersion must be 0\.3\.10/,
  );

  manifest.runtimeVersion = '0.3.10';
  manifest.sha256 = '0'.repeat(64);
  writeJson(fixture.captureRuntimeManifestPath, manifest);
  await assert.rejects(
    prepareRuntimeResources({ ...fixture, outputDir: join(fixture.workspaceRoot, 'wrong-digest'), mode: 'dev' }),
    /checksum mismatch/,
  );

  manifest.sha256 = sha256('capture-runtime');
  manifest.schemaSha256 = '0'.repeat(64);
  writeJson(fixture.captureRuntimeManifestPath, manifest);
  await assert.rejects(
    prepareRuntimeResources({ ...fixture, outputDir: join(fixture.workspaceRoot, 'wrong-schema-digest'), mode: 'dev' }),
    /schemaSha256 must be/,
  );
});

test('Capture Runtime executable bytes use the shared bounded contract', async () => {
  for (const bytes of [1, 536_870_912]) {
    assert.equal(validateCaptureArtifactBytes(bytes, 'Capture runtime executable'), bytes);
  }
  for (const bytes of [0, 536_870_913, 1.5, '15', Number.MAX_SAFE_INTEGER + 1]) {
    const fixture = createFixture();
    const manifest = readJson(fixture.captureRuntimeManifestPath);
    manifest.bytes = bytes;
    writeJson(fixture.captureRuntimeManifestPath, manifest);
    await assert.rejects(
      prepareRuntimeResources({ ...fixture, outputDir: join(fixture.workspaceRoot, `invalid-${String(bytes)}`), mode: 'dev' }),
      /Capture runtime executable bytes must be between 1 and 536870912/,
    );
  }
});

function createFixture(): {
  workspaceRoot: string;
  backendRuntimeRoot: string;
  captureRuntimeManifestPath: string;
  captureRuntimeArtifactPath: string;
  captureDocumentSchemaPath: string;
} {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-resources-'));
  tempRoots.push(workspaceRoot);
  const backendRuntimeRoot = join(workspaceRoot, 'backend');
  mkdirSync(backendRuntimeRoot, { recursive: true });
  const backendName = 'cert-prep-backend-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip';
  writeFileSync(join(backendRuntimeRoot, backendName), 'backend');
  writeJson(join(backendRuntimeRoot, 'backend-runtime-manifest.json'), {
    kind: 'python_backend',
    version: '0.1.0-alpha.1',
    target: 'x86_64-pc-windows-msvc',
    entrypoint: 'backend.exe',
    artifact: { file_name: backendName, sha256: sha256('backend'), bytes: 7, url: null },
  });

  const captureRuntimeArtifactPath = join(workspaceRoot, 'capture-runtime-x86_64-pc-windows-msvc.exe');
  const captureRuntimeManifestPath = join(workspaceRoot, 'capture-runtime-manifest.json');
  const captureDocumentSchemaPath = join(workspaceRoot, 'capture-document-v1.schema.json');
  const captureSchema = canonicalCaptureDocumentSchemaBytes();
  writeFileSync(captureRuntimeArtifactPath, 'capture-runtime');
  writeFileSync(captureDocumentSchemaPath, captureSchema);
  writeJson(captureRuntimeManifestPath, {
    manifestVersion: '1',
    runtimeVersion: '0.3.10',
    apiVersion: '1.0',
    captureDocumentSchemaVersion: '1',
    platform: 'windows',
    arch: 'x86_64',
    fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
    bytes: Buffer.byteLength('capture-runtime'),
    sha256: sha256('capture-runtime'),
    schemaFileName: 'capture-document-v1.schema.json',
    schemaSha256: CAPTURE_DOCUMENT_SCHEMA_SHA256,
  });
  return {
    workspaceRoot,
    backendRuntimeRoot,
    captureRuntimeManifestPath,
    captureRuntimeArtifactPath,
    captureDocumentSchemaPath,
  };
}

function canonicalCaptureDocumentSchemaBytes(): string {
  return readFileSync(canonicalSchemaFixturePath, 'utf8')
    .replaceAll('\r\n', '\n')
    .replaceAll('\n', '\r\n');
}

function canonicalCaptureDocumentSchema(): Record<string, unknown> {
  return JSON.parse(canonicalCaptureDocumentSchemaBytes());
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}
