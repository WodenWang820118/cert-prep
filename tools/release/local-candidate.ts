import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ALPHA_VERSION,
  DEFAULT_BUNDLE_ROOT,
  DEFAULT_PACKAGED_RESOURCE_ROOT,
  DEFAULT_TARGET_TRIPLE,
  PYTHON_RUNTIME_VERSION,
  WINDOWS_MSI_VERSION,
} from '../../apps/cert-prep-desktop/scripts/package-qa/constants.mts';
import {
  collectBundleArtifacts,
  collectPackagedResourceArtifacts,
  publicFileRecord,
} from '../../apps/cert-prep-desktop/scripts/package-qa/files.mts';
import { validateBundleArtifacts } from '../../apps/cert-prep-desktop/scripts/package-qa/report.mts';
import { initialInstallerSizeGate } from '../../apps/cert-prep-desktop/scripts/package-qa/size-gate.mts';
import { assembleCandidate } from './assemble.ts';
import {
  LOCAL_NONPUBLISHABLE_PROFILE,
  assertWorkspaceVersions,
  parseArgs,
  readJson,
  sha256File,
  validateCandidateFiles,
  writeJson,
} from './release-lib.ts';

const DEFAULT_GENERATED_RESOURCES =
  'apps/cert-prep-desktop/src-tauri/generated-resources';
const DEFAULT_OCR_RUNTIME_ROOT =
  'apps/cert-prep-backend/dist/ocr-windowsml-runtime';
const DEFAULT_OUTPUT_ROOT = 'tmp/local-alpha-candidate';

export async function inspectLocalCandidateBuild({
  workspaceRoot,
  bundleRoot,
  generatedResources,
  ocrRuntimeRoot,
  packagedResourceRoot,
  commitSha,
  now = new Date(),
  sourceVersions = assertWorkspaceVersions(workspaceRoot, ALPHA_VERSION),
}) {
  assertCommitSha(commitSha);
  for (const [label, root] of [
    ['bundle', bundleRoot],
    ['generated resources', generatedResources],
    ['OCR runtime', ocrRuntimeRoot],
    ['packaged resources', packagedResourceRoot],
  ]) {
    assertDirectoryWithoutSymlinks(root, label);
  }

  const releaseMetadata = readJson(
    join(generatedResources, 'release-metadata.json'),
  );
  validateLocalReleaseMetadata(releaseMetadata);

  const backendManifest = readJson(
    join(generatedResources, 'backend-runtime-manifest.json'),
  );
  const backendArtifact = await validateRuntimeArtifact({
    manifest: backendManifest,
    root: generatedResources,
    kind: 'python_backend',
    expectedUrl: null,
  });
  const ocrManifest = readJson(
    join(generatedResources, 'windowsml-ocr-runtime-manifest.json'),
  );
  const ocrArtifact = await validateRuntimeArtifact({
    manifest: ocrManifest,
    root: ocrRuntimeRoot,
    kind: 'windowsml_ocr',
    requireLocalFileUrl: true,
  });
  validateMetadataRuntime(releaseMetadata, backendManifest, ocrManifest);

  if (existsSync(join(generatedResources, ocrManifest.artifact.file_name))) {
    throw new Error('The local WindowsML OCR ZIP must remain outside packaged resources.');
  }

  const bundleArtifacts = collectBundleArtifacts(bundleRoot, workspaceRoot);
  validateBundleArtifacts(bundleArtifacts, bundleRoot);
  for (const artifact of bundleArtifacts) {
    assertRegularFileWithoutSymlink(artifact.absolutePath, 'installer');
  }
  const sizeGate = initialInstallerSizeGate(bundleArtifacts);
  if (sizeGate.status === 'failed') {
    throw new Error(sizeGate.detail);
  }

  const resourceFiles = collectPackagedResourceArtifacts(
    packagedResourceRoot,
    workspaceRoot,
  );
  await validatePackagedResourceCopies({
    workspaceRoot,
    generatedResources,
    packagedResourceRoot,
    resourceFiles,
    backendManifest,
    ocrManifest,
  });

  const assetUrl = new URL(ocrManifest.artifact.url);
  const assetSuffix = `/${encodeURIComponent(ocrManifest.artifact.file_name)}`;
  if (!assetUrl.href.endsWith(assetSuffix)) {
    throw new Error('WindowsML OCR runtime URL has an unexpected artifact name.');
  }
  const assetBaseUrl = assetUrl.href.slice(0, -assetSuffix.length);
  const plan = {
    schemaVersion: 1,
    channel: LOCAL_NONPUBLISHABLE_PROFILE,
    distributionProfile: LOCAL_NONPUBLISHABLE_PROFILE,
    publishable: false,
    version: ALPHA_VERSION,
    tag: `cert-prep-local-v${ALPHA_VERSION}-${commitSha.slice(0, 12)}`,
    repository: 'local/nonpublishable',
    commitSha: commitSha.toLowerCase(),
    target: DEFAULT_TARGET_TRIPLE,
    windowsMsiVersion: WINDOWS_MSI_VERSION,
    pythonRuntimeVersion: PYTHON_RUNTIME_VERSION,
    assetBaseUrl,
    signed: false,
    generatedAt: now.toISOString(),
    sourceVersions,
    smartScreenWarning:
      'This local acceptance candidate is unsigned and cannot be published.',
  };
  const packageQa = {
    schema_version: 3,
    generated_at: now.toISOString(),
    assessment: {
      status: 'blocked',
      evidence_scope: 'local_nonpublishable_static_tauri_resources',
      blockers: ['fresh_install_not_verified'],
    },
    target: {
      rust_triple: DEFAULT_TARGET_TRIPLE,
      platform: process.platform,
      arch: process.arch,
    },
    package: {
      bundle_root: relativePosix(workspaceRoot, bundleRoot),
      bundle_artifacts: bundleArtifacts.map(publicFileRecord),
      packaged_resource_root: relativePosix(
        workspaceRoot,
        packagedResourceRoot,
      ),
      resource_contract: {
        evidence_scope: 'local_nonpublishable_static_tauri_resources',
        installer_contents_verified: false,
        fresh_install_verified: false,
        alpha_release_gate: 'blocked_pending_local_clean_install',
        backend_bundled: true,
        windowsml_ocr_bundled: false,
        release_urls_only: false,
        local_file_ocr_only: true,
        distribution_profile: LOCAL_NONPUBLISHABLE_PROFILE,
        publishable: false,
        version: ALPHA_VERSION,
        windows_msi_version: WINDOWS_MSI_VERSION,
        python_runtime_version: PYTHON_RUNTIME_VERSION,
        channel: LOCAL_NONPUBLISHABLE_PROFILE,
        signed: false,
        target: DEFAULT_TARGET_TRIPLE,
        tauri_resource_mapping:
          'generated-resources/* -> resources/ plus legal/*',
        resource_files: resourceFiles.map(publicFileRecord),
        runtime_binding: {
          backend: {
            bytes: backendArtifact.bytes,
            sha256: backendArtifact.sha256,
          },
          windowsml_ocr: {
            bytes: ocrArtifact.bytes,
            sha256: ocrArtifact.sha256,
            url: ocrManifest.artifact.url,
          },
        },
      },
      size_gate: sizeGate,
    },
  };
  return { plan, packageQa };
}

