import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  HARDWARE_CANCELLATION_CHECKS,
  assertCandidateMatchesPlan,
  assertPublishableReleasePlan,
  listFiles,
  parseArgs,
  planAssetUploads,
  readJson,
  sha256File,
  validateCandidateFiles,
} from './release-lib.ts';

const PUBLICATION_OWNER_MARKER =
  /<!-- cert-prep-publication-owner:([1-9][0-9]*:[1-9][0-9]*:[0-9a-f]{64}) -->/gi;
const PUBLICATION_STATE_MARKER =
  /<!-- cert-prep-publication-state:(ocr-bootstrap|finalized):([0-9a-f]{64}) -->/gi;

export async function publishAssets(args, gh = runGh) {
  const { mode, plan, releaseRoot, candidate } =
    await validatePublishingInputs(args);
  const publicationOwner = validatePublicationOwner(
    args['publication-owner'],
    candidate.candidateId,
  );
  if (mode === 'cleanup') {
    return cleanupIncompleteRelease(
      plan,
      publicationOwner,
      candidate.candidateId,
      gh,
    );
  }
  if (mode === 'reserve') {
    const reservation = await inspectReleaseReservation(
      plan,
      publicationOwner,
      candidate.candidateId,
      true,
      gh,
    );
    if (reservation.publicationState !== 'ocr-bootstrap') {
      throw new Error(
        'The candidate release is already finalized and cannot be reserved again.',
      );
    }
    return {
      releaseOwnedByCaller: reservation.releaseOwnedByCaller,
      publicationState: reservation.publicationState,
    };
  }

  const reservation = await inspectReleaseReservation(
    plan,
    publicationOwner,
    candidate.candidateId,
    false,
    gh,
  );
  if (
    mode === 'ocr' &&
    reservation.publicationState !== 'ocr-bootstrap'
  ) {
    throw new Error('OCR assets cannot be published to a finalized release.');
  }
  const { release, releaseOwner, releaseOwnedByCaller } = reservation;

  const desiredPaths = selectAssets(releaseRoot, mode);
  const desired = [];
  for (const path of desiredPaths) {
    desired.push({
      name: basename(path),
      path,
      sha256: await sha256File(path),
    });
  }
  const existingAssets = await hydrateMissingDigests(
    gh,
    release.assets ?? [],
    desired,
    plan,
  );
  const assetPlan = planAssetUploads(existingAssets, desired);
  for (const asset of assetPlan.upload) {
    gh(['release', 'upload', plan.tag, asset.path, '--repo', plan.repository]);
  }

  const verified = viewRelease(gh, plan, false);
  assertReleaseState(verified, plan);
  const verifiedAssets = await hydrateMissingDigests(
    gh,
    verified.assets ?? [],
    desired,
    plan,
  );
  const verification = planAssetUploads(verifiedAssets, desired);
  if (verification.upload.length > 0) {
    throw new Error('Release asset verification found missing uploads.');
  }

  if (mode === 'final') {
    const notesPath = writeNotes(
      plan,
      'finalized',
      releaseOwner,
      candidate.candidateId,
    );
    try {
      gh([
        'release',
        'edit',
        plan.tag,
        '--repo',
        plan.repository,
        '--title',
        `Cert Prep ${plan.version} (unsigned public alpha)`,
        '--notes-file',
        notesPath,
        '--prerelease',
        '--latest=false',
        '--verify-tag',
      ]);
    } finally {
      rmSync(dirname(notesPath), { recursive: true, force: true });
    }
    const finalized = viewRelease(gh, plan, false);
    assertReleaseState(finalized, plan);
    if (
      releasePublicationOwner(finalized, candidate.candidateId) !==
        releaseOwner ||
      releasePublicationState(finalized, candidate.candidateId) !== 'finalized'
    ) {
      throw new Error('Final release publication markers were not preserved.');
    }
  }
  return {
    uploaded: assetPlan.upload.map((item) => item.name),
    reused: assetPlan.reuse,
    releaseOwnedByCaller,
    releaseFinalized: mode === 'final',
  };
}

