import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  assembleCandidate,
  finalizeRelease,
  rejectFastFlowBinaryInArchive,
} from './assemble.ts';
import {
  HARDWARE_CANCELLATION_CHECKS,
  deriveReleaseIdentity,
  sha256File,
  writeJson,
} from './release-lib.ts';

test('candidate assembly proves hybrid runtime shape and writes release documents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-assemble-'));
  try {
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
    writeFileSync(
      join(bundleRoot, 'Cert Prep_0.1.0-alpha.1_x64_en-US.msi'),
      'msi',
    );
    writeFileSync(
      join(bundleRoot, 'Cert Prep_0.1.0-alpha.1_x64-setup.exe'),
      'nsis',
    );

    const backendName = 'cert-prep-backend-runtime-0.1.0-alpha.1-x86_64.zip';
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

    const ocrName = 'cert-prep-ocr-windowsml-runtime-0.1.0-alpha.1-x86_64.zip';
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
        url: `${plan.assetBaseUrl}/${ocrName}`,
      },
    };
    writeJson(
      join(resources, 'windowsml-ocr-runtime-manifest.json'),
      ocrManifest,
    );
    writeJson(
      join(ocrRoot, 'windowsml-ocr-runtime-manifest.json'),
      ocrManifest,
    );

    const packageQaPath = join(root, 'package-qa.json');
    writeJson(packageQaPath, {
      schema_version: 3,
      target: { rust_triple: plan.target },
      package: {
        resource_contract: {
          backend_bundled: true,
          windowsml_ocr_bundled: false,
          release_urls_only: true,
          version: plan.version,
          windows_msi_version: plan.windowsMsiVersion,
          python_runtime_version: plan.pythonRuntimeVersion,
          channel: plan.channel,
          signed: false,
        },
        size_gate: { status: 'passed' },
      },
    });
    for (const file of [
      'LICENSE',
      'PRIVACY.md',
      'CHANGELOG.md',
      'THIRD_PARTY_NOTICES.md',
    ]) {
      writeFileSync(join(workspace, file), `${file}\n`);
    }
    mkdirSync(join(workspace, 'tools', 'release'), { recursive: true });
    const payloadDeclaration = JSON.parse(
      readFileSync(
        join(import.meta.dirname, 'ocr-runtime-payload-declaration.json'),
        'utf8',
      ),
    );
    writeJson(
      join(
        workspace,
        'tools',
        'release',
        'ocr-runtime-payload-declaration.json',
      ),
      payloadDeclaration,
    );
    writeFileSync(
      join(workspace, 'tools', 'release', 'harness.txt'),
      'harness',
    );
    writeJson(join(inventory, 'node.json'), {
      MIT: [{ name: 'node-dependency', versions: ['1.0.0'], license: 'MIT' }],
    });
    writeJson(join(inventory, 'python.json'), [
      {
        name: 'python-dependency',
        version: '1.0.0',
        license: 'MIT',
        licenseTexts: [
          { name: 'LICENSE', text: 'MIT license text', primary: true },
        ],
      },
    ]);
    writeJson(join(inventory, 'ocr-python.json'), [
      {
        name: 'ocr-python-dependency',
        version: '1.0.0',
        license: 'Apache-2.0',
        licenseTexts: [
          {
            name: 'LICENSE',
            text: 'Apache license text',
            primary: true,
          },
        ],
      },
    ]);
    const payloadEntries = payloadDeclaration.payloadEntries.map(
      (path, index) => ({
        path,
        bytes: index + 1,
        sha256: String(index + 1).padStart(64, '0'),
      }),
    );
    const publicSources = payloadDeclaration.sourceArtifacts.map((source) => {
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
        manifestSha256: await sha256File(
          join(resources, 'windowsml-ocr-runtime-manifest.json'),
        ),
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
          sourceArtifacts: publicSources,
          files: payloadEntries,
        },
      ],
    });
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

    const output = join(root, 'candidate');
    const result = await assembleCandidate({
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
    });

    assert.match(result.candidateId, /^[0-9a-f]{64}$/);
    const candidateIdentity = JSON.parse(
      readFileSync(join(output, 'candidate.json'), 'utf8'),
    );
    assert.equal(
      candidateIdentity.files.some((identity) =>
        identity.startsWith('harness/tools/release/'),
      ),
      true,
    );
    assert.equal(
      readFileSync(join(output, 'release', 'runtimes', backendName), 'utf8'),
      'backend-runtime',
    );
    assert.equal(
      readFileSync(join(output, 'release', 'runtimes', ocrName), 'utf8'),
      'ocr-runtime',
    );
    assert.match(
      readFileSync(join(output, 'release', 'SHA256SUMS'), 'utf8'),
      /Cert Prep_/,
    );
    const metadata = JSON.parse(
      readFileSync(
        join(output, 'release', 'metadata', 'release-metadata.json'),
        'utf8',
      ),
    );
    assert.equal(metadata.channel, 'unsigned_public_alpha');
    assert.equal(
      metadata.artifacts.some((item) => item.fileName.endsWith('.spdx.json')),
      true,
    );
    const licenseInventory = JSON.parse(
      readFileSync(
        join(output, 'release', 'metadata', 'license-inventory.json'),
        'utf8',
      ),
    );
    assert.deepEqual(
      licenseInventory.artifactDependencies.map((item) => item.id),
      ['backend-runtime', 'msi', 'nsis', 'windowsml-ocr-runtime'],
    );
    for (const scope of licenseInventory.artifactDependencies) {
      const spdx = JSON.parse(
        readFileSync(
          join(
            output,
            'release',
            'metadata',
            `cert-prep-alpha-${scope.id}.spdx.json`,
          ),
          'utf8',
        ),
      );
      const cycloneDx = JSON.parse(
        readFileSync(
          join(
            output,
            'release',
            'metadata',
            `cert-prep-alpha-${scope.id}.cdx.json`,
          ),
          'utf8',
        ),
      );
      assert.equal(
        spdx.relationships.some(
          (relationship) => relationship.relationshipType === 'DEPENDS_ON',
        ),
        true,
      );
      assert.equal(cycloneDx.dependencies[0].dependsOn.length > 0, true);
      if (scope.id === 'windowsml-ocr-runtime') {
        assert.equal(
          spdx.files.filter((file) =>
            file.SPDXID.startsWith('SPDXRef-Payload-'),
          ).length,
          payloadDeclaration.payloadEntries.length,
        );
        assert.equal(
          cycloneDx.components.filter(
            (component) =>
              component.type === 'file' &&
              payloadDeclaration.payloadEntries.includes(component.name),
          ).length,
          payloadDeclaration.payloadEntries.length,
        );
      }
    }

    const hardware = join(root, 'hardware');
    const clean = join(root, 'clean');
    mkdirSync(hardware, { recursive: true });
    mkdirSync(clean, { recursive: true });
    const recordingPath = join(hardware, 'acceptance.webm');
    const recording = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from('recording'),
    ]);
    writeFileSync(recordingPath, recording);
    const cancellation = {};
    const cancellationRoot = join(hardware, 'cancellation');
    mkdirSync(cancellationRoot, { recursive: true });
    for (const key of HARDWARE_CANCELLATION_CHECKS) {
      const path = join(cancellationRoot, `${key}.json`);
      writeJson(path, {
        schemaVersion: 1,
        check: key,
        passed: true,
        candidateId: result.candidateId,
        observations: [`${key} evidence`],
      });
      cancellation[key] = {
        passed: true,
        path: `cancellation/${key}.json`,
        bytes: statSync(path).size,
        sha256: await sha256File(path),
      };
    }
    writeJson(join(hardware, 'hardware-result.json'), {
      schemaVersion: 1,
      version: plan.version,
      tag: plan.tag,
      commitSha: plan.commitSha,
      candidateId: result.candidateId,
      candidateShaVerified: true,
      harnessSha256: 'c'.repeat(64),
      cleanSnapshot: true,
      windowsMlProvider: 'windowsml',
      configuredProvider: 'fastflowlm',
      effectiveProvider: 'fastflowlm',
      configuredModel: 'qwen3.5:4b',
      effectiveModel: 'qwen3.5:4b',
      providerFallback: false,
      modelFallback: false,
      generationReadyAtStart: true,
      resourcesReleasedAtEnd: true,
      fullExamQuestionCountPositive: true,
      sessionRestartPassed: true,
      cancellation,
      processResidueCount: 0,
      pdfs: Array.from({ length: 4 }, (_, index) => ({
        name: `pdf-${index + 1}`,
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
        path: 'acceptance.webm',
        captureSource: 'playwright_screencast',
        bytes: recording.length,
        sha256: await sha256File(recordingPath),
        acceptanceRunId: 'acceptance-run-0001',
        startedAt: '2026-07-11T01:00:00.000Z',
        completedAt: '2026-07-11T01:00:05.000Z',
      },
    });
    writeJson(join(hardware, 'recording-probe.json'), {
      schemaVersion: 1,
      acceptanceRunId: 'acceptance-run-0001',
      recording: {
        path: 'acceptance.webm',
        bytes: recording.length,
        sha256: await sha256File(recordingPath),
      },
      ffprobe: { sha256: 'd'.repeat(64) },
      formatNames: ['matroska', 'webm'],
      durationSeconds: 5,
      video: { codec: 'vp9', width: 1280, height: 720, frameCount: 150 },
    });
    for (const [kind, installerName] of [
      ['msi', 'Cert Prep_0.1.0-alpha.1_x64_en-US.msi'],
      ['nsis', 'Cert Prep_0.1.0-alpha.1_x64-setup.exe'],
    ]) {
      const installerPath = join(
        output,
        'release',
        'installers',
        installerName,
      );
      writeJson(join(clean, `clean-install-${kind}.json`), {
        schemaVersion: 1,
        packageKind: kind,
        version: plan.version,
        tag: plan.tag,
        commitSha: plan.commitSha,
        candidateId: result.candidateId,
        installer: installerName,
        installerSha256: await sha256File(installerPath),
        backendBundled: true,
        ocrBundled: false,
        publicOcrDownloadVerified: true,
        appLaunchVerified: true,
        freshAppDataVerified: true,
        backendInstallVerified: true,
        backendHealthVerified: true,
        backendVersion: plan.version,
        backendRuntimeMode: 'packaged',
        backendPythonVersion: '3.12.12',
        backendExecutable: 'cert-prep-backend.exe',
        backendPort: 43123,
      });
    }
    const finalOutput = join(root, 'final');
    await finalizeRelease({
      candidate: output,
      'clean-evidence': clean,
      'hardware-evidence': hardware,
      output: finalOutput,
    });
    const finalMetadata = JSON.parse(
      readFileSync(
        join(finalOutput, 'release', 'metadata', 'release-metadata.json'),
        'utf8',
      ),
    );
    assert.equal(finalMetadata.evidence.candidateId, result.candidateId);
    assert.equal(
      finalMetadata.evidence.hardware,
      'passed-cert-prep-alpha-hardware',
    );

    const cleanMsiPath = join(clean, 'clean-install-msi.json');
    const cleanMsi = JSON.parse(readFileSync(cleanMsiPath, 'utf8'));
    writeJson(cleanMsiPath, { ...cleanMsi, candidateId: '0'.repeat(64) });
    await assert.rejects(
      () =>
        finalizeRelease({
          candidate: output,
          'clean-evidence': clean,
          'hardware-evidence': hardware,
          output: join(root, 'invalid-clean-final'),
        }),
      /Clean-install evidence contract failed: msi/,
    );
    writeJson(cleanMsiPath, cleanMsi);

    const extraCandidateFile = join(
      output,
      'release',
      'injected-but-undeclared.txt',
    );
    writeFileSync(extraCandidateFile, 'undeclared');
    await assert.rejects(
      () =>
        finalizeRelease({
          candidate: output,
          'clean-evidence': clean,
          'hardware-evidence': hardware,
          output: join(root, 'extra-candidate-final'),
        }),
      /does not exactly cover release and harness files/,
    );
    rmSync(extraCandidateFile);

    writeFileSync(
      join(output, 'harness', 'tools', 'release', 'harness.txt'),
      'tampered harness',
    );
    await assert.rejects(
      () =>
        finalizeRelease({
          candidate: output,
          'clean-evidence': clean,
          'hardware-evidence': hardware,
          output: join(root, 'invalid-harness-final'),
        }),
      /Candidate file identity does not match/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive gate rejects redistributed FastFlow executables', () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-fastflow-archive-'));
  try {
    const archive = join(root, 'runtime.zip');
    writeFileSync(
      archive,
      Buffer.from('PK\u0003\u0004runtime/flm.exe\u0000payload', 'latin1'),
    );
    assert.throws(
      () => rejectFastFlowBinaryInArchive(archive),
      /must not be redistributed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
