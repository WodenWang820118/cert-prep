import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  CAPTURE_RUNTIME_CHECKSUM_FILE,
  CAPTURE_RUNTIME_FILE,
  CAPTURE_RUNTIME_OPTIONAL_RELEASE_ASSETS,
  CAPTURE_RUNTIME_RELEASE_ASSETS,
  DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL,
  downloadAsset,
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
  'apps/cert-prep-desktop/test-fixtures/capture-document-v2.schema.json',
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

test(`pins the canonical gx-capture v${CAPTURE_RUNTIME_VERSION} release URL`, () => {
  const expected = `https://github.com/gx-capture/capture-workbench/releases/download/v${CAPTURE_RUNTIME_VERSION}`;
  assert.equal(DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL, expected);
  assert.equal(validateCaptureRuntimeReleaseBaseUrl(expected), expected);
});

test('pins the published CaptureDocument schema bytes', async () => {
  const schema = await readFile(schemaPath);
  assert.equal(
    createHash('sha256').update(schema).digest('hex'),
    CAPTURE_DOCUMENT_SCHEMA_SHA256,
  );
  assert.equal(
    JSON.parse(schema.toString('utf8')).$id,
    'https://github.com/gx-capture/capture-workbench/schema/capture-document-v2.schema.json',
  );
});

test('installs a valid release with its checksum sidecar and reuses identical staging', async () => {
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
    [
      ...CAPTURE_RUNTIME_RELEASE_ASSETS,
      ...CAPTURE_RUNTIME_OPTIONAL_RELEASE_ASSETS,
    ].sort(),
  );
  assert.equal(
    await readFile(join(first.outputRoot, CAPTURE_RUNTIME_FILE), 'utf8'),
    'runtime executable',
  );
});

test('installs a release that publishes no checksum sidecar', async () => {
  const root = await createFixture({ checksumSidecar: false });
  const mirror = await startMirror(root);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-test-'),
  );
  temporaryRoots.push(workspaceRoot);

  const installed = await installCaptureRuntime({
    workspaceRoot,
    baseUrl: mirror,
  });

  assert.deepEqual(
    (await readdir(installed.outputRoot)).sort(),
    [...CAPTURE_RUNTIME_RELEASE_ASSETS].sort(),
  );
  assert.equal(
    (await installCaptureRuntime({ workspaceRoot, baseUrl: mirror }))
      .outputRoot,
    installed.outputRoot,
  );
});

test('fails when the checksum sidecar download fails with anything but 404', async () => {
  const root = await createFixture();
  const mirror = await startMirror(
    root,
    new Map([[CAPTURE_RUNTIME_CHECKSUM_FILE, 403]]),
  );
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-test-'),
  );
  temporaryRoots.push(workspaceRoot);

  await assert.rejects(
    installCaptureRuntime({ workspaceRoot, baseUrl: mirror }),
    /download failed with HTTP 403/u,
  );
});

test('refuses a release whose checksum sidecar disagrees with the manifest', async () => {
  const root = await createFixture();
  await writeFile(
    join(root, CAPTURE_RUNTIME_CHECKSUM_FILE),
    `${'0'.repeat(64)}  ${CAPTURE_RUNTIME_FILE}\n`,
  );
  const mirror = await startMirror(root);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-test-'),
  );
  temporaryRoots.push(workspaceRoot);

  await assert.rejects(
    installCaptureRuntime({ workspaceRoot, baseUrl: mirror }),
    /checksum file does not match the manifest/u,
  );
});

test('installs through the GitHub API when the release lists no checksum sidecar', async () => {
  const root = await createFixture({ checksumSidecar: false });
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-api-test-'),
  );
  temporaryRoots.push(workspaceRoot);
  const assetApiUrl = (name: string): string =>
    `https://api.github.com/repos/gx-capture/capture-workbench/releases/assets/${encodeURIComponent(name)}`;

  const mockFetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes('/releases/download/')) {
      return new Response('Gateway Timeout', { status: 504 });
    }
    if (url.includes('/releases/tags/')) {
      return new Response(
        JSON.stringify({
          assets: CAPTURE_RUNTIME_RELEASE_ASSETS.map((name) => ({
            name,
            url: assetApiUrl(name),
          })),
        }),
        { status: 200 },
      );
    }
    const name = CAPTURE_RUNTIME_RELEASE_ASSETS.find(
      (candidate) => url === assetApiUrl(candidate),
    );
    if (name) {
      return new Response(new Uint8Array(await readFile(join(root, name))), {
        status: 200,
      });
    }
    throw new Error(`Unexpected request to ${url}`);
  }) as typeof fetch;

  const installed = await installCaptureRuntime({
    workspaceRoot,
    baseUrl: DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL,
    fetch: mockFetch,
    sleep: () => Promise.resolve(),
    retryDelays: [0],
  });

  assert.deepEqual(
    (await readdir(installed.outputRoot)).sort(),
    [...CAPTURE_RUNTIME_RELEASE_ASSETS].sort(),
  );
});