async function inspectReleaseReservation(
  plan,
  publicationOwner,
  candidateId,
  allowCreate,
  gh,
) {
  const existingTagCommit = await resolveTagCommit(gh, plan, true);
  if (existingTagCommit && existingTagCommit !== plan.commitSha) {
    throw new Error('Existing release tag points to a different commit SHA.');
  }

  let release = viewRelease(gh, plan, true);
  let createdByCaller = false;
  if (!release) {
    if (!allowCreate) {
      throw new Error(
        'Asset publication requires a reserved OCR bootstrap prerelease.',
      );
    }
    const notesPath = writeNotes(
      plan,
      'ocr-bootstrap',
      publicationOwner,
      candidateId,
    );
    try {
      gh([
        'release',
        'create',
        plan.tag,
        '--repo',
        plan.repository,
        '--target',
        plan.commitSha,
        '--title',
        `Cert Prep ${plan.version} (unsigned public alpha)`,
        '--notes-file',
        notesPath,
        '--prerelease',
        '--latest=false',
      ]);
      createdByCaller = true;
    } finally {
      rmSync(dirname(notesPath), { recursive: true, force: true });
    }
    release = viewRelease(gh, plan, false);
  }
  try {
    assertReleaseState(release, plan);
    const releaseOwner = releasePublicationOwner(release, candidateId);
    const publicationState = releasePublicationState(release, candidateId);
    await assertTagCommit(gh, plan);
    return {
      release,
      releaseOwner,
      releaseOwnedByCaller: releaseOwner === publicationOwner,
      publicationState,
    };
  } catch (error) {
    if (createdByCaller) {
      try {
        await cleanupIncompleteRelease(
          plan,
          publicationOwner,
          candidateId,
          gh,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Release reservation failed and its owned prerelease could not be withdrawn.',
        );
      }
    }
    throw error;
  }
}

export async function validatePublishingInputs(args) {
  const mode = args.mode;
  if (!['reserve', 'ocr', 'final', 'cleanup'].includes(mode)) {
    throw new Error('--mode must be reserve, ocr, final, or cleanup.');
  }
  if (
    !args['candidate-root'] ||
    !/^[0-9a-f]{64}$/i.test(args['candidate-id'] ?? '') ||
    !args.plan
  ) {
    throw new Error(
      'Publishing requires the downloaded candidate root, expected candidate ID, and release plan.',
    );
  }
  const candidateRoot = resolve(args['candidate-root']);
  const candidate = readJson(join(candidateRoot, 'candidate.json'));
  await validateCandidateFiles(candidateRoot, candidate);
  if (candidate.candidateId !== args['candidate-id'].toLowerCase()) {
    throw new Error('Publishing candidate ID does not match workflow metadata.');
  }

  const embeddedPlanPath = join(
    candidateRoot,
    'release',
    'metadata',
    'release-plan.json',
  );
  const embeddedPlan = readJson(embeddedPlanPath);
  assertPublishableReleasePlan(embeddedPlan);
  assertCandidateMatchesPlan(candidate, embeddedPlan);

  const planPath = resolve(args.plan);
  let releaseRoot = null;
  if (mode === 'reserve' || mode === 'cleanup') {
    if (planPath !== embeddedPlanPath) {
      throw new Error('Cleanup must use the candidate embedded release plan.');
    }
  } else {
    if (!args['release-root']) {
      throw new Error('Publishing assets requires --release-root.');
    }
    releaseRoot = resolve(args['release-root']);
    const expectedPlanPath = join(releaseRoot, 'metadata', 'release-plan.json');
    if (planPath !== expectedPlanPath) {
      throw new Error('Release plan must be embedded in the selected release root.');
    }
    if (
      mode === 'ocr' &&
      releaseRoot !== join(candidateRoot, 'release')
    ) {
      throw new Error('OCR bootstrap must publish the exact candidate release root.');
    }
  }

  const plan = readJson(planPath);
  assertPublishableReleasePlan(plan);
  assertCandidateMatchesPlan(candidate, plan);
  if (!isDeepStrictEqual(plan, embeddedPlan)) {
    throw new Error('Selected release plan differs from the candidate plan.');
  }
  if (mode === 'final') {
    await validateFinalReleaseRoot(releaseRoot, embeddedPlan, candidate);
  }
  return { mode, plan, releaseRoot, candidate };
}

