import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  assertCleanSourceCheckout,
  assertSafeNewOutput,
  inspectLocalCandidateBuild,
  publishCandidateAtomically,
  resolveCommandInvocation,
  validateAssembledRuntimes,
} from './local-candidate.ts';
import {
  LOCAL_NONPUBLISHABLE_PROFILE,
  sha256File,
  writeJson,
} from './release-lib.ts';

const version = '0.1.0-alpha.1';
const target = 'x86_64-pc-windows-msvc';
const sha = 'a'.repeat(40);

test('local candidate inspection binds exact packaged and file URL artifacts', async () => {
  const fixture = await createLocalFixture();
  try {
    const { plan, packageQa } = await inspectLocalCandidateBuild({
      ...fixture,
      commitSha: sha,
      sourceVersions: { fixture: version },
      now: new Date('2026-07-15T00:00:00.000Z'),
    });
    assert.equal(plan.distributionProfile, LOCAL_NONPUBLISHABLE_PROFILE);
    assert.equal(plan.publishable, false);
    assert.equal(plan.commitSha, sha);
    assert.equal(
      `${plan.assetBaseUrl}/${encodeURIComponent(fixture.ocrName)}`,
      pathToFileURL(fixture.ocrArtifact).href,
    );
    const contract = packageQa.package.resource_contract;
    assert.equal(contract.release_urls_only, false);
    assert.equal(contract.local_file_ocr_only, true);
    assert.equal(contract.publishable, false);
    assert.equal(contract.runtime_binding.windowsml_ocr.sha256, fixture.ocrHash);
    assert.equal(packageQa.package.size_gate.status, 'passed');
  } finally {
    fixture.cleanup();
  }
});