export function assertCleanSourceCheckout(workspaceRoot, run = runCommand) {
  const tracked = splitLines(
    run('git', ['diff', '--name-only', 'HEAD', '--'], {
      cwd: workspaceRoot,
      capture: true,
    }),
  );
  const untracked = splitLines(
    run('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: workspaceRoot,
      capture: true,
    }),
  );
  const unexpected = [...new Set([...tracked, ...untracked])];
  if (unexpected.length > 0) {
    throw new Error(
      `Local candidate assembly requires a clean source checkout; found: ${unexpected.join(', ')}.`,
    );
  }
}

export async function createLocalCandidate(args, run = runCommand) {
  assertLocalCandidateArgs(args);
  const workspaceRoot = resolve(args['workspace-root'] ?? '.');
  const outputRoot = resolve(
    workspaceRoot,
    args['output-root'] ?? DEFAULT_OUTPUT_ROOT,
  );
  assertSafeNewOutput(workspaceRoot, outputRoot);
  assertCleanSourceCheckout(workspaceRoot, run);
  const commitSha = run('git', ['rev-parse', 'HEAD'], {
    cwd: workspaceRoot,
    capture: true,
  }).trim();

  const bundleRoot = resolve(
    workspaceRoot,
    DEFAULT_BUNDLE_ROOT,
  );
  const generatedResources = resolve(
    workspaceRoot,
    DEFAULT_GENERATED_RESOURCES,
  );
  const ocrRuntimeRoot = resolve(
    workspaceRoot,
    DEFAULT_OCR_RUNTIME_ROOT,
  );
  const packagedResourceRoot = resolve(
    workspaceRoot,
    DEFAULT_PACKAGED_RESOURCE_ROOT,
  );
  const { plan, packageQa } = await inspectLocalCandidateBuild({
    workspaceRoot,
    bundleRoot,
    generatedResources,
    ocrRuntimeRoot,
    packagedResourceRoot,
    commitSha,
  });

  prepareSafeOutputParent(workspaceRoot, outputRoot);
  const scratchRoot = mkdtempSync(
    join(dirname(outputRoot), '.local-alpha-candidate-work-'),
  );
  let publicationRoot;
  let handoffParent;
  try {
    const planPath = join(scratchRoot, 'release-plan.json');
    const packageQaPath = join(scratchRoot, 'package-qa.json');
    const inventoryRoot = join(scratchRoot, 'inventory');
    const stagedCandidateRoot = join(scratchRoot, 'candidate');
    mkdirSync(inventoryRoot, { recursive: true });
    writeJson(planPath, plan);
    writeJson(packageQaPath, packageQa);
    const inventory = collectInventories({
      workspaceRoot,
      generatedResources,
      ocrRuntimeRoot,
      inventoryRoot,
      run,
    });
    assertCleanSourceCheckout(workspaceRoot, run);
    const verifiedCommitSha = run('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceRoot,
      capture: true,
    }).trim();
    if (verifiedCommitSha !== commitSha) {
      throw new Error('Local candidate source commit changed during assembly.');
    }

    const result = await assembleCandidate({
      'workspace-root': workspaceRoot,
      plan: planPath,
      'bundle-root': bundleRoot,
      'generated-resources': generatedResources,
      'ocr-runtime-root': ocrRuntimeRoot,
      'package-qa': packageQaPath,
      'node-licenses': inventory.nodeLicenses,
      'python-licenses': inventory.pythonLicenses,
      'ocr-python-licenses': inventory.ocrPythonLicenses,
      'ocr-runtime-payloads': inventory.ocrRuntimePayloads,
      'cargo-metadata': inventory.cargoMetadata,
      output: stagedCandidateRoot,
    });
    const candidate = readJson(join(stagedCandidateRoot, 'candidate.json'));
    await validateCandidateFiles(stagedCandidateRoot, candidate);
    await validateAssembledRuntimes(
      stagedCandidateRoot,
      generatedResources,
      ocrRuntimeRoot,
      packageQa.package.resource_contract.runtime_binding,
    );
    if (
      candidate.distributionProfile !== LOCAL_NONPUBLISHABLE_PROFILE ||
      candidate.publishable !== false ||
      candidate.commitSha !== commitSha.toLowerCase()
    ) {
      throw new Error('Local candidate identity is not fail-closed.');
    }
    publicationRoot = await prepareCandidatePublicationCopy(
      stagedCandidateRoot,
      dirname(outputRoot),
      candidate,
    );
    await validateAssembledRuntimes(
      publicationRoot,
      generatedResources,
      ocrRuntimeRoot,
      packageQa.package.resource_contract.runtime_binding,
    );
    const handoff = await prepareCandidateAtomicHandoff(
      publicationRoot,
      dirname(outputRoot),
      candidate,
    );
    handoffParent = handoff.parent;
    assertCleanSourceCheckout(workspaceRoot, run);
    const finalCommitSha = run('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceRoot,
      capture: true,
    }).trim();
    if (finalCommitSha !== commitSha) {
      throw new Error('Local candidate source commit changed before publication.');
    }
    if (pathEntryExists(outputRoot)) {
      throw new Error(`Local candidate output appeared during assembly: ${outputRoot}.`);
    }
    await publishCandidateAtomically(handoff.root, outputRoot);
    const completed = {
      ...result,
      releaseRoot: join(outputRoot, 'release'),
      harnessRoot: join(outputRoot, 'harness'),
      outputRoot,
      candidateId: candidate.candidateId,
    };
    process.stdout.write(
      `${JSON.stringify(completed, null, 2)}\n`,
    );
    return { ...completed, candidate };
  } finally {
    if (handoffParent) {
      removeCandidateScratchRootBestEffort(
        handoffParent,
        'candidate handoff scratch',
      );
    }
    if (publicationRoot) {
      removeCandidateScratchRootBestEffort(
        publicationRoot,
        'candidate publication scratch',
      );
    }
    removeCandidateScratchRootBestEffort(
      scratchRoot,
      'candidate assembly scratch',
    );
  }
}

