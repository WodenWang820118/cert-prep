import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  RELEASE_CHANNEL,
  TARGET_TRIPLE,
  collectLicensedComponents,
  copyInto,
  listFiles,
  parseArgs,
  readJson,
  relativePosix,
  sha256File,
  validateCandidateFiles,
  validateHardwareEvidenceFiles,
  validateHardwareResult,
  validateRecordingProbeContract,
  writeJson,
  writeReleaseDocuments,
} from './release-lib.ts';

export async function assembleCandidate(args) {
  const workspaceRoot = resolve(args['workspace-root']);
  const outputRoot = resolve(args.output);
  const releaseRoot = join(outputRoot, 'release');
  const harnessRoot = join(outputRoot, 'harness');
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(releaseRoot, { recursive: true });

  const plan = readJson(resolve(args.plan));
  const bundleRoot = resolve(args['bundle-root']);
  const generatedResources = resolve(args['generated-resources']);
  const ocrRuntimeRoot = resolve(args['ocr-runtime-root']);
  const packageQaPath = resolve(args['package-qa']);
  const packageQa = readJson(packageQaPath);
  validatePackageQa(packageQa, plan);

  const msi = findSingleFile(
    bundleRoot,
    (path) => path.toLowerCase().endsWith('.msi'),
    'MSI',
  );
  const nsis = findSingleFile(
    bundleRoot,
    (path) =>
      path.toLowerCase().endsWith('.exe') && /setup/i.test(basename(path)),
    'NSIS installer',
  );
  for (const installer of [msi, nsis]) {
    if (!basename(installer).includes(plan.version)) {
      throw new Error(
        `Installer name does not contain release version ${plan.version}.`,
      );
    }
  }
  const backendManifestPath = join(
    generatedResources,
    'backend-runtime-manifest.json',
  );
  const ocrManifestPath = join(
    generatedResources,
    'windowsml-ocr-runtime-manifest.json',
  );
  const backendManifest = readJson(backendManifestPath);
  const ocrManifest = readJson(ocrManifestPath);
  await validateRuntimeManifest({
    manifest: backendManifest,
    root: generatedResources,
    plan,
    kind: 'python_backend',
    expectedUrl: null,
  });
  await validateRuntimeManifest({
    manifest: ocrManifest,
    root: ocrRuntimeRoot,
    plan,
    kind: 'windowsml_ocr',
    expectedUrl: `${plan.assetBaseUrl}/${encodeURIComponent(ocrManifest.artifact.file_name)}`,
  });
  rejectFastFlowBinaryInArchive(
    join(generatedResources, backendManifest.artifact.file_name),
  );
  rejectFastFlowBinaryInArchive(
    join(ocrRuntimeRoot, ocrManifest.artifact.file_name),
  );
  if (
    readdirSync(generatedResources).includes(ocrManifest.artifact.file_name)
  ) {
    throw new Error(
      'WindowsML OCR ZIP must not be bundled in generated resources.',
    );
  }

  copyInto(msi, join(releaseRoot, 'installers', basename(msi)));
  copyInto(nsis, join(releaseRoot, 'installers', basename(nsis)));
  copyInto(
    backendManifestPath,
    join(releaseRoot, 'runtimes', basename(backendManifestPath)),
  );
  copyInto(
    join(generatedResources, backendManifest.artifact.file_name),
    join(releaseRoot, 'runtimes', backendManifest.artifact.file_name),
  );
  copyInto(
    ocrManifestPath,
    join(releaseRoot, 'runtimes', basename(ocrManifestPath)),
  );
  copyInto(
    join(ocrRuntimeRoot, ocrManifest.artifact.file_name),
    join(releaseRoot, 'runtimes', ocrManifest.artifact.file_name),
  );
  copyInto(packageQaPath, join(releaseRoot, 'evidence', 'package-qa.json'));
  for (const legalFile of [
    'LICENSE',
    'PRIVACY.md',
    'CHANGELOG.md',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    copyInto(
      join(workspaceRoot, legalFile),
      join(releaseRoot, 'legal', legalFile),
    );
  }
  copyInto(
    resolve(args.plan),
    join(releaseRoot, 'metadata', 'release-plan.json'),
  );
  copyInto(
    join(workspaceRoot, 'tools', 'release'),
    join(harnessRoot, 'tools', 'release'),
  );
  rmSync(join(harnessRoot, 'tools', 'release', '__pycache__'), {
    recursive: true,
    force: true,
  });

  const nodeLicenses = readJson(resolve(args['node-licenses']));
  const backendPythonLicenses = readJson(resolve(args['python-licenses']));
  const ocrPythonLicenses = readJson(resolve(args['ocr-python-licenses']));
  const ocrRuntimePayloads = readJson(resolve(args['ocr-runtime-payloads']));
  await validateOcrRuntimePayloads(
    ocrRuntimePayloads,
    ocrManifestPath,
    ocrManifest,
    workspaceRoot,
  );
  const cargoMetadata = readJson(resolve(args['cargo-metadata']));
  const nodeComponents = collectLicensedComponents({ nodeLicenses });
  const backendComponents = collectLicensedComponents({
    pythonLicenses: backendPythonLicenses,
  });
  const ocrComponents = collectLicensedComponents({
    pythonLicenses: ocrPythonLicenses,
    genericComponents: ocrRuntimePayloads.components,
  });
  const cargoComponents = collectLicensedComponents({ cargoMetadata });
  const components = collectLicensedComponents({
    nodeLicenses,
    pythonLicenses: [...backendPythonLicenses, ...ocrPythonLicenses],
    cargoMetadata,
    genericComponents: ocrRuntimePayloads.components,
  });
  const installerComponentPurls = componentPurls([
    ...nodeComponents,
    ...cargoComponents,
    ...backendComponents,
  ]);
  const artifactDependencies = [
    {
      id: 'msi',
      artifactPath: `installers/${basename(msi)}`,
      componentPurls: installerComponentPurls,
    },
    {
      id: 'nsis',
      artifactPath: `installers/${basename(nsis)}`,
      componentPurls: installerComponentPurls,
    },
    {
      id: 'backend-runtime',
      artifactPath: `runtimes/${backendManifest.artifact.file_name}`,
      componentPurls: componentPurls(backendComponents),
    },
    {
      id: 'windowsml-ocr-runtime',
      artifactPath: `runtimes/${ocrManifest.artifact.file_name}`,
      componentPurls: componentPurls(ocrComponents),
    },
  ];
  await writeReleaseDocuments({
    releaseRoot,
    plan,
    components,
    artifactDependencies,
  });

  const identities = [];
  for (const [prefix, root] of [
    ['release', releaseRoot],
    ['harness', harnessRoot],
  ]) {
    const identityFiles = listFiles(root);
    for (const path of identityFiles) {
      identities.push(
        `${prefix}/${relativePosix(root, path)}:${await sha256File(path)}`,
      );
    }
  }
  identities.sort();
  const candidateId = createHash('sha256')
    .update(identities.join('\n'))
    .digest('hex');
  writeJson(join(outputRoot, 'candidate.json'), {
    schemaVersion: 1,
    candidateId,
    version: plan.version,
    tag: plan.tag,
    repository: plan.repository,
    commitSha: plan.commitSha,
    files: identities,
  });
  return { candidateId, releaseRoot, harnessRoot };
}

export async function finalizeRelease(args) {
  const candidateRoot = resolve(args.candidate);
  const outputRoot = resolve(args.output);
  const releaseRoot = join(outputRoot, 'release');
  rmSync(outputRoot, { recursive: true, force: true });
  copyInto(join(candidateRoot, 'release'), releaseRoot);
  const plan = readJson(join(releaseRoot, 'metadata', 'release-plan.json'));
  const candidate = readJson(join(candidateRoot, 'candidate.json'));
  await validateCandidateFiles(candidateRoot, candidate);
  if (
    candidate.commitSha !== plan.commitSha ||
    candidate.version !== plan.version
  ) {
    throw new Error('Candidate identity does not match release plan.');
  }

  const hardwareRoot = resolve(args['hardware-evidence']);
  const hardwareResultPath = join(hardwareRoot, 'hardware-result.json');
  const hardwareResult = validateHardwareResult(
    readJson(hardwareResultPath),
    plan,
    candidate.candidateId,
  );
  await validateHardwareEvidenceFiles(hardwareResult, hardwareRoot);
  const recordingPath = resolve(hardwareRoot, hardwareResult.recording.path);
  assertWebmHeader(recordingPath);
  const probePath = join(hardwareRoot, 'recording-probe.json');
  if (
    !existsSync(probePath) ||
    !statSync(probePath).isFile() ||
    lstatSync(probePath).isSymbolicLink()
  ) {
    throw new Error('Hardware recording probe is missing or unsafe.');
  }
  validateRecordingProbeContract(readJson(probePath), hardwareResult);
  const expectedHardwareFiles = new Set([
    'hardware-result.json',
    'recording-probe.json',
    hardwareResult.recording.path.replaceAll('\\', '/'),
    ...Object.values(hardwareResult.cancellation).map((record) =>
      record.path.replaceAll('\\', '/'),
    ),
  ]);
  const actualHardwareFiles = listFiles(hardwareRoot).map((path) =>
    relativePosix(hardwareRoot, path),
  );
  if (
    actualHardwareFiles.length !== expectedHardwareFiles.size ||
    actualHardwareFiles.some((path) => !expectedHardwareFiles.has(path))
  ) {
    throw new Error('Hardware evidence contains missing or undeclared files.');
  }
  copyInto(hardwareRoot, join(releaseRoot, 'evidence', 'hardware'));

  const cleanEvidenceRoot = resolve(args['clean-evidence']);
  const cleanEvidence = await validateCleanInstallEvidence(
    cleanEvidenceRoot,
    candidateRoot,
    candidate,
    plan,
  );
  copyInto(cleanEvidenceRoot, join(releaseRoot, 'evidence', 'clean-install'));
  const licenseInventory = readJson(
    join(releaseRoot, 'metadata', 'license-inventory.json'),
  );
  await writeReleaseDocuments({
    releaseRoot,
    plan,
    components: licenseInventory.components,
    artifactDependencies: licenseInventory.artifactDependencies,
    evidence: {
      candidateId: candidate.candidateId,
      cleanInstall: 'passed-msi-and-nsis',
      cleanInstallReports: cleanEvidence,
      hardware: 'passed-cert-prep-alpha-hardware',
      hardwareResultSha256: await sha256File(hardwareResultPath),
      recordingProbeSha256: await sha256File(probePath),
      recordingSha256: hardwareResult.recording.sha256,
      acceptanceRunId: hardwareResult.acceptance.runId,
      hardwareHarnessSha256: hardwareResult.harnessSha256,
      cancellationReports: Object.fromEntries(
        Object.entries(hardwareResult.cancellation).map(([key, record]) => [
          key,
          record.sha256,
        ]),
      ),
    },
  });
  return { releaseRoot };
}

function componentPurls(components) {
  return [...new Set(components.map((component) => component.purl))].sort();
}

async function validateCleanInstallEvidence(
  cleanEvidenceRoot,
  candidateRoot,
  candidate,
  plan,
) {
  const files = listFiles(cleanEvidenceRoot);
  const validated = [];
  const expectedNames = new Set([
    'clean-install-msi.json',
    'clean-install-nsis.json',
  ]);
  if (
    files.length !== expectedNames.size ||
    files.some((path) => !expectedNames.has(basename(path)))
  ) {
    throw new Error(
      'Clean-install evidence must contain exactly one MSI and one NSIS result.',
    );
  }
  const installersRoot = join(candidateRoot, 'release', 'installers');
  for (const kind of ['msi', 'nsis']) {
    const path = files.find(
      (item) => basename(item) === `clean-install-${kind}.json`,
    );
    const evidence = readJson(path);
    const installer = findSingleFile(
      installersRoot,
      kind === 'msi'
        ? (item) => item.toLowerCase().endsWith('.msi')
        : (item) =>
            item.toLowerCase().endsWith('.exe') &&
            /setup/i.test(basename(item)),
      `${kind} installer`,
    );
    const requiredTrue = [
      'backendBundled',
      'publicOcrDownloadVerified',
      'appLaunchVerified',
      'freshAppDataVerified',
      'backendInstallVerified',
      'backendHealthVerified',
    ];
    if (
      evidence.schemaVersion !== 1 ||
      evidence.packageKind !== kind ||
      evidence.version !== plan.version ||
      evidence.tag !== plan.tag ||
      evidence.commitSha !== plan.commitSha ||
      evidence.candidateId !== candidate.candidateId ||
      evidence.installer !== basename(installer) ||
      evidence.installerSha256 !== (await sha256File(installer)) ||
      evidence.ocrBundled !== false ||
      requiredTrue.some((key) => evidence[key] !== true) ||
      evidence.backendVersion !== plan.version ||
      evidence.backendRuntimeMode !== 'packaged' ||
      !String(evidence.backendPythonVersion ?? '').startsWith(
        `${plan.pythonRuntimeVersion}.`,
      ) ||
      !Number.isInteger(evidence.backendPort) ||
      evidence.backendPort <= 0 ||
      typeof evidence.backendExecutable !== 'string' ||
      evidence.backendExecutable.length === 0
    ) {
      throw new Error(`Clean-install evidence contract failed: ${kind}.`);
    }
    validated.push({
      packageKind: kind,
      reportSha256: await sha256File(path),
      installerSha256: evidence.installerSha256,
    });
  }
  return validated;
}

async function validateOcrRuntimePayloads(
  inventory,
  manifestPath,
  manifest,
  workspaceRoot,
) {
  const declaration = readJson(
    join(
      workspaceRoot,
      'tools',
      'release',
      'ocr-runtime-payload-declaration.json',
    ),
  );
  const expectedPaths = declaration.payloadEntries;
  const entries = inventory.entries;
  const component = inventory.components?.[0];
  const entrypoint = inventory.entrypoint;
  const expectedSourceArtifacts = declaration.sourceArtifacts.map((source) => {
    const publicSource = { ...source };
    delete publicSource.payloadEntries;
    return publicSource;
  });
  if (
    inventory.schemaVersion !== 1 ||
    inventory.artifact?.kind !== manifest.kind ||
    inventory.artifact?.fileName !== manifest.artifact.file_name ||
    inventory.artifact?.bytes !== manifest.artifact.bytes ||
    inventory.artifact?.sha256 !== manifest.artifact.sha256.toLowerCase() ||
    inventory.artifact?.manifestSha256 !== (await sha256File(manifestPath)) ||
    !Array.isArray(entries) ||
    entries.length !== expectedPaths.length ||
    entries.some(
      (entry, index) =>
        entry.path !== expectedPaths[index] ||
        !Number.isInteger(entry.bytes) ||
        entry.bytes <= 0 ||
        !/^[0-9a-f]{64}$/i.test(entry.sha256 ?? ''),
    ) ||
    entrypoint?.path !== declaration.entrypoint ||
    !Number.isInteger(entrypoint?.bytes) ||
    entrypoint.bytes <= 0 ||
    !/^[0-9a-f]{64}$/i.test(entrypoint?.sha256 ?? '') ||
    inventory.components?.length !== 1 ||
    component?.ecosystem !== 'generic' ||
    component?.license !== 'Apache-2.0' ||
    component?.purl !== declaration.component.purl ||
    JSON.stringify(component.files) !== JSON.stringify(entries) ||
    JSON.stringify(component.sourceRepositories) !==
      JSON.stringify(declaration.component.sourceRepositories) ||
    JSON.stringify(component.licenseEvidence) !==
      JSON.stringify(declaration.component.licenseEvidence) ||
    JSON.stringify(component.sourceArtifacts) !==
      JSON.stringify(expectedSourceArtifacts)
  ) {
    throw new Error(
      'OCR runtime payload inventory does not match the declared ZIP contents.',
    );
  }
}

function assertWebmHeader(path) {
  const header = Buffer.alloc(4);
  const descriptor = openSync(path, 'r');
  try {
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error('Hardware recording is too short to be a WebM file.');
    }
  } finally {
    closeSync(descriptor);
  }
  if (!header.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    throw new Error('Hardware recording does not contain a WebM EBML header.');
  }
}

