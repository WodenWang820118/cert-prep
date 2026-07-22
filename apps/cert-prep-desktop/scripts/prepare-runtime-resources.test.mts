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
  validateCaptureWindowsmlDescriptor,
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
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

test('release resources bundle backend and reference OCR through HTTPS only', async () => {
  const fixture = createFixture();
  const outputDir = join(fixture.workspaceRoot, 'generated-resources');

  await prepareRuntimeResources({
    ...fixture,
    outputDir,
    mode: 'release',
    windowsmlReleaseBaseUrl:
      'https://github.com/example/cert-prep/releases/download/cert-prep-v0.1.0-alpha.1',
  });

  const backend = readJson(join(outputDir, 'backend-runtime-manifest.json'));
  const ocr = readJson(join(outputDir, 'windowsml-ocr-runtime-manifest.json'));
  const metadata = readJson(join(outputDir, 'release-metadata.json'));
  const capture = readJson(
    join(outputDir, 'capture-runtime-manifest.json'),
  );
  assert.equal(backend.artifact.url, null);
  assert.equal(
    readFileSync(join(outputDir, backend.artifact.file_name), 'utf8'),
    'backend',
  );
  assert.equal(
    ocr.artifact.url,
    'https://github.com/example/cert-prep/releases/download/cert-prep-v0.1.0-alpha.1/cert-prep-ocr-windowsml-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip',
  );
  assert.equal(
    existsSync(
      join(
        outputDir,
        'cert-prep-ocr-windowsml-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip',
      ),
    ),
    false,
  );
  assert.equal(metadata.version, '0.1.0-alpha.1');
  assert.equal('windows_msi_version' in metadata, false);
  assert.equal(metadata.python_runtime_version, '3.12');
  assert.equal(metadata.channel, 'unsigned_public_alpha');
  assert.equal(metadata.distribution_profile, 'public_unsigned_alpha');
  assert.equal(metadata.publishable, true);
  assert.equal(
    metadata.runtime_assets.windowsml_ocr.distribution,
    'github_release_download',
  );
  assert.equal(metadata.signed, false);
  assert.equal(metadata.warnings.production_ready, false);
  assert.equal(capture.runtimeVersion, '0.1.0');
  assert.equal(capture.apiVersion, '1.0');
  assert.equal(capture.captureDocumentSchemaVersion, '1');
  assert.equal(
    readFileSync(join(outputDir, capture.fileName), 'utf8'),
    'capture-runtime',
  );
  assert.deepEqual(
    readJson(join(outputDir, capture.schemaFileName)),
    canonicalCaptureDocumentSchema(),
  );
  assert.equal(
    metadata.runtime_assets.capture_runtime.distribution,
    'explicit_staged_artifact',
  );
  assert.equal(
    metadata.runtime_assets.capture_runtime.schema_file_name,
    'capture-document-v1.schema.json',
  );
  assert.equal(
    metadata.runtime_assets.capture_runtime.structuring_mode,
    'host',
  );
  assert.deepEqual(
    metadata.runtime_assets.capture_runtime.runtime_requirements,
    capture.runtimeRequirements,
  );
});

test('release resources reject file and non-release URLs', async () => {
  const fixture = createFixture();
  await assert.rejects(
    prepareRuntimeResources({
      ...fixture,
      outputDir: join(fixture.workspaceRoot, 'generated-resources'),
      mode: 'release',
      windowsmlReleaseBaseUrl: 'file:///C:/runtime',
    }),
    /must use the cert-prep-v0\.1\.0-alpha\.1 GitHub Release URL/,
  );
  await assert.rejects(
    prepareRuntimeResources({
      ...fixture,
      outputDir: join(fixture.workspaceRoot, 'generated-resources'),
      mode: 'release',
      windowsmlReleaseBaseUrl:
        'https://github.com/example/cert-prep/releases/download/cert-prep-v0.1.0-alpha.2',
    }),
    /must use the cert-prep-v0\.1\.0-alpha\.1 GitHub Release URL/,
  );
});