export async function prepareCandidatePublicationCopy(
  sourceRoot,
  publicationParent,
  candidate,
  {
    createPublicationRoot = (parent) =>
      mkdtempSync(join(parent, '.local-alpha-candidate-publish-')),
  } = {},
) {
  assertDirectoryEntryWithoutSymlink(
    publicationParent,
    'candidate publication parent',
  );
  const publicationRoot = createPublicationRoot(publicationParent);
  try {
    assertDirectoryEntryWithoutSymlink(
      publicationRoot,
      'candidate publication root',
    );
    if (readdirSync(publicationRoot).length !== 0) {
      throw new Error('Candidate publication root must start empty.');
    }
    const sourceCandidatePath = join(sourceRoot, 'candidate.json');
    const publicationCandidatePath = join(publicationRoot, 'candidate.json');
    await copyDefaultDataStream(
      sourceCandidatePath,
      publicationCandidatePath,
    );
    if (
      (await sha256File(sourceCandidatePath)) !==
      (await sha256File(publicationCandidatePath))
    ) {
      throw new Error('Candidate identity changed while preparing publication.');
    }
    if (
      JSON.stringify(readJson(publicationCandidatePath)) !==
      JSON.stringify(candidate)
    ) {
      throw new Error(
        'Published candidate identity does not match the validated source.',
      );
    }

    for (const identity of candidate.files) {
      const { relativePath, expectedSha256, segments } =
        parseCandidateFileIdentity(identity);
      const source = join(sourceRoot, ...segments);
      const destination = join(publicationRoot, ...segments);
      assertRegularFileWithoutSymlink(source, 'validated candidate file');
      mkdirSync(dirname(destination), { recursive: true });
      await copyDefaultDataStream(source, destination);
      assertRegularFileWithoutSymlink(destination, 'publication candidate file');
      if ((await sha256File(destination)) !== expectedSha256) {
        throw new Error(`Candidate publication copy changed ${relativePath}.`);
      }
    }
    return publicationRoot;
  } catch (error) {
    removeCandidateScratchRootBestEffort(
      publicationRoot,
      'failed candidate publication scratch',
    );
    throw error;
  }
}

