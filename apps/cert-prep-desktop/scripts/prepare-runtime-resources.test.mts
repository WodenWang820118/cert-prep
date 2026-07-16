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
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { prepareRuntimeResources } from './prepare-runtime-resources.mts';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
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

function createFixture(): {
  workspaceRoot: string;
  backendRuntimeRoot: string;
  windowsmlRuntimeRoot: string;
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
  return { workspaceRoot, backendRuntimeRoot, windowsmlRuntimeRoot };
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

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}
