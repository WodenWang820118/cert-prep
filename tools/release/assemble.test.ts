import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  assembleCandidate,
  finalizeRelease,
  rejectFastFlowBinaryInArchive,
  validatePackageQa,
} from './assemble.ts';
import {
  LOCAL_NONPUBLISHABLE_PROFILE,
  PUBLIC_UNSIGNED_ALPHA_PROFILE,
  deriveReleaseIdentity,
  listFiles,
  sha256File,
  writeJson,
} from './release-lib.ts';

test('candidate assembly and finalization keep one NSIS installer and SPDX evidence', async () => {
  const fixture = await createAssemblyFixture();
  try {
    const result = await assembleCandidate(fixture.assembleArgs);
    assert.match(result.candidateId, /^[0-9a-f]{64}$/);

    const candidate = readJson(join(fixture.output, 'candidate.json'));
    assert.equal(candidate.distributionProfile, PUBLIC_UNSIGNED_ALPHA_PROFILE);
    assert.equal(candidate.publishable, true);
    assert.equal(
      candidate.files.some((identity) =>
        identity.startsWith('harness/tools/release/'),
      ),
      true,
    );

    const installers = listFiles(
      join(fixture.output, 'release', 'installers'),
    ).map((path) => basename(path));
    assert.deepEqual(installers, [fixture.installerName]);
    assert.equal(
      installers.some((name) => name.endsWith('.msi')),
      false,
    );
    assert.equal(
      readFileSync(
        join(fixture.output, 'release', 'runtimes', fixture.backendName),
        'utf8',
      ),
      'backend-runtime',
    );
    assert.equal(
      readFileSync(
        join(fixture.output, 'release', 'runtimes', fixture.ocrName),
        'utf8',
      ),
      'ocr-runtime',
    );

    const candidateMetadata = readJson(
      join(fixture.output, 'release', 'metadata', 'release-metadata.json'),
    );
    assert.equal(candidateMetadata.channel, 'unsigned_public_alpha');
    assert.equal(
      candidateMetadata.artifacts.some((item) =>
        item.fileName.endsWith('.spdx.json'),
      ),
      true,
    );
    assert.equal(
      candidateMetadata.artifacts.some((item) =>
        item.fileName.endsWith('.cdx.json'),
      ),
      false,
    );
    const licenseInventory = readJson(
      join(fixture.output, 'release', 'metadata', 'license-inventory.json'),
    );
    assert.deepEqual(
      licenseInventory.artifactDependencies.map((item) => item.id),
      ['backend-runtime', 'nsis', 'windowsml-ocr-runtime'],
    );
    for (const scope of licenseInventory.artifactDependencies) {
      const spdx = readJson(
        join(
          fixture.output,
          'release',
          'metadata',
          `cert-prep-alpha-${scope.id}.spdx.json`,
        ),
      );
      assert.equal(
        spdx.relationships.some(
          (relationship) => relationship.relationshipType === 'DEPENDS_ON',
        ),
        true,
      );
    }
    assert.match(
      readFileSync(join(fixture.output, 'release', 'SHA256SUMS'), 'utf8'),
      /Cert Prep_0\.1\.0-alpha\.1_x64-setup\.exe/,
    );

    const cleanRoot = join(fixture.root, 'clean');
    mkdirSync(cleanRoot, { recursive: true });
    const cleanReportPath = join(cleanRoot, 'clean-install-nsis.json');
    const cleanReport = await cleanInstallReport({
      candidateId: result.candidateId,
      installerPath: join(
        fixture.output,
        'release',
        'installers',
        fixture.installerName,
      ),
      plan: fixture.plan,
    });
    writeJson(cleanReportPath, cleanReport);

    const finalOutput = join(fixture.root, 'final');
    await finalizeRelease({
      candidate: fixture.output,
      'clean-evidence': cleanRoot,
      output: finalOutput,
    });
    const finalMetadata = readJson(
      join(finalOutput, 'release', 'metadata', 'release-metadata.json'),
    );
    assert.deepEqual(finalMetadata.evidence, {
      candidateId: result.candidateId,
      cleanInstall: 'passed-nsis',
      cleanInstallReports: [
        {
          packageKind: 'nsis',
          candidateId: result.candidateId,
          commitSha: fixture.plan.commitSha,
          publicOcrDownloadVerified: true,
          appLaunchVerified: true,
          freshAppDataVerified: true,
          backendInstallVerified: true,
          backendHealthVerified: true,
          uninstallVerified: true,
          reportSha256: await sha256File(cleanReportPath),
          installerSha256: cleanReport.installerSha256,
        },
      ],
    });
    assert.equal(
      listFiles(join(finalOutput, 'release', 'evidence', 'clean-install'))
        .length,
      1,
    );

    writeJson(cleanReportPath, {
      ...cleanReport,
      candidateId: '0'.repeat(64),
    });
    await assert.rejects(
      finalizeRelease({
        candidate: fixture.output,
        'clean-evidence': cleanRoot,
        output: join(fixture.root, 'invalid-clean-final'),
      }),
      /Clean-install evidence contract failed: nsis/,
    );
    writeJson(cleanReportPath, cleanReport);

    writeFileSync(join(cleanRoot, 'unexpected.json'), '{}');
    await assert.rejects(
      finalizeRelease({
        candidate: fixture.output,
        'clean-evidence': cleanRoot,
        output: join(fixture.root, 'extra-clean-final'),
      }),
      /exactly one NSIS result/,
    );
    rmSync(join(cleanRoot, 'unexpected.json'));

    const injectedCandidateFile = join(
      fixture.output,
      'release',
      'injected-but-undeclared.txt',
    );
    writeFileSync(injectedCandidateFile, 'undeclared');
    await assert.rejects(
      finalizeRelease({
        candidate: fixture.output,
        'clean-evidence': cleanRoot,
        output: join(fixture.root, 'invalid-candidate-final'),
      }),
      /does not exactly cover release and harness files/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('archive gate rejects redistributed FastFlow executables', () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-fastflow-archive-'));
  try {
    const archive = join(root, 'runtime.zip');
    writeFileSync(archive, 'prefix/nested/flm.exe\0suffix');
    assert.throws(
      () => rejectFastFlowBinaryInArchive(archive),
      /must not be redistributed/,
    );
    writeFileSync(archive, 'prefix\0cert-prep-backend.exe\0suffix');
    assert.doesNotThrow(() => rejectFastFlowBinaryInArchive(archive));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package QA accepts only exact public or local distribution pairs', () => {
  const publicPlan = deriveReleaseIdentity({
    eventName: 'workflow_dispatch',
    refName: 'main',
    requestedVersion: '0.1.0-alpha.1',
    repository: 'owner/cert-prep',
    commitSha: 'a'.repeat(40),
  });
  const publicReport = packageQaFixture(publicPlan, {
    release_urls_only: true,
    distribution_profile: PUBLIC_UNSIGNED_ALPHA_PROFILE,
    publishable: true,
    channel: publicPlan.channel,
  });
  assert.doesNotThrow(() => validatePackageQa(publicReport, publicPlan));
  assert.throws(
    () =>
      validatePackageQa(
        {
          ...publicReport,
          package: {
            ...publicReport.package,
            resource_contract: {
              ...publicReport.package.resource_contract,
              publishable: false,
            },
          },
        },
        publicPlan,
      ),
    /unsigned hybrid alpha contract/,
  );

  const localPlan = {
    ...publicPlan,
    channel: LOCAL_NONPUBLISHABLE_PROFILE,
    distributionProfile: LOCAL_NONPUBLISHABLE_PROFILE,
    publishable: false,
    tag: 'cert-prep-local-v0.1.0-alpha.1-aaaaaaaaaaaa',
    repository: 'local/nonpublishable',
    assetBaseUrl: 'file:///C:/cert-prep-local-runtime',
  };
  const localReport = packageQaFixture(localPlan, {
    release_urls_only: false,
    local_file_ocr_only: true,
    distribution_profile: LOCAL_NONPUBLISHABLE_PROFILE,
    publishable: false,
    channel: LOCAL_NONPUBLISHABLE_PROFILE,
  });
  assert.doesNotThrow(() => validatePackageQa(localReport, localPlan));
  assert.throws(
    () =>
      validatePackageQa(localReport, {
        ...localPlan,
        assetBaseUrl: publicPlan.assetBaseUrl,
      }),
    /exact supported distribution profile/,
  );
});

test('finalizer rejects local and mismatched candidates before touching output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-finalize-guard-'));
  try {
    const output = join(root, 'output');
    mkdirSync(output);
    const sentinel = join(output, 'sentinel.txt');
    writeFileSync(sentinel, 'keep');
    const localPlan = {
      schemaVersion: 1,
      channel: LOCAL_NONPUBLISHABLE_PROFILE,
      version: '0.1.0-alpha.1',
      tag: 'cert-prep-local-v0.1.0-alpha.1-aaaaaaaaaaaa',
      repository: 'local/nonpublishable',
      commitSha: 'a'.repeat(40),
      target: 'x86_64-pc-windows-msvc',
      pythonRuntimeVersion: '3.12',
      assetBaseUrl: 'file:///C:/cert-prep-local-runtime',
      signed: false,
      distributionProfile: LOCAL_NONPUBLISHABLE_PROFILE,
      publishable: false,
    };
    const localCandidate = join(root, 'local-candidate');
    await writeMinimalCandidate(localCandidate, localPlan);
    await assert.rejects(
      finalizeRelease({ candidate: localCandidate, output }),
      /cannot be finalized or published/,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');

    const publicPlan = deriveReleaseIdentity({
      eventName: 'workflow_dispatch',
      refName: 'main',
      requestedVersion: '0.1.0-alpha.1',
      repository: 'owner/cert-prep',
      commitSha: 'a'.repeat(40),
    });
    const mismatchedCandidate = join(root, 'mismatched-candidate');
    await writeMinimalCandidate(mismatchedCandidate, publicPlan, {
      repository: 'other/cert-prep',
    });
    await assert.rejects(
      finalizeRelease({ candidate: mismatchedCandidate, output }),
      /does not match release plan: repository/,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function createAssemblyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-assemble-'));
  const workspace = join(root, 'workspace');
  const bundleRoot = join(root, 'bundle');
  const resources = join(root, 'generated-resources');
  const ocrRoot = join(root, 'ocr-runtime');
  const inventory = join(root, 'inventory');
  for (const path of [workspace, bundleRoot, resources, ocrRoot, inventory]) {
    mkdirSync(path, { recursive: true });
  }
  const plan = deriveReleaseIdentity({
    eventName: 'workflow_dispatch',
    refName: 'main',
    requestedVersion: '0.1.0-alpha.1',
    repository: 'owner/cert-prep',
    commitSha: 'a'.repeat(40),
  });
  const planPath = join(root, 'release-plan.json');
  writeJson(planPath, plan);
  const installerName = 'Cert Prep_0.1.0-alpha.1_x64-setup.exe';
  writeFileSync(join(bundleRoot, installerName), 'nsis');

  const backendName = `cert-prep-backend-runtime-${plan.version}-${plan.target}.zip`;
  const backendPath = join(resources, backendName);
  writeFileSync(backendPath, 'backend-runtime');
  writeJson(join(resources, 'backend-runtime-manifest.json'), {
    kind: 'python_backend',
    version: plan.version,
    target: plan.target,
    artifact: {
      file_name: backendName,
      bytes: Buffer.byteLength('backend-runtime'),
      sha256: await sha256File(backendPath),
      url: null,
    },
  });

  const ocrName = `cert-prep-ocr-windowsml-runtime-${plan.version}-${plan.target}.zip`;
  const ocrPath = join(ocrRoot, ocrName);
  writeFileSync(ocrPath, 'ocr-runtime');
  const ocrManifest = {
    kind: 'windowsml_ocr',
    version: plan.version,
    target: plan.target,
    artifact: {
      file_name: ocrName,
      bytes: Buffer.byteLength('ocr-runtime'),
      sha256: await sha256File(ocrPath),
      url: `${plan.assetBaseUrl}/${encodeURIComponent(ocrName)}`,
    },
  };
  const ocrManifestPath = join(
    resources,
    'windowsml-ocr-runtime-manifest.json',
  );
  writeJson(ocrManifestPath, ocrManifest);
  writeJson(join(ocrRoot, 'windowsml-ocr-runtime-manifest.json'), ocrManifest);

  const packageQaPath = join(root, 'package-qa.json');
  writeJson(
    packageQaPath,
    packageQaFixture(plan, {
      release_urls_only: true,
      distribution_profile: PUBLIC_UNSIGNED_ALPHA_PROFILE,
      publishable: true,
      channel: plan.channel,
    }),
  );
  for (const file of [
    'LICENSE',
    'PRIVACY.md',
    'CHANGELOG.md',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    writeFileSync(join(workspace, file), `${file}\n`);
  }
  const releaseToolsRoot = join(workspace, 'tools', 'release');
  mkdirSync(releaseToolsRoot, { recursive: true });
  const payloadDeclaration = readJson(
    join(import.meta.dirname, 'ocr-runtime-payload-declaration.json'),
  );
  writeJson(
    join(releaseToolsRoot, 'ocr-runtime-payload-declaration.json'),
    payloadDeclaration,
  );
  writeFileSync(join(releaseToolsRoot, 'clean-install.ps1'), '# fixture');

  writeJson(join(inventory, 'node.json'), {
    MIT: [{ name: 'node-dependency', versions: ['1.0.0'], license: 'MIT' }],
  });
  writeJson(join(inventory, 'python.json'), [
    licensedComponent('python-dependency', 'MIT', 'MIT license text'),
  ]);
  writeJson(join(inventory, 'ocr-python.json'), [
    licensedComponent(
      'ocr-python-dependency',
      'Apache-2.0',
      'Apache license text',
    ),
  ]);
  writeJson(join(inventory, 'cargo.json'), {
    packages: [
      {
        name: 'rust-dependency',
        version: '1.0.0',
        license: 'MIT',
        source: 'registry',
      },
    ],
  });
  const payloadEntries = payloadDeclaration.payloadEntries.map(
    (path, index) => ({
      path,
      bytes: index + 1,
      sha256: String(index + 1).padStart(64, '0'),
    }),
  );
  const sourceArtifacts = payloadDeclaration.sourceArtifacts.map((source) => {
    const item = { ...source };
    delete item.payloadEntries;
    return item;
  });
  writeJson(join(inventory, 'ocr-runtime-payloads.json'), {
    schemaVersion: 1,
    artifact: {
      kind: 'windowsml_ocr',
      fileName: ocrName,
      bytes: ocrManifest.artifact.bytes,
      sha256: ocrManifest.artifact.sha256,
      manifestSha256: await sha256File(ocrManifestPath),
    },
    entrypoint: {
      path: payloadDeclaration.entrypoint,
      bytes: 10,
      sha256: 'f'.repeat(64),
    },
    entries: payloadEntries,
    components: [
      {
        ...payloadDeclaration.component,
        licenseTexts: [],
        sourceArtifacts,
        files: payloadEntries,
      },
    ],
  });

  const output = join(root, 'candidate');
  return {
    root,
    output,
    plan,
    installerName,
    backendName,
    ocrName,
    assembleArgs: {
      'workspace-root': workspace,
      plan: planPath,
      'bundle-root': bundleRoot,
      'generated-resources': resources,
      'ocr-runtime-root': ocrRoot,
      'package-qa': packageQaPath,
      'node-licenses': join(inventory, 'node.json'),
      'python-licenses': join(inventory, 'python.json'),
      'ocr-python-licenses': join(inventory, 'ocr-python.json'),
      'ocr-runtime-payloads': join(inventory, 'ocr-runtime-payloads.json'),
      'cargo-metadata': join(inventory, 'cargo.json'),
      output,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function licensedComponent(name, license, text) {
  return {
    name,
    version: '1.0.0',
    license,
    licenseTexts: [{ name: 'LICENSE', text, primary: true }],
  };
}

function packageQaFixture(plan, contract) {
  return {
    schema_version: 3,
    target: { rust_triple: plan.target },
    package: {
      resource_contract: {
        backend_bundled: true,
        windowsml_ocr_bundled: false,
        version: plan.version,
        python_runtime_version: plan.pythonRuntimeVersion,
        signed: false,
        ...contract,
      },
      size_gate: { status: 'passed' },
    },
  };
}

async function cleanInstallReport({ candidateId, installerPath, plan }) {
  return {
    schemaVersion: 1,
    packageKind: 'nsis',
    version: plan.version,
    tag: plan.tag,
    commitSha: plan.commitSha,
    candidateId,
    installer: basename(installerPath),
    installerSha256: await sha256File(installerPath),
    backendBundled: true,
    ocrBundled: false,
    publicOcrDownloadVerified: true,
    appLaunchVerified: true,
    freshAppDataVerified: true,
    backendInstallVerified: true,
    backendHealthVerified: true,
    uninstallVerified: true,
    backendVersion: plan.version,
    backendRuntimeMode: 'packaged',
    backendPythonVersion: '3.12.12',
    backendExecutable: 'cert-prep-backend.exe',
    backendPort: 43123,
  };
}

async function writeMinimalCandidate(root, plan, candidateOverrides = {}) {
  const releasePlanPath = join(
    root,
    'release',
    'metadata',
    'release-plan.json',
  );
  const harnessPath = join(root, 'harness', 'harness.txt');
  mkdirSync(join(root, 'release', 'metadata'), { recursive: true });
  mkdirSync(join(root, 'harness'), { recursive: true });
  writeJson(releasePlanPath, plan);
  writeFileSync(harnessPath, 'harness');
  const files = [
    `harness/harness.txt:${await sha256File(harnessPath)}`,
    `release/metadata/release-plan.json:${await sha256File(releasePlanPath)}`,
  ].sort();
  const candidateId = createHash('sha256')
    .update(files.join('\n'))
    .digest('hex');
  writeJson(join(root, 'candidate.json'), {
    schemaVersion: 1,
    candidateId,
    version: plan.version,
    tag: plan.tag,
    repository: plan.repository,
    commitSha: plan.commitSha,
    distributionProfile: plan.distributionProfile,
    publishable: plan.publishable,
    files,
    ...candidateOverrides,
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