async function copyDefaultDataStream(source, destination) {
  const sourceHandle = await open(source, 'r');
  try {
    const destinationHandle = await open(destination, 'wx');
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await sourceHandle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (bytesRead === 0) break;
        let bytesWritten = 0;
        while (bytesWritten < bytesRead) {
          const result = await destinationHandle.write(
            buffer,
            bytesWritten,
            bytesRead - bytesWritten,
            position + bytesWritten,
          );
          if (result.bytesWritten === 0) {
            throw new Error(`Unable to finish candidate file copy: ${source}.`);
          }
          bytesWritten += result.bytesWritten;
        }
        position += bytesRead;
      }
    } finally {
      await destinationHandle.close();
    }
  } finally {
    await sourceHandle.close();
  }
}

export async function prepareCandidateAtomicHandoff(
  publicationRoot,
  publicationParent,
  candidate,
) {
  assertDirectoryEntryWithoutSymlink(
    publicationParent,
    'candidate handoff parent',
  );
  const parent = mkdtempSync(
    join(publicationParent, '.local-alpha-candidate-handoff-'),
  );
  const root = join(parent, 'candidate');
  try {
    cpSync(publicationRoot, root, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    if (
      JSON.stringify(readJson(join(root, 'candidate.json'))) !==
      JSON.stringify(candidate)
    ) {
      throw new Error('Candidate handoff identity changed during the final copy.');
    }
    for (const identity of candidate.files) {
      const { relativePath, expectedSha256, segments } =
        parseCandidateFileIdentity(identity);
      const path = join(root, ...segments);
      assertRegularFileWithoutSymlink(path, 'candidate handoff file');
      if ((await sha256File(path)) !== expectedSha256) {
        throw new Error(`Candidate handoff copy changed ${relativePath}.`);
      }
    }
    return { parent, root };
  } catch (error) {
    removeCandidateScratchRootBestEffort(
      parent,
      'failed candidate handoff scratch',
    );
    throw error;
  }
}

function parseCandidateFileIdentity(identity) {
  const separator = identity.lastIndexOf(':');
  const relativePath = identity.slice(0, separator);
  const expectedSha256 = identity.slice(separator + 1);
  const segments = relativePath.split('/');
  if (
    separator < 1 ||
    !/^[0-9a-f]{64}$/.test(expectedSha256) ||
    !['release', 'harness'].includes(segments[0]) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[:*?"<>|\\]/.test(segment),
    )
  ) {
    throw new Error(`Invalid validated candidate file identity: ${identity}.`);
  }
  return { relativePath, expectedSha256, segments };
}

export function removeCandidateScratchRootBestEffort(
  path,
  label,
  {
    remove = rmSync,
    report = (message) => process.stderr.write(`${message}\n`),
  } = {},
) {
  try {
    if (!pathEntryExists(path)) return true;
    remove(path, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
    return true;
  } catch (error) {
    report(
      `Warning: unable to remove ${label} at ${path}: ${error?.message ?? error}`,
    );
    return false;
  }
}

const TRANSIENT_WINDOWS_RENAME_ERRORS = new Set([
  'EACCES',
  'EBUSY',
  'EPERM',
]);

export async function publishCandidateAtomically(
  sourceRoot,
  outputRoot,
  {
    rename = renameSync,
    wait = (milliseconds) =>
      new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
    reportRetry = ({ attempt, code }) => {
      if (attempt === 1 || attempt % 15 === 0) {
        process.stderr.write(
          `Waiting for Windows to release candidate files (${code}, attempt ${attempt}).\n`,
        );
      }
    },
    attempts = 21,
    retryDelayMs = 250,
  } = {},
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error('Atomic candidate publication requires at least one attempt.');
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (pathEntryExists(outputRoot)) {
      throw new Error(
        `Local candidate output appeared during publication: ${outputRoot}.`,
      );
    }
    try {
      await rename(sourceRoot, outputRoot);
      return;
    } catch (error) {
      if (
        attempt === attempts ||
        !TRANSIENT_WINDOWS_RENAME_ERRORS.has(error?.code)
      ) {
        throw error;
      }
      reportRetry({ attempt, code: error.code });
      await wait(retryDelayMs);
    }
  }
}

function collectInventories({
  workspaceRoot,
  generatedResources,
  ocrRuntimeRoot,
  inventoryRoot,
  run,
}) {
  const nodeLicenses = join(inventoryRoot, 'node-licenses.json');
  const pythonLicenses = join(inventoryRoot, 'python-licenses.json');
  const ocrPythonLicenses = join(inventoryRoot, 'ocr-python-licenses.json');
  const ocrRuntimePayloads = join(
    inventoryRoot,
    'ocr-runtime-payloads.json',
  );
  const cargoMetadata = join(inventoryRoot, 'cargo-metadata.json');
  const nodeOutput = run('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: workspaceRoot,
    capture: true,
  });
  writeParsedJson(nodeLicenses, nodeOutput, 'Node license inventory');
  run(
    'uv',
    [
      'run',
      '--isolated',
      '--project',
      'apps/cert-prep-backend',
      '--python',
      PYTHON_RUNTIME_VERSION,
      'python',
      'tools/release/collect-python-licenses.py',
      '--pyinstaller-executable',
      'apps/cert-prep-backend/dist/cert-prep-backend.exe',
      '--include-distribution',
      'PyInstaller==6.20.0',
      '--output',
      pythonLicenses,
    ],
    { cwd: workspaceRoot },
  );
  run(
    'uv',
    [
      'run',
      '--isolated',
      '--project',
      'apps/cert-prep-backend',
      '--python',
      PYTHON_RUNTIME_VERSION,
      '--extra',
      'ocr-windowsml',
      'python',
      'tools/release/collect-python-licenses.py',
      '--pyinstaller-executable',
      'apps/cert-prep-backend/dist/cert-prep-ocr-windowsml-runtime.exe',
      '--include-distribution',
      'PyInstaller==6.20.0',
      '--output',
      ocrPythonLicenses,
    ],
    { cwd: workspaceRoot },
  );
  run(
    'uv',
    [
      'run',
      '--isolated',
      '--project',
      'apps/cert-prep-backend',
      '--python',
      PYTHON_RUNTIME_VERSION,
      'python',
      'tools/release/collect-runtime-payloads.py',
      '--runtime-manifest',
      join(generatedResources, 'windowsml-ocr-runtime-manifest.json'),
      '--runtime-root',
      ocrRuntimeRoot,
      '--output',
      ocrRuntimePayloads,
    ],
    { cwd: workspaceRoot },
  );
  const cargoOutput = run(
    'cargo',
    [
      'metadata',
      '--format-version',
      '1',
      '--locked',
      '--manifest-path',
      'apps/cert-prep-desktop/src-tauri/Cargo.toml',
    ],
    { cwd: workspaceRoot, capture: true },
  );
  writeParsedJson(cargoMetadata, cargoOutput, 'Cargo metadata');
  for (const path of [
    pythonLicenses,
    ocrPythonLicenses,
    ocrRuntimePayloads,
  ]) {
    readJson(path);
  }
  return {
    nodeLicenses,
    pythonLicenses,
    ocrPythonLicenses,
    ocrRuntimePayloads,
    cargoMetadata,
  };
}

