import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LOCAL_NONPUBLISHABLE_PROFILE,
  PUBLIC_UNSIGNED_ALPHA_PROFILE,
  RELEASE_CHANNEL,
  TARGET_TRIPLE,
  assertCandidateMatchesPlan,
  assertPublishableReleasePlan,
  assertSupportedDistributionPlan,
  collectLicensedComponents,
  copyInto,
  listFiles,
  parseArgs,
  readJson,
  relativePosix,
  sha256File,
  validateCandidateFiles,
  writeJson,
  writeReleaseDocuments,
} from './release-lib.ts';

export async function assembleCandidate(args) {
  const workspaceRoot = resolve(args['workspace-root']);
  const outputRoot = resolve(args.output);
  const releaseRoot = join(outputRoot, 'release');
  const harnessRoot = join(outputRoot, 'harness');
  const plan = readJson(resolve(args.plan));
  assertSupportedDistributionPlan(plan);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(releaseRoot, { recursive: true });

  const bundleRoot = resolve(args['bundle-root']);
  const generatedResources = resolve(args['generated-resources']);
  const ocrRuntimeRoot = resolve(args['ocr-runtime-root']);
  const packageQaPath = resolve(args['package-qa']);
  const packageQa = readJson(packageQaPath);
  validatePackageQa(packageQa, plan);

  const nsis = findSingleFile(
    bundleRoot,
    (path) =>
      path.toLowerCase().endsWith('.exe') && /setup/i.test(basename(path)),
    'NSIS installer',
  );
  if (!basename(nsis).includes(plan.version)) {
    throw new Error(
      `Installer name does not contain release version ${plan.version}.`,
    );
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
    distributionProfile: plan.distributionProfile,
    publishable: plan.publishable,
    files: identities,
  });
  return { candidateId, releaseRoot, harnessRoot };
}

export async function finalizeRelease(args) {
  const candidateRoot = resolve(args.candidate);
  const candidate = readJson(join(candidateRoot, 'candidate.json'));
  await validateCandidateFiles(candidateRoot, candidate);
  const sourcePlan = readJson(
    join(candidateRoot, 'release', 'metadata', 'release-plan.json'),
  );
  assertPublishableReleasePlan(sourcePlan);
  assertCandidateMatchesPlan(candidate, sourcePlan);
  const outputRoot = resolve(args.output);
  const releaseRoot = join(outputRoot, 'release');
  rmSync(outputRoot, { recursive: true, force: true });
  copyInto(join(candidateRoot, 'release'), releaseRoot);
  const plan = readJson(join(releaseRoot, 'metadata', 'release-plan.json'));
  assertCandidateMatchesPlan(candidate, plan);

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
      cleanInstall: 'passed-nsis',
      cleanInstallReports: cleanEvidence,
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
  const expectedNames = new Set(['clean-install-nsis.json']);
  if (
    files.length !== expectedNames.size ||
    files.some((path) => !expectedNames.has(basename(path)))
  ) {
    throw new Error(
      'Clean-install evidence must contain exactly one NSIS result.',
    );
  }
  const installersRoot = join(candidateRoot, 'release', 'installers');
  for (const kind of ['nsis']) {
    const path = files.find(
      (item) => basename(item) === `clean-install-${kind}.json`,
    );
    const evidence = readJson(path);
    const installer = findSingleFile(
      installersRoot,
      (item) =>
        item.toLowerCase().endsWith('.exe') && /setup/i.test(basename(item)),
      `${kind} installer`,
    );
    const requiredTrue = [
      'backendBundled',
      'publicOcrDownloadVerified',
      'appLaunchVerified',
      'freshAppDataVerified',
      'backendInstallVerified',
      'backendHealthVerified',
      'uninstallVerified',
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
      candidateId: evidence.candidateId,
      commitSha: evidence.commitSha,
      publicOcrDownloadVerified: evidence.publicOcrDownloadVerified,
      appLaunchVerified: evidence.appLaunchVerified,
      freshAppDataVerified: evidence.freshAppDataVerified,
      backendInstallVerified: evidence.backendInstallVerified,
      backendHealthVerified: evidence.backendHealthVerified,
      uninstallVerified: evidence.uninstallVerified,
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

export function validatePackageQa(report, plan) {
  assertSupportedDistributionPlan(plan);
  const contract = report.package?.resource_contract;
  if (
    plan.distributionProfile === LOCAL_NONPUBLISHABLE_PROFILE &&
    plan.publishable === false
  ) {
    if (
      report.schema_version !== 3 ||
      report.target?.rust_triple !== TARGET_TRIPLE ||
      contract?.backend_bundled !== true ||
      contract?.windowsml_ocr_bundled !== false ||
      contract?.release_urls_only !== false ||
      contract?.local_file_ocr_only !== true ||
      contract?.distribution_profile !== LOCAL_NONPUBLISHABLE_PROFILE ||
      contract?.publishable !== false ||
      contract?.version !== plan.version ||
      contract?.python_runtime_version !== plan.pythonRuntimeVersion ||
      contract?.signed !== false ||
      report.package?.size_gate?.status === 'failed'
    ) {
      throw new Error(
        'Package QA report did not prove the local nonpublishable candidate contract.',
      );
    }
    return;
  }
  if (
    report.schema_version !== 3 ||
    report.target?.rust_triple !== TARGET_TRIPLE ||
    contract?.backend_bundled !== true ||
    contract?.windowsml_ocr_bundled !== false ||
    contract?.release_urls_only !== true ||
    contract?.distribution_profile !== PUBLIC_UNSIGNED_ALPHA_PROFILE ||
    contract?.publishable !== true ||
    contract?.version !== plan.version ||
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