export async function validateFinalReleaseRoot(releaseRoot, plan, candidate) {
  const metadataPath = join(
    releaseRoot,
    'metadata',
    'release-metadata.json',
  );
  const metadata = readJson(metadataPath);
  if (metadata.evidence?.candidateId !== candidate.candidateId) {
    throw new Error('Final release metadata does not bind the candidate ID.');
  }
  for (const [key, value] of Object.entries(plan)) {
    if (!isDeepStrictEqual(metadata[key], value)) {
      throw new Error(`Final release metadata differs from its plan: ${key}.`);
    }
  }
  const evidence = metadata.evidence;
  const cancellationKeys = Object.keys(evidence.cancellationReports ?? {}).sort();
  if (
    evidence.cleanInstall !== 'passed-msi-and-nsis' ||
    !Array.isArray(evidence.cleanInstallReports) ||
    evidence.cleanInstallReports.length !== 2 ||
    evidence.hardware !== 'passed-cert-prep-alpha-hardware' ||
    !/^[0-9a-f]{64}$/i.test(evidence.hardwareResultSha256 ?? '') ||
    !/^[0-9a-f]{64}$/i.test(evidence.recordingProbeSha256 ?? '') ||
    !/^[0-9a-f]{64}$/i.test(evidence.recordingSha256 ?? '') ||
    !/^[0-9a-f]{64}$/i.test(evidence.hardwareHarnessSha256 ?? '') ||
    typeof evidence.acceptanceRunId !== 'string' ||
    evidence.acceptanceRunId.trim() === '' ||
    !isDeepStrictEqual(cancellationKeys, [...HARDWARE_CANCELLATION_CHECKS].sort()) ||
    cancellationKeys.some(
      (key) => !/^[0-9a-f]{64}$/i.test(evidence.cancellationReports[key] ?? ''),
    )
  ) {
    throw new Error('Final release metadata lacks completed acceptance evidence.');
  }

  if (!Array.isArray(metadata.artifacts) || metadata.artifacts.length === 0) {
    throw new Error('Final release metadata has no artifact inventory.');
  }
  const artifacts = new Map();
  const artifactNames = new Set();
  for (const artifact of metadata.artifacts) {
    const path = String(artifact?.path ?? '').replaceAll('\\', '/');
    const name = String(artifact?.fileName ?? '');
    if (
      !path ||
      path.startsWith('/') ||
      path.split('/').includes('..') ||
      isAbsolute(path) ||
      name !== basename(path) ||
      artifacts.has(path) ||
      artifactNames.has(name.toLowerCase()) ||
      !Number.isSafeInteger(artifact?.bytes) ||
      artifact.bytes < 1 ||
      !/^[0-9a-f]{64}$/i.test(artifact?.sha256 ?? '')
    ) {
      throw new Error('Final release artifact inventory is invalid.');
    }
    artifacts.set(path, artifact);
    artifactNames.add(name.toLowerCase());
  }

  const actualFiles = listSafeReleaseFiles(releaseRoot);
  const expectedPaths = new Set([
    ...artifacts.keys(),
    'metadata/release-metadata.json',
    'SHA256SUMS',
  ]);
  if (
    actualFiles.size !== expectedPaths.size ||
    [...actualFiles.keys()].some((path) => !expectedPaths.has(path))
  ) {
    throw new Error('Final release contains missing or undeclared files.');
  }
  for (const [path, artifact] of artifacts) {
    const file = actualFiles.get(path);
    if (
      statSync(file).size !== artifact.bytes ||
      (await sha256File(file)) !== artifact.sha256.toLowerCase()
    ) {
      throw new Error(`Final release artifact does not match metadata: ${path}.`);
    }
  }
  await validateCandidateReleaseFiles(candidate, actualFiles);
  await validateChecksumManifest(releaseRoot, actualFiles);
  return metadata;
}

async function validateCandidateReleaseFiles(candidate, actualFiles) {
  const mutable = /^(?:SHA256SUMS|metadata\/(?:release-metadata|license-inventory|cert-prep-alpha(?:-[a-z0-9-]+)?\.(?:spdx|cdx))\.json)$/;
  for (const identity of candidate.files) {
    const match = String(identity).match(/^release\/([^:]+):([0-9a-f]{64})$/i);
    if (!match || mutable.test(match[1])) continue;
    const file = actualFiles.get(match[1]);
    if (!file || (await sha256File(file)) !== match[2].toLowerCase()) {
      throw new Error(`Final release changed candidate file: ${match[1]}.`);
    }
  }
}