async function validateRuntimeArtifact({
  manifest,
  root,
  kind,
  expectedUrl,
  requireLocalFileUrl = false,
}) {
  const artifact = manifest?.artifact;
  const expectedPrefix =
    kind === 'python_backend'
      ? 'cert-prep-backend-runtime'
      : 'cert-prep-ocr-windowsml-runtime';
  const expectedEntrypoint =
    kind === 'python_backend'
      ? 'cert-prep-backend.exe'
      : 'cert-prep-ocr-windowsml-runtime.exe';
  if (
    manifest?.schema_version !== 1 ||
    manifest?.kind !== kind ||
    manifest?.version !== ALPHA_VERSION ||
    manifest?.target !== DEFAULT_TARGET_TRIPLE ||
    manifest?.entrypoint !== expectedEntrypoint ||
    !artifact ||
    typeof artifact.file_name !== 'string' ||
    basename(artifact.file_name) !== artifact.file_name ||
    artifact.file_name !==
      `${expectedPrefix}-${ALPHA_VERSION}-${DEFAULT_TARGET_TRIPLE}.zip` ||
    typeof artifact.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 1
  ) {
    throw new Error(`Invalid local ${kind} runtime manifest.`);
  }
  const artifactPath = assertContainedRegularFile(
    root,
    artifact.file_name,
    `${kind} artifact`,
  );
  const actualBytes = statSync(artifactPath).size;
  const actualHash = await sha256File(artifactPath);
  if (
    actualBytes !== artifact.bytes ||
    actualHash !== artifact.sha256.toLowerCase()
  ) {
    throw new Error(`${kind} runtime artifact does not match its manifest.`);
  }
  if (requireLocalFileUrl) {
    assertExactLocalFileUrl(artifact.url, artifactPath);
  } else if (artifact.url !== expectedUrl) {
    throw new Error(`${kind} runtime artifact URL is invalid.`);
  }
  return { bytes: actualBytes, sha256: actualHash, path: artifactPath };
}

