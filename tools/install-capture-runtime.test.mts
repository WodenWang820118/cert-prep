import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  CAPTURE_RUNTIME_CHECKSUM_FILE,
  CAPTURE_RUNTIME_FILE,
  CAPTURE_RUNTIME_RELEASE_ASSETS,
  DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL,
  installCaptureRuntime,
  validateCaptureRuntimeReleaseBaseUrl,
  verifyCaptureRuntimeReleaseDirectory,
} from './install-capture-runtime.mts';
import {
  CAPTURE_DOCUMENT_SCHEMA_FILE,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_RUNTIME_VERSION,
} from '../apps/cert-prep-desktop/scripts/package-qa/constants.mts';

const schemaPath = join(
  process.cwd(),
  'apps/cert-prep-desktop/test-fixtures/capture-document-v1.schema.json',
);
const temporaryRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolvePromise) =>
      server.close(() => resolvePromise()),
    );
  }
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

test('pins the canonical gx-capture v0.3.11 release URL', () => {
  const expected =
    'https://github.com/gx-capture/capture-workbench/releases/download/v0.3.11';
  assert.equal(DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL, expected);
  assert.equal(validateCaptureRuntimeReleaseBaseUrl(expected), expected);
});

test('pins the published CaptureDocumentV1 schema bytes', async () => {
  const schema = await readFile(schemaPath);
  assert.equal(
    createHash('sha256').update(schema).digest('hex'),
    CAPTURE_DOCUMENT_SCHEMA_SHA256,
  );
  assert.equal(
    JSON.parse(schema.toString('utf8')).$id,
    'https://github.com/gx-capture/capture-workbench/schema/capture-document-v1.schema.json',
  );
});

test('installs a valid release and reuses identical staging', async () => {
  const root = await createFixture();
  const mirror = await startMirror(root);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-test-'),
  );
  temporaryRoots.push(workspaceRoot);

  const first = await installCaptureRuntime({
    workspaceRoot,
    baseUrl: mirror,
  });
  const second = await installCaptureRuntime({
    workspaceRoot,
    baseUrl: mirror,
  });

  assert.equal(first.outputRoot, second.outputRoot);
  assert.deepEqual(
    (await readdir(first.outputRoot)).sort(),
    [...CAPTURE_RUNTIME_RELEASE_ASSETS].sort(),
  );
  assert.equal(
    await readFile(join(first.outputRoot, CAPTURE_RUNTIME_FILE), 'utf8'),
    'runtime executable',
  );
});

test('installs the canonical assets from a local release directory without a URL', async () => {
  const root = await createFixture();
  await writeFile(
    join(root, 'capture-engine-catalog.json'),
    'local producer asset',
  );
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-local-test-'),
  );
  temporaryRoots.push(workspaceRoot);

  const installed = await installCaptureRuntime({
    workspaceRoot,
    releaseDirectory: root,
  });

  assert.equal(installed.manifest.runtimeVersion, CAPTURE_RUNTIME_VERSION);
  assert.deepEqual(
    (await readdir(installed.outputRoot)).sort(),
    [...CAPTURE_RUNTIME_RELEASE_ASSETS].sort(),
  );
});

test('fails closed when an existing pinned staging has different bytes', async () => {
  const root = await createFixture();
  const mirror = await startMirror(root);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-test-'),
  );
  temporaryRoots.push(workspaceRoot);
  const installed = await installCaptureRuntime({
    workspaceRoot,
    baseUrl: mirror,
  });
  await writeFile(join(installed.outputRoot, CAPTURE_RUNTIME_FILE), 'tampered');

  await assert.rejects(
    installCaptureRuntime({ workspaceRoot, baseUrl: mirror }),
    /refusing to overwrite/,
  );
});