async function validateChecksumManifest(releaseRoot, actualFiles) {
  const checksumPath = join(releaseRoot, 'SHA256SUMS');
  const lines = readFileSync(checksumPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  const expectedFiles = [...actualFiles.entries()].filter(
    ([path]) => path !== 'SHA256SUMS',
  );
  if (lines.length !== expectedFiles.length) {
    throw new Error('Final SHA256SUMS does not cover the exact release files.');
  }
  const byName = new Map(
    expectedFiles.map(([path, file]) => [basename(path).toLowerCase(), file]),
  );
  if (byName.size !== expectedFiles.length) {
    throw new Error('Final release file basenames are not unique.');
  }
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64}) \*([^\\/]+)$/i);
    const name = match?.[2]?.toLowerCase();
    const file = name ? byName.get(name) : null;
    if (!match || !file || seen.has(name)) {
      throw new Error('Final SHA256SUMS contains an invalid file entry.');
    }
    seen.add(name);
    if ((await sha256File(file)) !== match[1].toLowerCase()) {
      throw new Error(`Final SHA256SUMS digest mismatch: ${match[2]}.`);
    }
  }
}

function listSafeReleaseFiles(root, prefix = '') {
  const files = new Map();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`Final release contains a symbolic link: ${relativePath}.`);
    }
    if (entry.isDirectory()) {
      for (const [childPath, child] of listSafeReleaseFiles(
        path,
        relativePath,
      )) {
        files.set(childPath, child);
      }
    } else if (entry.isFile()) {
      files.set(relativePath.split(sep).join('/'), path);
    } else {
      throw new Error(`Final release contains an unsafe entry: ${relativePath}.`);
    }
  }
  return files;
}

export async function cleanupIncompleteRelease(
  plan,
  publicationOwner,
  candidateId,
  gh = runGh,
) {
  assertPublishableReleasePlan(plan);
  const expectedOwner = validatePublicationOwner(
    publicationOwner,
    candidateId,
  );
  const existingTagCommit = await resolveTagCommit(gh, plan, true);
  if (!existingTagCommit) return { deleted: false };
  if (existingTagCommit !== plan.commitSha) {
    throw new Error('Existing release tag points to a different commit SHA.');
  }
  const release = viewRelease(gh, plan, true);
  if (!release) return { deleted: false };
  assertReleaseState(release, plan);
  const actualOwner = releasePublicationOwner(release, candidateId);
  if (actualOwner !== expectedOwner) {
    throw new Error(
      'Incomplete prerelease belongs to a different workflow run and will not be deleted.',
    );
  }
  if (releasePublicationState(release, candidateId) !== 'ocr-bootstrap') {
    throw new Error('A finalized public alpha release will not be deleted.');
  }
  if (!Number.isInteger(release.databaseId) || release.databaseId <= 0) {
    throw new Error('Incomplete prerelease is missing its GitHub database ID.');
  }
  gh([
    'api',
    '--method',
    'DELETE',
    `repos/${plan.repository}/releases/${release.databaseId}`,
  ]);
  return { deleted: true };
}

export function assertReleaseState(release, plan) {
  if (
    !release ||
    release.tagName !== plan.tag ||
    release.isDraft !== false ||
    release.isPrerelease !== true
  ) {
    throw new Error('GitHub release is not the expected public prerelease.');
  }
  if (release.isImmutable === true) {
    throw new Error(
      'The OCR bootstrap release is immutable; installers cannot be added without clobbering policy.',
    );
  }
}

function viewRelease(gh, plan, allowMissing) {
  const result = gh(
    [
      'release',
      'view',
      plan.tag,
      '--repo',
      plan.repository,
      '--json',
      'databaseId,tagName,isDraft,isPrerelease,isImmutable,targetCommitish,assets,body',
    ],
    { allowMissing },
  );
  return result === null ? null : JSON.parse(result);
}

async function assertTagCommit(gh, plan) {
  const commit = await resolveTagCommit(gh, plan, false);
  if (commit !== plan.commitSha) {
    throw new Error(
      'Release tag does not resolve to the candidate commit SHA.',
    );
  }
}

async function resolveTagCommit(gh, plan, allowMissing) {
  const encodedTag = encodeURIComponent(plan.tag);
  const output = gh(
    ['api', `repos/${plan.repository}/git/ref/tags/${encodedTag}`],
    { allowMissing },
  );
  if (output === null) return null;
  const ref = JSON.parse(output);
  let object = ref.object;
  if (object?.type === 'tag') {
    object = JSON.parse(
      gh(['api', `repos/${plan.repository}/git/tags/${object.sha}`]),
    ).object;
  }
  if (object?.type !== 'commit' || !/^[0-9a-f]{40}$/i.test(object.sha ?? '')) {
    throw new Error('Release tag does not resolve to a commit object.');
  }
  return object.sha.toLowerCase();
}