export async function validateAssembledRuntimes(
  candidateRoot,
  generatedResources,
  ocrRuntimeRoot,
  expectedBindings,
) {
  const runtimeRoot = join(candidateRoot, 'release', 'runtimes');
  for (const [manifestFile, kind, bindingName] of [
    ['backend-runtime-manifest.json', 'python_backend', 'backend'],
    ['windowsml-ocr-runtime-manifest.json', 'windowsml_ocr', 'windowsml_ocr'],
  ]) {
    const sourceManifestPath = join(generatedResources, manifestFile);
    const candidateManifestPath = join(runtimeRoot, manifestFile);
    if (
      (await sha256File(sourceManifestPath)) !==
      (await sha256File(candidateManifestPath))
    ) {
      throw new Error(`Assembled runtime manifest changed: ${manifestFile}.`);
    }
    const manifest = readJson(candidateManifestPath);
    const artifact = await validateRuntimeArtifact({
      manifest,
      root: runtimeRoot,
      kind,
      expectedUrl: manifest.artifact.url,
    });
    const binding = expectedBindings[bindingName];
    if (
      artifact.bytes !== binding.bytes ||
      artifact.sha256 !== binding.sha256
    ) {
      throw new Error(`Assembled runtime does not match local QA: ${kind}.`);
    }
    if (kind === 'windowsml_ocr') {
      await validateRuntimeArtifact({
        manifest,
        root: ocrRuntimeRoot,
        kind,
        requireLocalFileUrl: true,
      });
    }
  }
}

