import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { buildReleasePlan } from './metadata.ts';
import {
  HARDWARE_CANCELLATION_CHECKS,
  LOCAL_NONPUBLISHABLE_PROFILE,
  PUBLIC_UNSIGNED_ALPHA_PROFILE,
  assertExternalConfirmations,
  assertPublishableReleasePlan,
  assertReleaseInvocationContext,
  collectLicensedComponents,
  createSpdxDocument,
  deriveReleaseIdentity,
  normalizeLicense,
  planAssetUploads,
  sha256File,
  validateHardwareResult,
  windowsMsiVersionFor,
  writeReleaseDocuments,
} from './release-lib.ts';
import { assertReleaseState } from './publish-assets.ts';

const sha = 'a'.repeat(40);

test('file hashing closes its Windows handle before resolving', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-release-hash-'));
  const destination = `${root}-renamed`;
  try {
    const file = join(root, 'candidate.bin');
    writeFileSync(file, 'candidate-bytes');
    assert.equal(
      await sha256File(file),
      'e8b471c16cc972d5e5e5be6ae2f93fecaf4e6c3dacbe15334bbcfc0b9a9d8eec',
    );
    renameSync(root, destination);
    assert.equal(existsSync(join(destination, 'candidate.bin')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test('legacy Cargo slash license shorthands normalize to SPDX OR expressions', () => {
  assert.equal(normalizeLicense('MIT/Apache-2.0'), 'MIT OR Apache-2.0');
  assert.equal(normalizeLicense('Apache-2.0 / MIT'), 'Apache-2.0 OR MIT');
  assert.equal(normalizeLicense('BSD-3-Clause/MIT'), 'BSD-3-Clause OR MIT');
  assert.equal(normalizeLicense('Unlicense/MIT'), 'Unlicense OR MIT');
});

test('license policy accepts only explicitly reviewed SPDX expressions', () => {
  assert.equal(
    normalizeLicense('(Apache-2.0 OR MIT) AND BSD-3-Clause'),
    '(Apache-2.0 OR MIT) AND BSD-3-Clause',
  );
  assert.equal(
    normalizeLicense('Apache-2.0 WITH LLVM-exception OR MIT'),
    'Apache-2.0 WITH LLVM-exception OR MIT',
  );
  assert.equal(
    normalizeLicense('GPL-2.0-or-later WITH Bootloader-exception'),
    'GPL-2.0-or-later WITH Bootloader-exception',
  );
  for (const rejected of [
    'AGPL-3.0-only',
    'BUSL-1.1',
    'SSPL-1.0',
    'TotallyUnknown-1.0',
    'GPL-2.0-or-later',
    'MIT WITH Bootloader-exception',
  ]) {
    assert.equal(normalizeLicense(rejected), null, rejected);
  }
});

test('release identity derives and validates the canonical alpha tag', () => {
  const identity = deriveReleaseIdentity({
    eventName: 'workflow_dispatch',
    refName: 'main',
    requestedVersion: '0.1.0-alpha.1',
    repository: 'owner/cert-prep',
    commitSha: sha,
  });

  assert.equal(identity.tag, 'cert-prep-v0.1.0-alpha.1');
  assert.equal(
    identity.assetBaseUrl,
    'https://github.com/owner/cert-prep/releases/download/cert-prep-v0.1.0-alpha.1',
  );
  assert.equal(identity.channel, 'unsigned_public_alpha');
  assert.equal(identity.distributionProfile, PUBLIC_UNSIGNED_ALPHA_PROFILE);
  assert.equal(identity.publishable, true);
  assert.equal(identity.signed, false);
  assert.equal(identity.windowsMsiVersion, '0.1.0.1');
  assert.equal(identity.pythonRuntimeVersion, '3.12');
});

test('public alpha maps to a deterministic MSI-safe numeric version', () => {
  assert.equal(windowsMsiVersionFor('0.1.0-alpha.1'), '0.1.0.1');
  assert.throws(
    () => windowsMsiVersionFor('0.1.0-alpha.65536'),
    /exceeds MSI field limits/,
  );
});

test('tag events fail when tag and version cannot be made identical', () => {
  assert.throws(
    () =>
      deriveReleaseIdentity({
        eventName: 'push',
        refName: 'cert-prep-v0.1.0-alpha.2',
        requestedVersion: '0.1.0-alpha.1',
        repository: 'owner/cert-prep',
        commitSha: sha,
      }),
    /does not match release version/,
  );
});

test('release invocation pins repository and canonical source ref', () => {
  const base = {
    defaultBranch: 'main',
    repository: 'owner/cert-prep',
    expectedRepository: 'owner/cert-prep',
    tag: 'cert-prep-v0.1.0-alpha.1',
  };
  assert.doesNotThrow(() =>
    assertReleaseInvocationContext({
      ...base,
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/main',
      refName: 'main',
    }),
  );
  assert.doesNotThrow(() =>
    assertReleaseInvocationContext({
      ...base,
      eventName: 'push',
      ref: 'refs/tags/cert-prep-v0.1.0-alpha.1',
      refName: 'cert-prep-v0.1.0-alpha.1',
    }),
  );
  assert.throws(
    () =>
      assertReleaseInvocationContext({
        ...base,
        expectedRepository: 'other/cert-prep',
        eventName: 'workflow_dispatch',
        ref: 'refs/heads/main',
        refName: 'main',
      }),
    /does not match pinned release repository/,
  );
  assert.throws(
    () =>
      assertReleaseInvocationContext({
        ...base,
        eventName: 'workflow_dispatch',
        ref: 'refs/heads/feature/release',
        refName: 'feature/release',
      }),
    /must run from default branch main/,
  );
  assert.throws(
    () =>
      assertReleaseInvocationContext({
        ...base,
        eventName: 'push',
        ref: 'refs/tags/cert-prep-v0.1.0-alpha.2',
        refName: 'cert-prep-v0.1.0-alpha.1',
      }),
    /must run from canonical ref/,
  );
});

test('external alpha prerequisites are fail-closed', () => {
  assert.throws(
    () =>
      assertExternalConfirmations({
        publicRepository: 'true',
        protectedReleaseEnvironment: 'false',
        hardwareRunner: 'false',
      }),
    /protectedReleaseEnvironment, hardwareRunner/,
  );
});

test('metadata validates every source release version', () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-release-metadata-'));
  try {
    mkdirSync(join(root, 'apps/cert-prep-desktop/src-tauri'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'apps/cert-prep-desktop/src-tauri/tauri.conf.json'),
      JSON.stringify({
        version: '0.1.0-alpha.1',
        bundle: { windows: { wix: { version: '0.1.0.1' } } },
      }),
    );
    writeFileSync(
      join(root, 'apps/cert-prep-desktop/src-tauri/Cargo.toml'),
      '[package]\nname = "cert-prep-desktop"\nversion = "0.1.0-alpha.1"\n',
    );
    writeFileSync(join(root, '.python-version'), '3.12\n');
    for (const path of [
      'apps/cert-prep-backend',
      'packages/cert-prep-contracts',
      'packages/cert-prep-ocr-windowsml',
      'packages/cert-prep-ollama',
    ]) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(
        join(root, path, 'pyproject.toml'),
        '[project]\nname = "fixture"\nversion = "0.1.0-alpha.1"\n',
      );
    }
    mkdirSync(join(root, 'apps/cert-prep-backend/src/cert_prep_backend'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'apps/cert-prep-backend/src/cert_prep_backend/__init__.py'),
      '__version__ = "0.1.0-alpha.1"\n',
    );
    mkdirSync(join(root, 'apps/cert-prep-desktop/scripts/package-qa'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'apps/cert-prep-desktop/scripts/package-qa/constants.mts'),
      [
        "export const ALPHA_VERSION = '0.1.0-alpha.1';",
        "export const WINDOWS_MSI_VERSION = '0.1.0.1';",
        "export const PYTHON_RUNTIME_VERSION = '3.12';",
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'apps/cert-prep-backend/project.json'),
      JSON.stringify({
        targets: Object.fromEntries(
          ['build-backend-runtime', 'build-ocr-runtime-windowsml'].map(
            (name) => [
              name,
              {
                options: {
                  command:
                    'uv run --isolated --python 3.12 python build.py --target x86_64-pc-windows-msvc --version 0.1.0-alpha.1',
                },
              },
            ],
          ),
        ),
      }),
    );
    const plan = buildReleasePlan({
      'event-name': 'workflow_dispatch',
      ref: 'refs/heads/main',
      'ref-name': 'main',
      'default-branch': 'main',
      version: '0.1.0-alpha.1',
      repository: 'owner/cert-prep',
      'expected-repository': 'owner/cert-prep',
      sha,
      'workspace-root': root,
      'public-repository-confirmed': 'true',
      'release-environment-protected': 'true',
      'hardware-runner-ready': 'true',
    });
    assert.deepEqual(plan.sourceVersions, {
      tauriVersion: '0.1.0-alpha.1',
      cargoVersion: '0.1.0-alpha.1',
      windowsMsiVersion: '0.1.0.1',
      backendProjectVersion: '0.1.0-alpha.1',
      contractsProjectVersion: '0.1.0-alpha.1',
      ocrProjectVersion: '0.1.0-alpha.1',
      ollamaProjectVersion: '0.1.0-alpha.1',
      backendRuntimeVersion: '0.1.0-alpha.1',
      pythonRuntimeVersion: '3.12',
      packageQaAlphaVersion: '0.1.0-alpha.1',
      packageQaWindowsMsiVersion: '0.1.0.1',
      packageQaPythonRuntimeVersion: '3.12',
    });
    assert.equal(plan.windowsMsiVersion, '0.1.0.1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('license inventory normalizes ecosystems and rejects unknown licenses', () => {
  const components = collectLicensedComponents({
    nodeLicenses: {
      MIT: [{ name: 'node-package', versions: ['1.0.0'], license: 'MIT' }],
    },
    pythonLicenses: [
      { name: 'python-package', version: '2.0.0', license: 'MIT License' },
    ],
    cargoMetadata: {
      packages: [
        {
          name: 'rust-package',
          version: '3.0.0',
          license: 'Apache-2.0',
          source: 'registry',
        },
      ],
    },
  });
  assert.deepEqual(
    components.map((item) => item.license),
    ['Apache-2.0', 'MIT', 'MIT'],
  );

  assert.throws(
    () =>
      collectLicensedComponents({
        nodeLicenses: {},
        pythonLicenses: [
          { name: 'unknown-package', version: '1.0.0', license: null },
        ],
        cargoMetadata: { packages: [] },
      }),
    /missing or unsupported license metadata/,
  );
  assert.throws(
    () =>
      collectLicensedComponents({
        nodeLicenses: {},
        pythonLicenses: [
          {
            name: 'proprietary-package',
            version: '1.0.0',
            license: 'Custom license',
          },
        ],
        cargoMetadata: { packages: [] },
      }),
    /missing or unsupported license metadata/,
  );
});

test('release documents contain checksums, SPDX, CycloneDX and unsigned metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-release-docs-'));
  try {
    mkdirSync(join(root, 'installers'), { recursive: true });
    writeFileSync(join(root, 'installers', 'cert-prep.msi'), 'installer');
    const plan = deriveReleaseIdentity({
      eventName: 'workflow_dispatch',
      refName: 'main',
      requestedVersion: '0.1.0-alpha.1',
      repository: 'owner/cert-prep',
      commitSha: sha,
    });
    await writeReleaseDocuments({
      releaseRoot: root,
      plan,
      components: [
        {
          ecosystem: 'npm',
          name: 'dependency',
          version: '1.0.0',
          license: 'MIT',
          purl: 'pkg:npm/dependency@1.0.0',
          licenseTexts: [
            { name: 'LICENSE', text: 'MIT license text', primary: true },
          ],
        },
      ],
    });
    assert.match(
      readFileSync(join(root, 'SHA256SUMS'), 'utf8'),
      /\*cert-prep\.msi/,
    );
    const spdx = JSON.parse(
      readFileSync(join(root, 'metadata', 'cert-prep-alpha.spdx.json'), 'utf8'),
    );
    const cdx = JSON.parse(
      readFileSync(join(root, 'metadata', 'cert-prep-alpha.cdx.json'), 'utf8'),
    );
    const metadata = JSON.parse(
      readFileSync(join(root, 'metadata', 'release-metadata.json'), 'utf8'),
    );
    assert.equal(spdx.spdxVersion, 'SPDX-2.3');
    assert.equal(cdx.specVersion, '1.6');
    assert.equal(metadata.channel, 'unsigned_public_alpha');
    assert.equal(metadata.signed, false);
    const inventory = JSON.parse(
      readFileSync(join(root, 'metadata', 'license-inventory.json'), 'utf8'),
    );
    assert.equal(inventory.components[0].licenseTextRefs.length, 1);
    assert.equal(
      existsSync(join(root, inventory.components[0].licenseTextRefs[0].path)),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release documents fail closed when no required license text exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-release-license-text-'));
  try {
    const plan = deriveReleaseIdentity({
      eventName: 'workflow_dispatch',
      refName: 'main',
      requestedVersion: '0.1.0-alpha.1',
      repository: 'owner/cert-prep',
      commitSha: sha,
    });
    await assert.rejects(
      writeReleaseDocuments({
        releaseRoot: root,
        plan,
        components: [
          {
            ecosystem: 'npm',
            name: 'missing-license-text',
            version: '1.0.0',
            license: 'MIT',
            purl: 'pkg:npm/missing-license-text@1.0.0',
            licenseTexts: [],
          },
        ],
      }),
      /missing required license text/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compound licenses reuse text-backed atomic license fallbacks', async () => {
  const root = mkdtempSync(
    join(tmpdir(), 'cert-prep-release-license-fallback-'),
  );
  try {
    const plan = deriveReleaseIdentity({
      eventName: 'workflow_dispatch',
      refName: 'main',
      requestedVersion: '0.1.0-alpha.1',
      repository: 'owner/cert-prep',
      commitSha: sha,
    });
    await writeReleaseDocuments({
      releaseRoot: root,
      plan,
      components: [
        {
          ecosystem: 'npm',
          name: 'apache-source',
          version: '1.0.0',
          license: 'Apache-2.0',
          purl: 'pkg:npm/apache-source@1.0.0',
          licenseTexts: [
            { name: 'LICENSE', text: 'Apache license text', primary: true },
          ],
        },
        {
          ecosystem: 'npm',
          name: 'mit-source',
          version: '1.0.0',
          license: 'MIT',
          purl: 'pkg:npm/mit-source@1.0.0',
          licenseTexts: [
            { name: 'LICENSE', text: 'MIT license text', primary: true },
          ],
        },
        {
          ecosystem: 'npm',
          name: 'compound-without-files',
          version: '1.0.0',
          license: 'Apache-2.0 AND MIT',
          purl: 'pkg:npm/compound-without-files@1.0.0',
          licenseTexts: [],
        },
      ],
    });
    const inventory = JSON.parse(
      readFileSync(join(root, 'metadata', 'license-inventory.json'), 'utf8'),
    );
    const compound = inventory.components.find(
      (item) => item.name === 'compound-without-files',
    );
    assert.equal(compound.licenseTextRefs.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pinned SPDX canonical text covers a missing LGPL text', async () => {
  const root = mkdtempSync(
    join(tmpdir(), 'cert-prep-release-canonical-license-'),
  );
  try {
    const plan = deriveReleaseIdentity({
      eventName: 'workflow_dispatch',
      refName: 'main',
      requestedVersion: '0.1.0-alpha.1',
      repository: 'owner/cert-prep',
      commitSha: sha,
    });
    await writeReleaseDocuments({
      releaseRoot: root,
      plan,
      components: [
        {
          ecosystem: 'cargo',
          name: 'r-efi',
          version: '5.3.0',
          license: 'MIT OR Apache-2.0 OR LGPL-2.1-or-later',
          purl: 'pkg:cargo/r-efi@5.3.0',
          licenseTexts: [],
        },
        {
          ecosystem: 'cargo',
          name: 'permissive-source',
          version: '1.0.0',
          license: 'MIT OR Apache-2.0',
          purl: 'pkg:cargo/permissive-source@1.0.0',
          licenseTexts: [
            { name: 'LICENSE', text: 'MIT and Apache text', primary: true },
          ],
        },
      ],
    });
    const inventory = JSON.parse(
      readFileSync(join(root, 'metadata', 'license-inventory.json'), 'utf8'),
    );
    const rEfi = inventory.components.find((item) => item.name === 'r-efi');
    assert.equal(rEfi.licenseTextRefs.length >= 2, true);
    assert.equal(
      rEfi.licenseTextRefs.some((ref) => ref.source?.includes('/spdx/')),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no-clobber planner only reuses identical digests', () => {
  const desired = [
    { name: 'ocr.zip', path: 'ocr.zip', sha256: '1'.repeat(64) },
  ];
  assert.deepEqual(
    planAssetUploads(
      [{ name: 'ocr.zip', digest: `sha256:${'1'.repeat(64)}` }],
      desired,
    ),
    { upload: [], reuse: desired },
  );
  assert.throws(
    () =>
      planAssetUploads(
        [{ name: 'ocr.zip', digest: `sha256:${'2'.repeat(64)}` }],
        desired,
      ),
    /different digest/,
  );
});

test('hardware evidence requires exact Ollama attribution and four PDFs', () => {
  const plan = deriveReleaseIdentity({
    eventName: 'workflow_dispatch',
    refName: 'main',
    requestedVersion: '0.1.0-alpha.1',
    repository: 'owner/cert-prep',
    commitSha: sha,
  });
  const evidence = {
    schemaVersion: 1,
    version: plan.version,
    tag: plan.tag,
    commitSha: plan.commitSha,
    candidateId: 'e'.repeat(64),
    candidateShaVerified: true,
    harnessSha256: 'c'.repeat(64),
    cleanSnapshot: true,
    windowsMlProvider: 'windowsml',
    configuredProvider: 'ollama',
    effectiveProvider: 'ollama',
    configuredModel: 'qwen3.5:4b',
    effectiveModel: 'qwen3.5:4b',
    providerFallback: false,
    modelFallback: false,
    generationReadyAtStart: true,
    resourcesReleasedAtEnd: true,
    fullExamQuestionCountPositive: true,
    sessionRestartPassed: true,
    sessionRestart: {
      passed: true,
      path: 'session-restart.json',
      bytes: 100,
      sha256: '1'.repeat(64),
    },
    cancellation: Object.fromEntries(
      HARDWARE_CANCELLATION_CHECKS.map((key) => [
        key,
        {
          passed: true,
          path: `cancellation/${key}.json`,
          bytes: 100,
          sha256: 'd'.repeat(64),
        },
      ]),
    ),
    processResidueCount: 0,
    pdfs: Array.from({ length: 4 }, (_, index) => ({
      name: `pdf-${index}`,
      usableQuestions: 1,
      fullExamQuestionCount: 1,
    })),
    acceptance: {
      runId: 'acceptance-run-0001',
      startedAt: '2026-07-11T01:00:01.000Z',
      completedAt: '2026-07-11T01:00:04.000Z',
      completed: true,
    },
    recording: {
      path: 'recording.webm',
      captureSource: 'playwright_screencast',
      bytes: 10,
      sha256: 'f'.repeat(64),
      acceptanceRunId: 'acceptance-run-0001',
      startedAt: '2026-07-11T01:00:00.000Z',
      completedAt: '2026-07-11T01:00:05.000Z',
    },
  };
  assert.equal(
    validateHardwareResult(evidence, plan, 'e'.repeat(64)),
    evidence,
  );
  assert.throws(
    () =>
      validateHardwareResult(
        { ...evidence, effectiveModel: 'qwen3.5:2b' },
        plan,
        'e'.repeat(64),
      ),
    /effectiveModel/,
  );
  assert.throws(
    () =>
      validateHardwareResult(
        { ...evidence, sessionRestart: undefined },
        plan,
        'e'.repeat(64),
      ),
    /session restart evidence/,
  );
});

test('publishable release plans require the exact public distribution pair', () => {
  const publicPlan = deriveReleaseIdentity({
    eventName: 'workflow_dispatch',
    refName: 'main',
    requestedVersion: '0.1.0-alpha.1',
    repository: 'owner/cert-prep',
    commitSha: sha,
  });
  assert.doesNotThrow(() => assertPublishableReleasePlan(publicPlan));
  for (const rejected of [
    {},
    { ...publicPlan, publishable: false },
    { ...publicPlan, distributionProfile: LOCAL_NONPUBLISHABLE_PROFILE },
    { ...publicPlan, assetBaseUrl: 'file:///C:/runtime' },
    { ...publicPlan, distributionProfile: 'public_alpha_typo' },
  ]) {
    assert.throws(() => assertPublishableReleasePlan(rejected));
  }
});

test('local SPDX documents use a nonpublishable namespace', () => {
  const local = createSpdxDocument(
    {
      version: '0.1.0-alpha.1',
      tag: 'cert-prep-local-v0.1.0-alpha.1-aaaaaaaaaaaa',
      repository: 'local/nonpublishable',
      publishable: false,
    },
    [],
    [],
  );
  assert.match(
    local.documentNamespace,
    /^https:\/\/local\.invalid\/cert-prep\//,
  );
});

test('published release state must remain mutable public prerelease', () => {
  const plan = { tag: 'cert-prep-v0.1.0-alpha.1' };
  assert.doesNotThrow(() =>
    assertReleaseState(
      {
        tagName: plan.tag,
        isDraft: false,
        isPrerelease: true,
        isImmutable: false,
      },
      plan,
    ),
  );
  assert.throws(
    () =>
      assertReleaseState(
        {
          tagName: plan.tag,
          isDraft: false,
          isPrerelease: true,
          isImmutable: true,
        },
        plan,
      ),
    /immutable/,
  );
});
