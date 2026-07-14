import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  listFiles,
  parseArgs,
  planAssetUploads,
  readJson,
  sha256File,
  validateCandidateFiles,
} from './release-lib.ts';

export async function publishAssets(args, gh = runGh) {
  const plan = readJson(resolve(args.plan));
  const mode = args.mode;
  if (!['ocr', 'final', 'cleanup'].includes(mode))
    throw new Error('--mode must be ocr, final, or cleanup.');
  if (mode === 'cleanup') return cleanupIncompleteRelease(plan, gh);

  const releaseRoot = resolve(args['release-root']);

  const existingTagCommit = await resolveTagCommit(gh, plan, true);
  if (existingTagCommit && existingTagCommit !== plan.commitSha) {
    throw new Error('Existing release tag points to a different commit SHA.');
  }

  let release = viewRelease(gh, plan, true);
  if (!release) {
    if (mode !== 'ocr')
      throw new Error('Final publish requires the OCR bootstrap prerelease.');
    const notesPath = writeNotes(plan, 'ocr');
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
    } finally {
      rmSync(dirname(notesPath), { recursive: true, force: true });
    }
    release = viewRelease(gh, plan, false);
  }
  assertReleaseState(release, plan);
  await assertTagCommit(gh, plan);

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
    const notesPath = writeNotes(plan, 'final');
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
  }
  return {
    uploaded: assetPlan.upload.map((item) => item.name),
    reused: assetPlan.reuse,
  };
}

export async function cleanupIncompleteRelease(plan, gh = runGh) {
  const existingTagCommit = await resolveTagCommit(gh, plan, true);
  if (!existingTagCommit) return { deleted: false };
  if (existingTagCommit !== plan.commitSha) {
    throw new Error('Existing release tag points to a different commit SHA.');
  }
  const release = viewRelease(gh, plan, true);
  if (!release) return { deleted: false };
  assertReleaseState(release, plan);
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
      'databaseId,tagName,isDraft,isPrerelease,isImmutable,targetCommitish,assets',
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

function writeNotes(plan, mode) {
  const directory = mkdtempSync(join(tmpdir(), 'cert-prep-release-notes-'));
  const path = join(directory, 'notes.md');
  const body =
    mode === 'ocr'
      ? `# Cert Prep ${plan.version}\n\nThis is the OCR bootstrap stage for an unsigned public alpha. Installer assets are intentionally withheld until clean-install and protected hardware acceptance pass.\n\nThe WindowsML OCR asset is public so clean Windows runners can verify anonymous download and SHA-256 integrity.\n`
      : `# Cert Prep ${plan.version}\n\nPublic Windows 11 x64 alpha. This build is **unsigned** and Windows SmartScreen is expected to warn. Verify downloads against \`SHA256SUMS\` before installing.\n\nThis remains an Alpha, not a production/GA release. FastFlowLM is downloaded only from its official channel after explicit terms acceptance and is not redistributed in these assets.\n`;
  writeFileSync(path, body, 'utf8');
  return path;
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
  const candidateRoot = resolve(args['candidate-root'] ?? '');
  if (
    !args['candidate-root'] ||
    !/^[0-9a-f]{64}$/i.test(args['candidate-id'] ?? '')
  ) {
    throw new Error(
      'Publishing requires the downloaded candidate root and expected candidate ID.',
    );
  }
  const candidate = readJson(join(candidateRoot, 'candidate.json'));
  await validateCandidateFiles(candidateRoot, candidate);
  if (candidate.candidateId !== args['candidate-id'].toLowerCase()) {
    throw new Error(
      'Publishing candidate ID does not match workflow metadata.',
    );
  }
  await publishAssets(args);
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