async function validatePackagedResourceCopies({
  workspaceRoot,
  generatedResources,
  packagedResourceRoot,
  resourceFiles,
  backendManifest,
  ocrManifest,
}) {
  const basenames = resourceFiles.map((file) => basename(file.absolutePath));
  const normalizedBasenames = basenames.map((name) => name.toLowerCase());
  const names = new Set(normalizedBasenames);
  if (names.size !== normalizedBasenames.length) {
    throw new Error('Packaged local resources contain duplicate basenames.');
  }
  const required = [
    'backend-runtime-manifest.json',
    backendManifest.artifact.file_name,
    'windowsml-ocr-runtime-manifest.json',
    'release-metadata.json',
  ];
  for (const name of required) {
    if (!names.has(name.toLowerCase())) {
      throw new Error(`Packaged local runtime resource is missing: ${name}.`);
    }
    const source = assertContainedRegularFile(
      generatedResources,
      name,
      'generated resource',
    );
    const packaged = assertContainedRegularFile(
      packagedResourceRoot,
      name,
      'packaged resource',
    );
    if ((await sha256File(source)) !== (await sha256File(packaged))) {
      throw new Error(`Packaged local runtime resource changed: ${name}.`);
    }
  }
  if (names.has(ocrManifest.artifact.file_name.toLowerCase())) {
    throw new Error('The packaged app must not contain the WindowsML OCR ZIP.');
  }
  const zipNames = normalizedBasenames.filter((name) => name.endsWith('.zip'));
  if (
    zipNames.length !== 1 ||
    zipNames[0] !== backendManifest.artifact.file_name.toLowerCase()
  ) {
    throw new Error('Packaged local resources contain unexpected ZIP files.');
  }
  const legalRoot = resolve(packagedResourceRoot, '..', 'legal');
  assertDirectoryWithoutSymlinks(legalRoot, 'packaged legal resources');
  for (const name of [
    'LICENSE',
    'PRIVACY.md',
    'CHANGELOG.md',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    const source = assertContainedRegularFile(workspaceRoot, name, 'legal source');
    const packaged = assertContainedRegularFile(legalRoot, name, 'packaged legal resource');
    if ((await sha256File(source)) !== (await sha256File(packaged))) {
      throw new Error(`Packaged legal resource changed: ${name}.`);
    }
  }
  const tauriConfig = readJson(
    join(workspaceRoot, 'apps/cert-prep-desktop/src-tauri/tauri.conf.json'),
  );
  const mappings = tauriConfig.bundle?.resources;
  if (
    mappings?.['generated-resources/*'] !== 'resources/' ||
    mappings?.['../../../LICENSE'] !== 'legal/LICENSE' ||
    mappings?.['../../../PRIVACY.md'] !== 'legal/PRIVACY.md' ||
    mappings?.['../../../CHANGELOG.md'] !== 'legal/CHANGELOG.md' ||
    mappings?.['../../../THIRD_PARTY_NOTICES.md'] !==
      'legal/THIRD_PARTY_NOTICES.md'
  ) {
    throw new Error('Tauri local candidate resource mappings are invalid.');
  }
}

function validateLocalReleaseMetadata(metadata) {
  if (
    metadata?.schema_version !== 1 ||
    metadata?.version !== ALPHA_VERSION ||
    metadata?.windows_msi_version !== WINDOWS_MSI_VERSION ||
    metadata?.python_runtime_version !== PYTHON_RUNTIME_VERSION ||
    metadata?.release_tag !== `cert-prep-local-v${ALPHA_VERSION}` ||
    metadata?.channel !== LOCAL_NONPUBLISHABLE_PROFILE ||
    metadata?.distribution_profile !== LOCAL_NONPUBLISHABLE_PROFILE ||
    metadata?.publishable !== false ||
    metadata?.distribution_mode !== 'dev' ||
    metadata?.signed !== false ||
    metadata?.platform?.target !== DEFAULT_TARGET_TRIPLE ||
    metadata?.warnings?.production_ready !== false ||
    !String(metadata?.warnings?.smartscreen ?? '').includes(
      'cannot be published',
    ) ||
    metadata?.sha256_verification?.required !== true ||
    metadata?.sha256_verification?.algorithm !== 'SHA-256' ||
    metadata?.runtime_assets?.backend?.distribution !== 'bundled' ||
    metadata?.runtime_assets?.windowsml_ocr?.distribution !== 'local_file'
  ) {
    throw new Error('Runtime resources do not declare a local dev distribution.');
  }
}

function validateMetadataRuntime(metadata, backendManifest, ocrManifest) {
  for (const [name, actual, expected] of [
    ['backend', metadata.runtime_assets?.backend, backendManifest.artifact],
    [
      'windowsml_ocr',
      metadata.runtime_assets?.windowsml_ocr,
      ocrManifest.artifact,
    ],
  ]) {
    if (
      actual?.file_name !== expected.file_name ||
      actual?.sha256?.toLowerCase() !== expected.sha256.toLowerCase() ||
      actual?.bytes !== expected.bytes
    ) {
      throw new Error(`Local release metadata ${name} asset is inconsistent.`);
    }
  }
}

function assertExactLocalFileUrl(rawUrl, expectedPath) {
  if (typeof rawUrl !== 'string') {
    throw new Error('WindowsML OCR runtime must use a local file URL.');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('WindowsML OCR runtime file URL is invalid.');
  }
  if (
    url.protocol !== 'file:' ||
    url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('WindowsML OCR runtime must use a local non-network file URL.');
  }
  let resolvedUrlPath;
  try {
    resolvedUrlPath = realpathSync(fileURLToPath(url));
  } catch {
    throw new Error('WindowsML OCR runtime file URL does not resolve.');
  }
  if (normalizeComparablePath(resolvedUrlPath) !== normalizeComparablePath(expectedPath)) {
    throw new Error('WindowsML OCR runtime file URL does not bind the declared artifact.');
  }
}

function assertDirectoryWithoutSymlinks(root, label) {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error(`Required ${label} directory is missing: ${root}.`);
  }
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`${label} directory cannot be a symbolic link.`);
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} cannot contain symbolic links: ${path}.`);
    }
    if (entry.isDirectory()) assertDirectoryWithoutSymlinks(path, label);
  }
}

function assertContainedRegularFile(root, fileName, label) {
  if (basename(fileName) !== fileName) {
    throw new Error(`${label} name must not contain a path.`);
  }
  const rootPath = realpathSync(root);
  const path = resolve(root, fileName);
  assertRegularFileWithoutSymlink(path, label);
  const realPath = realpathSync(path);
  const relativePath = relative(rootPath, realPath);
  if (
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${label} escapes its declared root.`);
  }
  return realPath;
}