test('installs a local release directory that has no checksum sidecar', async () => {
  const root = await createFixture({ checksumSidecar: false });
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'cert-prep-capture-runtime-local-test-'),
  );
  temporaryRoots.push(workspaceRoot);

  const installed = await installCaptureRuntime({
    workspaceRoot,
    releaseDirectory: root,
  });

  assert.deepEqual(
    (await readdir(installed.outputRoot)).sort(),
    [...CAPTURE_RUNTIME_RELEASE_ASSETS].sort(),
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
    [
      ...CAPTURE_RUNTIME_RELEASE_ASSETS,
      ...CAPTURE_RUNTIME_OPTIONAL_RELEASE_ASSETS,
    ].sort(),
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

for (const checksumSidecar of [true, false]) {
test(`rejects executable, schema, manifest, checksum, platform and unknown-file drift ${checksumSidecar ? 'with' : 'without'} a checksum sidecar`, async () => {
  const root = await createFixture({ checksumSidecar });
  assert.equal(
    (await verifyCaptureRuntimeReleaseDirectory(await cloneFixture(root)))
      .sha256,
    createHash('sha256').update('runtime executable').digest('hex'),
  );
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
        manifest.runtimeVersion = '99.0.0';
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
}

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
    validateCaptureRuntimeReleaseBaseUrl(
      `http://127.0.0.1:4873/v${CAPTURE_RUNTIME_VERSION}`,
    ),
    `http://127.0.0.1:4873/v${CAPTURE_RUNTIME_VERSION}`,
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

test('retries public download on 5xx and succeeds without API fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-prep-test-'));
  temporaryRoots.push(dir);
  const destination = join(dir, 'artifact.bin');

  const sleeps: number[] = [];
  const requestedUrls: string[] = [];
  let attempts = 0;

  const mockFetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    requestedUrls.push(url);
    attempts += 1;
    if (attempts === 1) {
      return new Response('gateway timeout', { status: 504 });
    }
    return new Response('artifact content', { status: 200 });
  }) as typeof fetch;

  await downloadAsset(
    DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL,
    'artifact.bin',
    destination,
    {
      fetch: mockFetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retryDelays: [1000, 2000],
    },
  );

  assert.equal(await readFile(destination, 'utf8'), 'artifact content');
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.ok(requestedUrls.every((url) => !url.includes('api.github.com')));
});

test('falls back to GitHub API when public download persistently fails with 5xx', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-prep-test-'));
  temporaryRoots.push(dir);
  const destination = join(dir, 'artifact.bin');

  const sleeps: number[] = [];
  const requestedUrls: string[] = [];
  const assetId = 42;
  const assetApiUrl = `https://api.github.com/repos/gx-capture/capture-workbench/releases/assets/${assetId}`;
  const assetDownloadUrl = 'https://objects.githubusercontent.com/test-asset';

  const mockFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    requestedUrls.push(url);

    if (
      url.includes('github.com/gx-capture/capture-workbench/releases/download')
    ) {
      return new Response('Gateway Timeout', { status: 504 });
    }

    if (
      url.includes(
        'api.github.com/repos/gx-capture/capture-workbench/releases/tags',
      )
    ) {
      return new Response(
        JSON.stringify({
          assets: [
            {
              name: 'artifact.bin',
              url: assetApiUrl,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url === assetApiUrl) {
      assert.equal(
        init?.headers && (init.headers as Record<string, string>)['Accept'],
        'application/octet-stream',
      );
      assert.equal(init?.redirect, 'manual');
      return new Response(null, {
        status: 302,
        headers: { Location: assetDownloadUrl },
      });
    }

    if (url === assetDownloadUrl) {
      assert.equal(init?.redirect, 'error');
      return new Response('fallback asset content', { status: 200 });
    }

    throw new Error(`Unexpected request to ${url}`);
  }) as typeof fetch;

  await downloadAsset(
    DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL,
    'artifact.bin',
    destination,
    {
      fetch: mockFetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retryDelays: [1000, 2000],
    },
  );

  assert.equal(await readFile(destination, 'utf8'), 'fallback asset content');
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.ok(
    requestedUrls.some((url) =>
      url.includes(
        'api.github.com/repos/gx-capture/capture-workbench/releases/tags',
      ),
    ),
  );
  assert.ok(requestedUrls.some((url) => url === assetApiUrl));
  assert.ok(requestedUrls.some((url) => url === assetDownloadUrl));
});

test('accepts asset bytes the GitHub API returns directly with HTTP 200', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-prep-test-'));
  temporaryRoots.push(dir);
  const destination = join(dir, 'artifact.bin');
  const assetApiUrl =
    'https://api.github.com/repos/gx-capture/capture-workbench/releases/assets/7';

  const mockFetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      url.includes('github.com/gx-capture/capture-workbench/releases/download')
    ) {
      return new Response('Gateway Timeout', { status: 504 });
    }
    if (url.includes('/releases/tags/')) {
      return new Response(
        JSON.stringify({
          assets: [{ name: 'artifact.bin', url: assetApiUrl }],
        }),
        { status: 200 },
      );
    }
    if (url === assetApiUrl) {
      return new Response('direct asset content', { status: 200 });
    }
    throw new Error(`Unexpected request to ${url}`);
  }) as typeof fetch;

  await downloadAsset(
    DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL,
    'artifact.bin',
    destination,
    { fetch: mockFetch, sleep: () => Promise.resolve(), retryDelays: [0, 0] },
  );

  assert.equal(await readFile(destination, 'utf8'), 'direct asset content');
});