test('rejects executable, schema, manifest, checksum, and platform drift', async () => {
  const root = await createFixture();
  const mutations: ReadonlyArray<
    readonly [string, (target: string) => Promise<void>]
  > = [
    [
      'executable',
      (target) => writeFile(join(target, CAPTURE_RUNTIME_FILE), 'tampered'),
    ],
    [
      'schema',
      (target) =>
        writeFile(join(target, CAPTURE_DOCUMENT_SCHEMA_FILE), 'tampered'),
    ],
    [
      'executable bytes',
      async (target) => {
        const manifest = await readManifest(target);
        manifest.bytes = Number(manifest.bytes) + 1;
        await writeFile(
          join(target, 'capture-runtime-manifest.json'),
          JSON.stringify(manifest),
        );
      },
    ],
    [
      'executable digest',
      async (target) => {
        const manifest = await readManifest(target);
        manifest.sha256 = '0'.repeat(64);
        await writeFile(
          join(target, 'capture-runtime-manifest.json'),
          JSON.stringify(manifest),
        );
      },
    ],
    [
      'manifest version',
      async (target) => {
        const manifest = await readManifest(target);
        manifest.runtimeVersion = '0.4.0';
        await writeFile(
          join(target, 'capture-runtime-manifest.json'),
          JSON.stringify(manifest),
        );
      },
    ],
    [
      'checksum',
      (target) =>
        writeFile(
          join(target, CAPTURE_RUNTIME_CHECKSUM_FILE),
          `${'0'.repeat(64)}  ${CAPTURE_RUNTIME_FILE}\n`,
        ),
    ],
    [
      'platform',
      async (target) => {
        const manifest = await readManifest(target);
        manifest.platform = 'linux';
        await writeFile(
          join(target, 'capture-runtime-manifest.json'),
          JSON.stringify(manifest),
        );
      },
    ],
    [
      'file name',
      async (target) => {
        const manifest = await readManifest(target);
        manifest.fileName = 'capture-runtime-other.exe';
        await writeFile(
          join(target, 'capture-runtime-manifest.json'),
          JSON.stringify(manifest),
        );
      },
    ],
    [
      'schema file name',
      async (target) => {
        const manifest = await readManifest(target);
        manifest.schemaFileName = 'capture-document-other.schema.json';
        await writeFile(
          join(target, 'capture-runtime-manifest.json'),
          JSON.stringify(manifest),
        );
      },
    ],
    [
      'unexpected artifact',
      (target) => writeFile(join(target, 'unexpected.txt'), 'rejected'),
    ],
  ];
  for (const [label, mutation] of mutations) {
    const isolated = await cloneFixture(root);
    await mutation(isolated);
    await assert.rejects(
      verifyCaptureRuntimeReleaseDirectory(isolated),
      /mismatch|incompatible|checksum|platform|does not match|must be|canonical/iu,
      label,
    );
  }
});

test('rejects HTTP redirects instead of following them', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(302, { Location: 'http://127.0.0.1:1/v0.3.8' }).end();
  });
  servers.push(server);
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Redirect server did not expose a port.');
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-redirect-'),
  );
  temporaryRoots.push(workspaceRoot);

  await assert.rejects(
    installCaptureRuntime({
      workspaceRoot,
      baseUrl: `http://127.0.0.1:${address.port}/v${CAPTURE_RUNTIME_VERSION}`,
    }),
    /redirect|fetch failed|network/iu,
  );
});

test('accepts only versioned secure release base URLs', () => {
  assert.equal(
    validateCaptureRuntimeReleaseBaseUrl('http://127.0.0.1:4873/v0.3.11'),
    'http://127.0.0.1:4873/v0.3.11',
  );
  for (const value of [
    'http://localhost:4873/v0.3.8',
    'http://192.168.1.10:4873/v0.3.8',
    'https://user:secret@example.test/v0.3.8',
    'https://example.test/v0.2.0',
    'https://example.test/v0.3.8?token=secret',
    'https://example.test/v0.3.8/%2e%2e',
  ]) {
    assert.throws(
      () => validateCaptureRuntimeReleaseBaseUrl(value),
      /versioned URL|HTTP only|credentials|query|fragment|path separators/iu,
    );
  }
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-release-'),
  );
  temporaryRoots.push(root);
  const executable = 'runtime executable';
  const schema = await readFile(schemaPath, 'utf8');
  const digest = createHash('sha256').update(executable).digest('hex');
  const manifest = {
    manifestVersion: '1',
    runtimeVersion: CAPTURE_RUNTIME_VERSION,
    apiVersion: '1.0',
    captureDocumentSchemaVersion: '1',
    platform: 'windows',
    arch: 'x86_64',
    fileName: CAPTURE_RUNTIME_FILE,
    bytes: Buffer.byteLength(executable),
    sha256: digest,
    schemaFileName: CAPTURE_DOCUMENT_SCHEMA_FILE,
    schemaSha256: CAPTURE_DOCUMENT_SCHEMA_SHA256,
  };
  await writeFile(join(root, CAPTURE_RUNTIME_FILE), executable);
  await writeFile(
    join(root, CAPTURE_RUNTIME_CHECKSUM_FILE),
    `${digest}  ${CAPTURE_RUNTIME_FILE}\n`,
  );
  await writeFile(
    join(root, 'capture-runtime-manifest.json'),
    JSON.stringify(manifest),
  );
  await writeFile(join(root, CAPTURE_DOCUMENT_SCHEMA_FILE), schema);
  return root;
}

async function readManifest(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(root, 'capture-runtime-manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
}

async function cloneFixture(source: string): Promise<string> {
  const target = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-release-copy-'),
  );
  temporaryRoots.push(target);
  for (const name of CAPTURE_RUNTIME_RELEASE_ASSETS) {
    await writeFile(join(target, name), await readFile(join(source, name)));
  }
  return target;
}

async function startMirror(root: string): Promise<string> {
  const server = createServer((request, response) => {
    const name = request.url?.split('/').at(-1);
    if (
      request.method !== 'GET' ||
      !name ||
      !CAPTURE_RUNTIME_RELEASE_ASSETS.includes(name)
    ) {
      response.writeHead(404).end();
      return;
    }
    createReadStream(join(root, name)).pipe(response);
  });
  servers.push(server);
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Mirror did not expose a port.');
  return `http://127.0.0.1:${address.port}/v${CAPTURE_RUNTIME_VERSION}`;
}