function assertRegularFileWithoutSymlink(path, label) {
  if (!existsSync(path)) throw new Error(`Required ${label} is missing: ${path}.`);
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}.`);
  }
}

export function assertSafeNewOutput(workspaceRoot, outputRoot) {
  const relativePath = relative(workspaceRoot, outputRoot);
  const normalized = relativePath.split(sep).join('/');
  if (
    !normalized.startsWith('tmp/') ||
    normalized === 'tmp/' ||
    dirname(outputRoot) !== resolve(workspaceRoot, 'tmp') ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error('Local candidate output must be a child of workspace tmp/.');
  }
  if (pathEntryExists(outputRoot)) {
    throw new Error(`Local candidate output already exists: ${outputRoot}.`);
  }
}

function assertLocalCandidateArgs(args) {
  const allowed = new Set(['workspace-root', 'output-root']);
  const unexpected = Object.keys(args).filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected local candidate arguments: ${unexpected.join(', ')}.`);
  }
}

function prepareSafeOutputParent(workspaceRoot, outputRoot) {
  const parent = dirname(outputRoot);
  const relativeParent = relative(workspaceRoot, parent);
  let current = workspaceRoot;
  for (const part of relativeParent.split(sep).filter(Boolean)) {
    assertDirectoryEntryWithoutSymlink(current, 'workspace output ancestor');
    current = join(current, part);
    if (!pathEntryExists(current)) break;
  }
  if (pathEntryExists(current)) {
    assertDirectoryEntryWithoutSymlink(current, 'workspace output ancestor');
  }
  mkdirSync(parent, { recursive: true });
  const realWorkspace = realpathSync(workspaceRoot);
  const realParent = realpathSync(parent);
  const contained = relative(realWorkspace, realParent);
  if (
    contained.startsWith(`..${sep}`) ||
    contained === '..' ||
    isAbsolute(contained)
  ) {
    throw new Error('Local candidate output parent escapes the workspace.');
  }
}

function assertDirectoryEntryWithoutSymlink(path, label) {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be a regular directory: ${path}.`);
  }
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertCommitSha(value) {
  if (!/^[0-9a-f]{40}$/i.test(value ?? '')) {
    throw new Error('Local candidate requires an exact 40-character commit SHA.');
  }
}

function normalizeComparablePath(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function relativePosix(root, path) {
  return relative(root, path).split(sep).join('/');
}

function splitLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function writeParsedJson(path, value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${label} did not produce valid JSON.`);
  }
  writeJson(path, parsed);
}

export function resolveCommandInvocation(
  command,
  args,
  platform = process.platform,
) {
  if (platform !== 'win32' || command !== 'pnpm') {
    return { executable: command, args };
  }
  const commandTokens = ['pnpm.cmd', ...args];
  const unsafeToken = commandTokens.find(
    (token) => !/^[a-zA-Z0-9._:/\\-]+$/.test(token),
  );
  if (unsafeToken) {
    throw new Error(
      `Unsafe Windows pnpm command token: ${JSON.stringify(unsafeToken)}.`,
    );
  }
  return {
    executable: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandTokens.join(' ')],
  };
}

function runCommand(command, args, { cwd, capture = false } = {}) {
  const invocation = resolveCommandInvocation(command, args);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error || result.status !== 0) {
    const outputDetail = capture
      ? [result.stderr, result.stdout]
          .map((value) => String(value ?? '').trim())
          .find(Boolean)
      : '';
    const detail = result.error?.message || outputDetail;
    throw new Error(
      `${command} ${args.join(' ')} failed${detail ? `: ${detail}` : '.'}`,
    );
  }
  return capture ? String(result.stdout ?? '') : '';
}

async function main() {
  await createLocalCandidate(parseArgs(process.argv.slice(2)));
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