async function validateRuntimeManifest({
  manifest,
  root,
  plan,
  kind,
  expectedUrl,
}) {
  if (
    manifest.kind !== kind ||
    manifest.version !== plan.version ||
    manifest.target !== TARGET_TRIPLE ||
    manifest.artifact?.url !== expectedUrl
  ) {
    throw new Error(
      `${kind} runtime manifest does not match the release plan.`,
    );
  }
  const artifactPath = join(root, manifest.artifact.file_name);
  if (!statSync(artifactPath).isFile()) {
    throw new Error(`${kind} runtime artifact is missing.`);
  }
  if (statSync(artifactPath).size !== manifest.artifact.bytes) {
    throw new Error(`${kind} runtime artifact byte count is invalid.`);
  }
  if (
    (await sha256File(artifactPath)) !== manifest.artifact.sha256.toLowerCase()
  ) {
    throw new Error(`${kind} runtime artifact digest is invalid.`);
  }
}

function validatePackageQa(report, plan) {
  const contract = report.package?.resource_contract;
  if (
    report.schema_version !== 3 ||
    report.target?.rust_triple !== TARGET_TRIPLE ||
    contract?.backend_bundled !== true ||
    contract?.windowsml_ocr_bundled !== false ||
    contract?.release_urls_only !== true ||
    contract?.version !== plan.version ||
    contract?.windows_msi_version !== plan.windowsMsiVersion ||
    contract?.python_runtime_version !== plan.pythonRuntimeVersion ||
    contract?.channel !== RELEASE_CHANNEL ||
    contract?.signed !== false ||
    report.package?.size_gate?.status === 'failed'
  ) {
    throw new Error(
      'Package QA report did not prove the unsigned hybrid alpha contract.',
    );
  }
}

function findSingleFile(root, predicate, label) {
  const matches = listFiles(root).filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches.length}.`);
  }
  return matches[0];
}

export function rejectFastFlowBinaryInArchive(path) {
  const archiveIndex = readFileSync(path)
    .toString('latin1')
    .replaceAll('\\', '/');
  if (
    /(?:^|\/)(?:flm|fastflowlm)[^/]*\.exe(?=[^A-Za-z0-9._/-]|$)/i.test(
      archiveIndex,
    )
  ) {
    throw new Error(
      `FastFlowLM binary must not be redistributed inside ${basename(path)}.`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'candidate') await assembleCandidate(args);
  else if (args.mode === 'finalize') await finalizeRelease(args);
  else throw new Error('--mode must be candidate or finalize.');
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
