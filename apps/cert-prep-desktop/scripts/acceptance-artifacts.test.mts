import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectAcceptanceArtifactInputs,
  sanitizeAcceptanceFixtureMetadata,
  writeAcceptanceManifest,
} from './acceptance-artifacts.mts';

test('acceptance artifacts exclude isolated app data and redact logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cert-acceptance-artifacts-'));
  try {
    const artifactRoot = join(
      root,
      'output',
      'playwright',
      'cert-prep',
      'run-1',
    );
    const screenshot = join(artifactRoot, 'ready.png');
    const log = join(artifactRoot, 'run.log');
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(screenshot, Buffer.from('png'));
    await writeFile(
      log,
      'Authorization: Bearer secret-token at C:\\Users\\Private\\fixture.pdf',
    );
    await mkdir(join(artifactRoot, 'app-data'), { recursive: true });
    await mkdir(join(artifactRoot, 'runtime'), { recursive: true });
    await writeFile(
      join(artifactRoot, 'app-data', 'private.json'),
      JSON.stringify({ raw: 'evidence' }),
    );
    await writeFile(
      join(artifactRoot, 'runtime', 'private.db'),
      Buffer.from('database'),
    );

    const artifacts = await collectAcceptanceArtifactInputs(artifactRoot);
    assert.deepEqual(
      artifacts.map((artifact) => artifact.path),
      [screenshot, log],
    );

    await writeAcceptanceManifest(artifactRoot, {
      project: 'cert-prep',
      runId: 'run-1',
      status: 'failed',
      recordVideo: false,
      artifacts,
      errors: ['Authorization: Bearer secret-token'],
      consoleErrors: [],
      pageErrors: [],
      cleanup: {
        app: false,
        sidecar: false,
        cdpPort: false,
        temporaryAppData: false,
      },
    });

    assert.doesNotMatch(
      await readFile(log, 'utf8'),
      /secret-token|C:\\Users\\Private/u,
    );
    assert.doesNotMatch(
      await readFile(join(artifactRoot, 'acceptance-manifest.json'), 'utf8'),
      /secret-token|C:\\Users\\Private/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance rejects an escaped artifact before sanitizing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cert-acceptance-containment-'));
  try {
    const artifactRoot = join(root, 'artifacts');
    const outsideLog = join(root, 'outside.log');
    const original =
      'Authorization: Bearer must-remain-untouched at C:\\Users\\Private\\fixture.pdf';
    await writeFile(outsideLog, original, 'utf8');

    await assert.rejects(
      writeAcceptanceManifest(artifactRoot, {
        project: 'cert-prep',
        runId: 'run-escaped',
        status: 'failed',
        recordVideo: false,
        artifacts: [{ path: outsideLog, kind: 'log' }],
        errors: [],
        consoleErrors: [],
        pageErrors: [],
        cleanup: {},
      }),
      /escaped its isolated output root/u,
    );
    assert.equal(await readFile(outsideLog, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance persistence omits private fixture basenames from manifests and source suites', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'cert-acceptance-private-fixture-'),
  );
  try {
    const artifactRoot = join(
      root,
      'output',
      'playwright',
      'cert-prep',
      'run-private-fixture',
    );
    const privateFixtureName = 'private-exam-2026.pdf';
    const sourceHash = 'a'.repeat(64);
    const sourceSuite = {
      pdf: {
        fixture: { name: privateFixtureName, sha256: sourceHash },
      },
    };
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(
      join(artifactRoot, 'acceptance-sources.json'),
      `${JSON.stringify(sanitizeAcceptanceFixtureMetadata(sourceSuite))}\n`,
      'utf8',
    );

    await writeAcceptanceManifest(artifactRoot, {
      project: 'cert-prep',
      runId: 'run-private-fixture',
      status: 'completed',
      recordVideo: false,
      artifacts: [],
      errors: [],
      consoleErrors: [],
      pageErrors: [],
      cleanup: {},
      fixture: { name: privateFixtureName, sha256: sourceHash },
      fixtures: sourceSuite,
    });

    const sourceSuiteText = await readFile(
      join(artifactRoot, 'acceptance-sources.json'),
      'utf8',
    );
    const manifestText = await readFile(
      join(artifactRoot, 'acceptance-manifest.json'),
      'utf8',
    );
    assert.doesNotMatch(sourceSuiteText, /private-exam-2026\.pdf/u);
    assert.doesNotMatch(manifestText, /private-exam-2026\.pdf/u);
    const manifest = JSON.parse(manifestText) as {
      fixture?: unknown;
      fixtures?: { pdf?: { fixture?: unknown } };
    };
    assert.deepEqual(manifest.fixture, { sha256: sourceHash });
    assert.deepEqual(manifest.fixtures?.pdf?.fixture, { sha256: sourceHash });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