test('does not retry 4xx errors and does not fall back to API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-prep-test-'));
  temporaryRoots.push(dir);
  const destination = join(dir, 'artifact.bin');

  const sleeps: number[] = [];
  const requestedUrls: string[] = [];

  const mockFetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    requestedUrls.push(url);
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;

  await assert.rejects(
    downloadAsset(
      DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL,
      'artifact.bin',
      destination,
      {
        fetch: mockFetch,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        retryDelays: [1000, 2000],
      },
    ),
    /download failed with HTTP 404/iu,
  );

  assert.equal(requestedUrls.length, 1);
  assert.equal(sleeps.length, 0);
  assert.ok(requestedUrls.every((url) => !url.includes('api.github.com')));
});

test('rejects untrusted redirects from the API download path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-prep-test-'));
  temporaryRoots.push(dir);
  const destination = join(dir, 'artifact.bin');

  const assetApiUrl =
    'https://api.github.com/repos/gx-capture/capture-workbench/releases/assets/99';

  const mockFetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (
      url.includes('github.com/gx-capture/capture-workbench/releases/download')
    ) {
      return new Response('Gateway Timeout', { status: 504 });
    }

    if (
      url.includes(
        'api.github.com/repos/gx-capture/capture-workbench/releases/tags',
      )
    ) {
      return new Response(
        JSON.stringify({
          assets: [{ name: 'artifact.bin', url: assetApiUrl }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url === assetApiUrl) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.attacker.test/malicious-artifact' },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  await assert.rejects(
    downloadAsset(
      DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL,
      'artifact.bin',
      destination,
      {
        fetch: mockFetch,
        sleep: () => Promise.resolve(),
        retryDelays: [0, 0],
      },
    ),
    /untrusted redirect/iu,
  );
});

test('fails with compound error when all download paths fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-prep-test-'));
  temporaryRoots.push(dir);
  const destination = join(dir, 'artifact.bin');

  const mockFetch = (async (): Promise<Response> => {
    return new Response('Gateway Timeout', { status: 504 });
  }) as typeof fetch;

  await assert.rejects(
    downloadAsset(
      DEFAULT_CAPTURE_RUNTIME_RELEASE_BASE_URL,
      'artifact.bin',
      destination,
      {
        fetch: mockFetch,
        sleep: () => Promise.resolve(),
        retryDelays: [0, 0],
      },
    ),
    /Capture runtime artifact artifact\.bin download failed with HTTP 504 \(public URL and API\)\./,
  );
});

async function createFixture(
  options: { readonly checksumSidecar?: boolean } = {},
): Promise<string> {
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
    apiVersion: '2.0',
    captureDocumentSchemaVersion: '2',
    platform: 'windows',
    arch: 'x86_64',
    fileName: CAPTURE_RUNTIME_FILE,
    bytes: Buffer.byteLength(executable),
    sha256: digest,
    schemaFileName: CAPTURE_DOCUMENT_SCHEMA_FILE,
    schemaSha256: CAPTURE_DOCUMENT_SCHEMA_SHA256,
  };
  await writeFile(join(root, CAPTURE_RUNTIME_FILE), executable);
  // Releases up to 0.9.0 publish this sidecar; later ones do not.
  if (options.checksumSidecar ?? true) {
    await writeFile(
      join(root, CAPTURE_RUNTIME_CHECKSUM_FILE),
      `${digest}  ${CAPTURE_RUNTIME_FILE}\n`,
    );
  }
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
  for (const name of await readdir(source)) {
    await writeFile(join(target, name), await readFile(join(source, name)));
  }
  return target;
}

/** Serves the release assets present in `root`; `statuses` forces an HTTP status per asset. */
async function startMirror(
  root: string,
  statuses: ReadonlyMap<string, number> = new Map(),
): Promise<string> {
  const published = new Set<string>([
    ...CAPTURE_RUNTIME_RELEASE_ASSETS,
    ...CAPTURE_RUNTIME_OPTIONAL_RELEASE_ASSETS,
  ]);
  const server = createServer((request, response) => {
    const name = request.url?.split('/').at(-1);
    const status = name ? statuses.get(name) : undefined;
    if (status !== undefined) {
      response.writeHead(status).end();
      return;
    }
    if (
      request.method !== 'GET' ||
      !name ||
      !published.has(name) ||
      !existsSync(join(root, name))
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