test('local candidate inspection rejects an OCR URL outside its runtime root', async () => {
  const fixture = await createLocalFixture();
  try {
    const outside = join(fixture.workspaceRoot, 'outside-ocr.zip');
    writeFileSync(outside, 'ocr-runtime');
    const manifestPath = join(
      fixture.generatedResources,
      'windowsml-ocr-runtime-manifest.json',
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.artifact.url = pathToFileURL(outside).href;
    writeJson(manifestPath, manifest);
    writeJson(
      join(
        fixture.packagedResourceRoot,
        'windowsml-ocr-runtime-manifest.json',
      ),
      manifest,
    );
    await assert.rejects(
      inspectLocalCandidateBuild({
        ...fixture,
        commitSha: sha,
        sourceVersions: {},
      }),
      /does not bind the declared artifact/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('local candidate source check rejects any tracked or untracked change', () => {
  const dirty = (command, args) => {
    assert.equal(command, 'git');
    if (args[0] === 'diff') return 'apps/example.ts\n';
    return 'notes.txt\n';
  };
  assert.throws(
    () => assertCleanSourceCheckout('C:/fixture', dirty),
    /requires a clean source checkout.*apps\/example\.ts.*notes\.txt/,
  );
  assert.doesNotThrow(() =>
    assertCleanSourceCheckout('C:/fixture', () => ''),
  );
});

test('local candidate invokes pnpm through cmd on Windows', () => {
  assert.deepEqual(
    resolveCommandInvocation(
      'pnpm',
      ['licenses', 'list', '--prod', '--json'],
      'win32',
    ),
    {
      executable: process.env.ComSpec || 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'pnpm.cmd licenses list --prod --json',
      ],
    },
  );
  assert.throws(
    () => resolveCommandInvocation('pnpm', ['licenses', '& whoami'], 'win32'),
    /Unsafe Windows pnpm command token/,
  );
  assert.deepEqual(resolveCommandInvocation('pnpm', ['--version'], 'linux'), {
    executable: 'pnpm',
    args: ['--version'],
  });
});

test('atomic publication retries only transient Windows rename failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-local-publish-'));
  try {
    const outputRoot = join(root, 'candidate');
    let calls = 0;
    const waits = [];
    await publishCandidateAtomically(join(root, 'source'), outputRoot, {
      rename: () => {
        calls += 1;
        if (calls < 3) {
          const error = new Error('temporarily locked');
          error.code = calls === 1 ? 'EPERM' : 'EBUSY';
          throw error;
        }
      },
      wait: async (milliseconds) => waits.push(milliseconds),
      attempts: 3,
      retryDelayMs: 5,
    });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [5, 5]);

    const permanent = new Error('invalid source');
    permanent.code = 'ENOENT';
    await assert.rejects(
      publishCandidateAtomically(join(root, 'source'), outputRoot, {
        rename: () => {
          throw permanent;
        },
        wait: async () => assert.fail('permanent errors must not retry'),
      }),
      permanent,
    );

    mkdirSync(outputRoot);
    await assert.rejects(
      publishCandidateAtomically(join(root, 'source'), outputRoot, {
        rename: () => assert.fail('destination races must fail before rename'),
      }),
      /output appeared during publication/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local candidate output is a new direct child of workspace tmp', () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-local-output-'));
  try {
    mkdirSync(join(root, 'tmp'));
    assert.doesNotThrow(() =>
      assertSafeNewOutput(root, join(root, 'tmp', 'candidate')),
    );
    assert.throws(
      () => assertSafeNewOutput(root, join(root, 'tmp', 'nested', 'candidate')),
      /must be a child of workspace tmp/,
    );
    const existing = join(root, 'tmp', 'existing');
    mkdirSync(existing);
    assert.throws(
      () => assertSafeNewOutput(root, existing),
      /already exists/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local candidate inspection rejects case-variant resources and manifest drift', async () => {
  const fixture = await createLocalFixture();
  try {
    const duplicateRoot = join(fixture.packagedResourceRoot, 'nested');
    mkdirSync(duplicateRoot);
    copyFileSync(
      join(fixture.packagedResourceRoot, fixture.backendName),
      join(duplicateRoot, fixture.backendName.toUpperCase()),
    );
    await assert.rejects(
      inspectLocalCandidateBuild({
        ...fixture,
        commitSha: sha,
        sourceVersions: {},
      }),
      /duplicate basenames/,
    );
    rmSync(duplicateRoot, { recursive: true, force: true });

    const manifestPath = join(
      fixture.generatedResources,
      'backend-runtime-manifest.json',
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.entrypoint = 'unexpected.exe';
    writeJson(manifestPath, manifest);
    writeJson(
      join(fixture.packagedResourceRoot, 'backend-runtime-manifest.json'),
      manifest,
    );
    await assert.rejects(
      inspectLocalCandidateBuild({
        ...fixture,
        commitSha: sha,
        sourceVersions: {},
      }),
      /Invalid local python_backend runtime manifest/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('final runtime validation rechecks QA hashes and the source OCR URL', async () => {
  const fixture = await createLocalFixture();
  try {
    const { packageQa } = await inspectLocalCandidateBuild({
      ...fixture,
      commitSha: sha,
      sourceVersions: {},
    });
    const candidateRoot = join(fixture.workspaceRoot, 'candidate');
    const runtimeRoot = join(candidateRoot, 'release', 'runtimes');
    mkdirSync(runtimeRoot, { recursive: true });
    for (const name of [
      'backend-runtime-manifest.json',
      'windowsml-ocr-runtime-manifest.json',
      fixture.backendName,
    ]) {
      copyFileSync(join(fixture.generatedResources, name), join(runtimeRoot, name));
    }
    copyFileSync(fixture.ocrArtifact, join(runtimeRoot, fixture.ocrName));
    await assert.doesNotReject(
      validateAssembledRuntimes(
        candidateRoot,
        fixture.generatedResources,
        fixture.ocrRuntimeRoot,
        packageQa.package.resource_contract.runtime_binding,
      ),
    );
    writeFileSync(fixture.ocrArtifact, 'changed-ocr-runtime');
    await assert.rejects(
      validateAssembledRuntimes(
        candidateRoot,
        fixture.generatedResources,
        fixture.ocrRuntimeRoot,
        packageQa.package.resource_contract.runtime_binding,
      ),
      /windowsml_ocr runtime artifact does not match its manifest/,
    );
  } finally {
    fixture.cleanup();
  }
});

async function createLocalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-local-candidate-'));
  const workspaceRoot = join(root, 'workspace');
  const bundleRoot = join(workspaceRoot, 'target', 'release', 'bundle');
  const generatedResources = join(workspaceRoot, 'generated-resources');
  const ocrRuntimeRoot = join(workspaceRoot, 'ocr-runtime');
  const packagedResourceRoot = join(
    workspaceRoot,
    'target',
    'release',
    'resources',
  );
  const legalRoot = join(workspaceRoot, 'target', 'release', 'legal');
  for (const path of [
    bundleRoot,
    generatedResources,
    ocrRuntimeRoot,
    packagedResourceRoot,
    legalRoot,
    join(workspaceRoot, 'apps', 'cert-prep-desktop', 'src-tauri'),
  ]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(
    join(bundleRoot, `Cert Prep_${version}_x64_en-US.msi`),
    'msi',
  );
  writeFileSync(
    join(bundleRoot, `Cert Prep_${version}_x64-setup.exe`),
    'nsis',
  );

  const backendName = `cert-prep-backend-runtime-${version}-${target}.zip`;
  const backendArtifact = join(generatedResources, backendName);
  writeFileSync(backendArtifact, 'backend-runtime');
  const backendHash = await sha256File(backendArtifact);
  const backendManifest = {
    schema_version: 1,
    kind: 'python_backend',
    version,
    target,
    entrypoint: 'cert-prep-backend.exe',
    artifact: {
      file_name: backendName,
      sha256: backendHash,
      bytes: 15,
      url: null,
    },
  };
  const ocrName = `cert-prep-ocr-windowsml-runtime-${version}-${target}.zip`;
  const ocrArtifact = join(ocrRuntimeRoot, ocrName);
  writeFileSync(ocrArtifact, 'ocr-runtime');
  const ocrHash = await sha256File(ocrArtifact);
  const ocrManifest = {
    schema_version: 1,
    kind: 'windowsml_ocr',
    version,
    target,
    entrypoint: 'cert-prep-ocr-windowsml-runtime.exe',
    artifact: {
      file_name: ocrName,
      sha256: ocrHash,
      bytes: 11,
      url: pathToFileURL(ocrArtifact).href,
    },
  };
  const releaseMetadata = {
    schema_version: 1,
    version,
    windows_msi_version: '0.1.0.1',
    python_runtime_version: '3.12',
    release_tag: `cert-prep-local-v${version}`,
    channel: 'local_nonpublishable',
    distribution_profile: 'local_nonpublishable',
    publishable: false,
    distribution_mode: 'dev',
    signed: false,
    platform: { target },
    warnings: {
      smartscreen:
        'This local acceptance build is unsigned and cannot be published.',
      production_ready: false,
    },
    sha256_verification: { required: true, algorithm: 'SHA-256' },
    runtime_assets: {
      backend: {
        distribution: 'bundled',
        file_name: backendName,
        sha256: backendHash,
        bytes: 15,
      },
      windowsml_ocr: {
        distribution: 'local_file',
        file_name: ocrName,
        sha256: ocrHash,
        bytes: 11,
      },
    },
  };
  for (const [name, value] of [
    ['backend-runtime-manifest.json', backendManifest],
    ['windowsml-ocr-runtime-manifest.json', ocrManifest],
    ['release-metadata.json', releaseMetadata],
  ]) {
    writeJson(join(generatedResources, name), value);
    writeJson(join(packagedResourceRoot, name), value);
  }
  writeFileSync(
    join(packagedResourceRoot, backendName),
    readFileSync(backendArtifact),
  );
  for (const name of [
    'LICENSE',
    'PRIVACY.md',
    'CHANGELOG.md',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    writeFileSync(join(workspaceRoot, name), `${name}\n`);
    writeFileSync(join(legalRoot, name), `${name}\n`);
  }
  writeJson(
    join(
      workspaceRoot,
      'apps',
      'cert-prep-desktop',
      'src-tauri',
      'tauri.conf.json',
    ),
    {
      bundle: {
        resources: {
          'generated-resources/*': 'resources/',
          '../../../LICENSE': 'legal/LICENSE',
          '../../../PRIVACY.md': 'legal/PRIVACY.md',
          '../../../CHANGELOG.md': 'legal/CHANGELOG.md',
          '../../../THIRD_PARTY_NOTICES.md':
            'legal/THIRD_PARTY_NOTICES.md',
        },
      },
    },
  );
  return {
    workspaceRoot,
    bundleRoot,
    generatedResources,
    ocrRuntimeRoot,
    packagedResourceRoot,
    backendName,
    ocrName,
    ocrArtifact,
    ocrHash,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