test('dev resources use an explicit local OCR file URL', async () => {
  const fixture = createFixture();
  const outputDir = join(fixture.workspaceRoot, 'generated-resources');
  await prepareRuntimeResources({ ...fixture, outputDir, mode: 'dev' });

  const ocr = readJson(join(outputDir, 'windowsml-ocr-runtime-manifest.json'));
  const metadata = readJson(join(outputDir, 'release-metadata.json'));
  assert.match(ocr.artifact.url, /^file:\/\//);
  assert.equal(metadata.release_tag, 'cert-prep-local-v0.1.0-alpha.1');
  assert.equal(metadata.channel, 'local_nonpublishable');
  assert.equal(metadata.distribution_profile, 'local_nonpublishable');
  assert.equal(metadata.publishable, false);
  assert.equal(metadata.distribution_mode, 'dev');
  assert.equal(
    metadata.runtime_assets.windowsml_ocr.distribution,
    'local_file',
  );
  assert.match(metadata.warnings.smartscreen, /cannot be published/);
});

test('capture runtime staging is mandatory and fails closed on provenance drift', async () => {
  const fixture = createFixture();
  await assert.rejects(
    prepareRuntimeResources({
      workspaceRoot: fixture.workspaceRoot,
      backendRuntimeRoot: fixture.backendRuntimeRoot,
      windowsmlRuntimeRoot: fixture.windowsmlRuntimeRoot,
      outputDir: join(fixture.workspaceRoot, 'missing-capture'),
      mode: 'dev',
    }),
    /CERT_PREP_CAPTURE_RUNTIME_MANIFEST_PATH is required/,
  );
  await assert.rejects(
    prepareRuntimeResources({
      workspaceRoot: fixture.workspaceRoot,
      backendRuntimeRoot: fixture.backendRuntimeRoot,
      windowsmlRuntimeRoot: fixture.windowsmlRuntimeRoot,
      captureRuntimeManifestPath: fixture.captureRuntimeManifestPath,
      captureRuntimeArtifactPath: fixture.captureRuntimeArtifactPath,
      outputDir: join(fixture.workspaceRoot, 'missing-schema'),
      mode: 'dev',
    }),
    /CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_PATH is required/,
  );

  const manifest = readJson(fixture.captureRuntimeManifestPath);
  manifest.runtimeVersion = '0.2.0';
  writeFileSync(
    fixture.captureRuntimeManifestPath,
    JSON.stringify(manifest),
    'utf8',
  );
  await assert.rejects(
    prepareRuntimeResources({
      ...fixture,
      outputDir: join(fixture.workspaceRoot, 'wrong-version'),
      mode: 'dev',
    }),
    /runtimeVersion must be 0\.1\.0/,
  );

  manifest.runtimeVersion = '0.1.0';
  manifest.sha256 = '0'.repeat(64);
  writeFileSync(
    fixture.captureRuntimeManifestPath,
    JSON.stringify(manifest),
    'utf8',
  );
  await assert.rejects(
    prepareRuntimeResources({
      ...fixture,
      outputDir: join(fixture.workspaceRoot, 'wrong-digest'),
      mode: 'dev',
    }),
    /checksum mismatch/,
  );

  manifest.sha256 = createHash('sha256')
    .update('capture-runtime')
    .digest('hex');
  manifest.schemaSha256 = '0'.repeat(64);
  writeFileSync(
    fixture.captureRuntimeManifestPath,
    JSON.stringify(manifest),
    'utf8',
  );
  await assert.rejects(
    prepareRuntimeResources({
      ...fixture,
      outputDir: join(fixture.workspaceRoot, 'wrong-schema-digest'),
      mode: 'dev',
    }),
    /schemaSha256 must be/,
  );
});

test('capture runtime executable bytes use the shared bounded integer contract', async () => {
  for (const bytes of [1, 536_870_912]) {
    assert.equal(
      validateCaptureArtifactBytes(bytes, 'Capture runtime executable'),
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
    const fixture = createFixture();
    const manifest = readJson(fixture.captureRuntimeManifestPath);
    manifest.bytes = bytes;
    writeFileSync(
      fixture.captureRuntimeManifestPath,
      JSON.stringify(manifest),
      'utf8',
    );
    await assert.rejects(
      prepareRuntimeResources({
        ...fixture,
        outputDir: join(fixture.workspaceRoot, `invalid-runtime-bytes-${String(bytes)}`),
        mode: 'dev',
      }),
      /Capture runtime executable bytes must be between 1 and 536870912/,
    );
  }
});

test('capture schema trust anchor rejects self-signed truncation and critical-field mutation', async () => {
  const fixture = createFixture();
  const manifest = readJson(fixture.captureRuntimeManifestPath);
  const truncatedSchema = canonicalCaptureDocumentSchemaBytes().slice(0, -2);
  writeFileSync(fixture.captureDocumentSchemaPath, truncatedSchema, 'utf8');
  manifest.schemaSha256 = createHash('sha256')
    .update(truncatedSchema)
    .digest('hex');
  writeFileSync(
    fixture.captureRuntimeManifestPath,
    JSON.stringify(manifest),
    'utf8',
  );
  await assert.rejects(
    prepareRuntimeResources({
      ...fixture,
      outputDir: join(fixture.workspaceRoot, 'self-signed-truncated-schema'),
      mode: 'dev',
    }),
    /schemaSha256 must be/,
  );

  const changedSchema = canonicalCaptureDocumentSchema();
  changedSchema.additionalProperties = true;
  const changedSchemaBytes = `${JSON.stringify(changedSchema, null, 2)}\r\n`;
  writeFileSync(fixture.captureDocumentSchemaPath, changedSchemaBytes, 'utf8');
  manifest.schemaSha256 = createHash('sha256')
    .update(changedSchemaBytes)
    .digest('hex');
  writeFileSync(
    fixture.captureRuntimeManifestPath,
    JSON.stringify(manifest),
    'utf8',
  );
  await assert.rejects(
    prepareRuntimeResources({
      ...fixture,
      outputDir: join(fixture.workspaceRoot, 'self-signed-mutated-schema'),
      mode: 'dev',
    }),
    /schemaSha256 must be/,
  );
});

test('capture WindowsML descriptor accepts only the shared canonical corpus', () => {
  const validDescriptor = {
    artifactUrl: 'https://example.test/releases/windowsml.zip',
    artifactFileName: 'windowsml.zip',
    bytes: 123_456,
    sha256: '2'.repeat(64),
  };
  assert.deepEqual(
    validateCaptureWindowsmlDescriptor(validDescriptor),
    validDescriptor,
  );
  assert.doesNotThrow(() =>
    validateCaptureWindowsmlDescriptor({
      ...validDescriptor,
      artifactUrl: 'https://example.test:443/releases/windowsml.zip',
    }),
  );
  for (const bytes of [1, 536_870_912]) {
    assert.doesNotThrow(() =>
      validateCaptureWindowsmlDescriptor({ ...validDescriptor, bytes }),
    );
  }

  const invalidUrls = [
    'http://example.test/releases/windowsml.zip',
    'HTTPS://example.test/releases/windowsml.zip',
    'https:///releases/windowsml.zip',
    'https://@example.test/releases/windowsml.zip',
    'https://user@example.test/releases/windowsml.zip',
    'https://user:secret@example.test/releases/windowsml.zip',
    'https://example.test:8443/releases/windowsml.zip',
    'https://example.test/releases/windowsml.zip?token=secret',
    'https://example.test/releases/windowsml.zip#fragment',
    'https://example.test/releases/../windowsml.zip',
    'https://example.test/releases/./windowsml.zip',
    'https://example.test/releases/%2e%2e/windowsml.zip',
    'https://example.test/releases/%252e%252e/windowsml.zip',
    'https://example.test/releases/%2f/windowsml.zip',
    'https://example.test/releases/%5c/windowsml.zip',
    'https://example.test\\releases/windowsml.zip',
    'https://example.test/releases\\windowsml.zip',
    'https://example.test/releases/file.txt:windowsml.zip',
    'https://example.test/releases/other.zip',
    'https://exa\nmple.test/releases/windowsml.zip',
  ];
  for (const artifactUrl of invalidUrls) {
    assert.throws(
      () =>
        validateCaptureWindowsmlDescriptor({
          ...validDescriptor,
          artifactUrl,
        }),
      /artifactUrl is not canonical HTTPS/,
      artifactUrl,
    );
  }

  for (const bytes of [0, 536_870_913, 1.5, Number.NaN]) {
    assert.throws(
      () =>
        validateCaptureWindowsmlDescriptor({ ...validDescriptor, bytes }),
      /bytes must be between 1 and 536870912/,
    );
  }
  assert.throws(
    () =>
      validateCaptureWindowsmlDescriptor({
        ...validDescriptor,
        sha256: 'A'.repeat(64),
      }),
    /64 lowercase hex characters/,
  );
  assert.throws(
    () =>
      validateCaptureWindowsmlDescriptor({
        ...validDescriptor,
        extra: 'not-part-of-v1',
      }),
    /must contain exactly/,
  );
  for (const artifactFileName of [
    '../windowsml.zip',
    'folder/windowsml.zip',
    'windowsml.zip:stream',
    'windows ml.zip',
    'windowsml.exe',
  ]) {
    assert.throws(
      () =>
        validateCaptureWindowsmlDescriptor({
          ...validDescriptor,
          artifactFileName,
        }),
      /plain \.zip name/,
    );
  }
});

function createFixture(): {
  workspaceRoot: string;
  backendRuntimeRoot: string;
  windowsmlRuntimeRoot: string;
  captureRuntimeManifestPath: string;
  captureRuntimeArtifactPath: string;
  captureDocumentSchemaPath: string;
} {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-prep-resources-'));
  tempRoots.push(workspaceRoot);
  const backendRuntimeRoot = join(workspaceRoot, 'backend');
  const windowsmlRuntimeRoot = join(workspaceRoot, 'windowsml');
  mkdirSync(backendRuntimeRoot, { recursive: true });
  mkdirSync(windowsmlRuntimeRoot, { recursive: true });
  writeRuntime(
    backendRuntimeRoot,
    'backend-runtime-manifest.json',
    'python_backend',
    'cert-prep-backend-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip',
    'backend',
  );
  writeRuntime(
    windowsmlRuntimeRoot,
    'windowsml-ocr-runtime-manifest.json',
    'windowsml_ocr',
    'cert-prep-ocr-windowsml-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip',
    'ocr',
  );
  const captureRuntimeArtifactPath = join(
    workspaceRoot,
    'capture-runtime-x86_64-pc-windows-msvc.exe',
  );
  const captureRuntimeManifestPath = join(
    workspaceRoot,
    'capture-runtime-manifest.json',
  );
  const captureDocumentSchemaPath = join(
    workspaceRoot,
    'capture-document-v1.schema.json',
  );
  const captureSchema = canonicalCaptureDocumentSchemaBytes();
  assert.equal(
    createHash('sha256').update(captureSchema).digest('hex'),
    CAPTURE_DOCUMENT_SCHEMA_SHA256,
  );
  writeFileSync(captureRuntimeArtifactPath, 'capture-runtime', 'utf8');
  writeFileSync(captureDocumentSchemaPath, captureSchema, 'utf8');
  writeFileSync(
    captureRuntimeManifestPath,
    JSON.stringify({
      manifestVersion: '1',
      runtimeVersion: '0.1.0',
      apiVersion: '1.0',
      captureDocumentSchemaVersion: '1',
      platform: 'windows',
      arch: 'x86_64',
      fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
      bytes: Buffer.byteLength('capture-runtime'),
      sha256: createHash('sha256').update('capture-runtime').digest('hex'),
      schemaFileName: 'capture-document-v1.schema.json',
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
    'utf8',
  );
  return {
    workspaceRoot,
    backendRuntimeRoot,
    windowsmlRuntimeRoot,
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

function writeRuntime(
  root: string,
  manifestName: string,
  kind: string,
  fileName: string,
  content: string,
): void {
  writeFileSync(join(root, fileName), content);
  writeFileSync(
    join(root, manifestName),
    JSON.stringify({
      schema_version: 1,
      kind,
      version: '0.1.0-alpha.1',
      target: 'x86_64-pc-windows-msvc',
      entrypoint: kind === 'python_backend' ? 'backend.exe' : 'ocr.exe',
      artifact: {
        file_name: fileName,
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: Buffer.byteLength(content),
        url: null,
      },
    }),
  );
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