function selectAssets(releaseRoot, mode) {
  const files = listFiles(releaseRoot);
  if (mode === 'final') return files;
  const selected = files.filter((path) =>
    /(?:cert-prep-ocr-windowsml-runtime-.*\.zip|windowsml-ocr-runtime-manifest\.json)$/i.test(
      basename(path),
    ),
  );
  if (selected.length !== 2) {
    throw new Error(
      `OCR bootstrap requires exactly two assets, found ${selected.length}.`,
    );
  }
  return selected;
}

async function hydrateMissingDigests(gh, existingAssets, desired, plan) {
  const desiredByName = new Map(desired.map((item) => [item.name, item]));
  const output = [];
  for (const asset of existingAssets) {
    if (asset.digest || !desiredByName.has(asset.name)) {
      output.push(asset);
      continue;
    }
    const directory = mkdtempSync(join(tmpdir(), 'cert-prep-release-asset-'));
    try {
      gh([
        'release',
        'download',
        plan.tag,
        '--repo',
        plan.repository,
        '--pattern',
        asset.name,
        '--dir',
        directory,
      ]);
      output.push({
        ...asset,
        digest: `sha256:${await sha256File(join(directory, asset.name))}`,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return output;
}

function writeNotes(plan, publicationState, publicationOwner, candidateId) {
  const directory = mkdtempSync(join(tmpdir(), 'cert-prep-release-notes-'));
  const path = join(directory, 'notes.md');
  const marker = `<!-- cert-prep-publication-owner:${publicationOwner} -->`;
  const stateMarker = `<!-- cert-prep-publication-state:${publicationState}:${candidateId} -->`;
  const body =
    publicationState === 'ocr-bootstrap'
      ? `# Cert Prep ${plan.version}\n\nThis is the OCR bootstrap stage for an unsigned public alpha. Installer assets are intentionally withheld until clean-install and protected hardware acceptance pass.\n\nThe WindowsML OCR asset is public so clean Windows runners can verify anonymous download and SHA-256 integrity.\n\n${marker}\n${stateMarker}\n`
      : `# Cert Prep ${plan.version}\n\nPublic Windows 11 x64 alpha. This build is **unsigned** and Windows SmartScreen is expected to warn. Verify downloads against \`SHA256SUMS\` before installing.\n\nThis remains an Alpha, not a production/GA release. The supported Alpha reasoning runtime is Ollama.\n\n${marker}\n${stateMarker}\n`;
  writeFileSync(path, body, 'utf8');
  return path;
}

export function validatePublicationOwner(value, candidateId) {
  const normalized = String(value ?? '').trim().toLowerCase();
  const match = normalized.match(
    /^([1-9][0-9]*):([1-9][0-9]*):([0-9a-f]{64})$/,
  );
  if (!match || match[3] !== String(candidateId ?? '').toLowerCase()) {
    throw new Error(
      'Publication owner must bind workflow run ID, run attempt, and candidate ID.',
    );
  }
  return normalized;
}

export function releasePublicationOwner(release, candidateId) {
  const matches = [
    ...String(release?.body ?? '').matchAll(PUBLICATION_OWNER_MARKER),
  ].map((match) => match[1].toLowerCase());
  if (matches.length !== 1) {
    throw new Error(
      'GitHub prerelease must contain exactly one publication owner marker.',
    );
  }
  return validatePublicationOwner(matches[0], candidateId);
}

export function releasePublicationState(release, candidateId) {
  const matches = [
    ...String(release?.body ?? '').matchAll(PUBLICATION_STATE_MARKER),
  ];
  const expectedCandidateId = String(candidateId ?? '').toLowerCase();
  if (
    matches.length !== 1 ||
    !/^[0-9a-f]{64}$/.test(expectedCandidateId) ||
    matches[0][2].toLowerCase() !== expectedCandidateId
  ) {
    throw new Error(
      'GitHub prerelease must contain exactly one candidate-bound publication state marker.',
    );
  }
  return matches[0][1].toLowerCase();
}

function runGh(args, { allowMissing = false } = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
    if (allowMissing && /release not found|HTTP 404|not found/i.test(detail))
      return null;
    throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout ?? '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await publishAssets(args);
  if (process.env.GITHUB_OUTPUT) {
    const outputs = [];
    if (typeof result.releaseOwnedByCaller === 'boolean') {
      outputs.push(
        `release_owned_by_run=${String(result.releaseOwnedByCaller)}`,
      );
    }
    if (typeof result.releaseFinalized === 'boolean') {
      outputs.push(`release_finalized=${String(result.releaseFinalized)}`);
    }
    if (outputs.length > 0) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
        `${outputs.join('\n')}\n`,
      'utf8',
    );
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
