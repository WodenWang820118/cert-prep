import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  cleanupIncompleteRelease,
  publishAssets,
  releasePublicationOwner,
  releasePublicationState,
  validatePublishingInputs,
  validatePublicationOwner,
} from './publish-assets.ts';
import {
  HARDWARE_CANCELLATION_CHECKS,
  LOCAL_NONPUBLISHABLE_PROFILE,
  PUBLIC_UNSIGNED_ALPHA_PROFILE,
  sha256File,
  writeJson,
} from './release-lib.ts';

const plan = {
  version: '0.1.0-alpha.1',
  repository: 'owner/cert-prep',
  tag: 'cert-prep-v0.1.0-alpha.1',
  commitSha: 'a'.repeat(40),
  target: 'x86_64-pc-windows-msvc',
  channel: 'unsigned_public_alpha',
  assetBaseUrl:
    'https://github.com/owner/cert-prep/releases/download/cert-prep-v0.1.0-alpha.1',
  signed: false,
  distributionProfile: PUBLIC_UNSIGNED_ALPHA_PROFILE,
  publishable: true,
};
const publicationCandidateId = 'c'.repeat(64);
const publicationOwner = `12345:1:${publicationCandidateId}`;

function releaseBody(
  owner = publicationOwner,
  state = 'ocr-bootstrap',
  candidateId = publicationCandidateId,
) {
  return [
    `<!-- cert-prep-publication-owner:${owner} -->`,
    `<!-- cert-prep-publication-state:${state}:${candidateId} -->`,
  ].join('\n');
}

test('publication owner binds one workflow run to one candidate', () => {
  assert.equal(
    validatePublicationOwner(publicationOwner, publicationCandidateId),
    publicationOwner,
  );
  assert.equal(
    releasePublicationOwner(
      {
        body: releaseBody(),
      },
      publicationCandidateId,
    ),
    publicationOwner,
  );
  assert.equal(
    releasePublicationState({ body: releaseBody() }, publicationCandidateId),
    'ocr-bootstrap',
  );
  assert.throws(
    () =>
      releasePublicationOwner(
        { body: 'release without an owner' },
        publicationCandidateId,
      ),
    /exactly one publication owner marker/,
  );
  assert.throws(
    () =>
      validatePublicationOwner(
        `12345:1:${'d'.repeat(64)}`,
        publicationCandidateId,
      ),
    /must bind workflow run ID, run attempt, and candidate ID/,
  );
  assert.throws(
    () =>
      releasePublicationState(
        { body: releaseBody(publicationOwner, 'finalized', 'd'.repeat(64)) },
        publicationCandidateId,
      ),
    /candidate-bound publication state marker/,
  );
});

test('cleanup deletes only the matching incomplete prerelease', async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'release' && args[1] === 'view') {
      return JSON.stringify({
        databaseId: 42,
        tagName: plan.tag,
        isDraft: false,
        isPrerelease: true,
        isImmutable: false,
        assets: [],
        body: releaseBody(),
      });
    }
    if (args[0] === 'api' && args[1].startsWith('repos/')) {
      return JSON.stringify({
        object: { type: 'commit', sha: plan.commitSha },
      });
    }
    return '';
  };

  const result = await cleanupIncompleteRelease(
    plan,
    publicationOwner,
    publicationCandidateId,
    gh,
  );

  assert.deepEqual(result, { deleted: true });
  assert.ok(
    calls.some(
      (args) =>
        args.join(' ') ===
        'api --method DELETE repos/owner/cert-prep/releases/42',
    ),
  );
});

test('cleanup refuses to delete a prerelease for a different commit', async () => {
  const gh = (args) => {
    if (args[0] === 'api') {
      return JSON.stringify({
        object: { type: 'commit', sha: 'b'.repeat(40) },
      });
    }
    throw new Error('release view must not be reached');
  };

  await assert.rejects(
    cleanupIncompleteRelease(
      plan,
      publicationOwner,
      publicationCandidateId,
      gh,
    ),
    /different commit SHA/,
  );
});

test('cleanup refuses to delete a prerelease owned by another workflow run', async () => {
  let deleted = false;
  const gh = (args) => {
    if (args.includes('DELETE')) {
      deleted = true;
      return '';
    }
    if (args[0] === 'release' && args[1] === 'view') {
      return JSON.stringify({
        databaseId: 42,
        tagName: plan.tag,
        isDraft: false,
        isPrerelease: true,
        isImmutable: false,
        assets: [],
        body: releaseBody(`99999:1:${publicationCandidateId}`),
      });
    }
    if (args[0] === 'api' && args[1].startsWith('repos/')) {
      return JSON.stringify({
        object: { type: 'commit', sha: plan.commitSha },
      });
    }
    return '';
  };

  await assert.rejects(
    cleanupIncompleteRelease(
      plan,
      publicationOwner,
      publicationCandidateId,
      gh,
    ),
    /belongs to a different workflow run/,
  );
  assert.equal(deleted, false);
});

test('cleanup refuses to delete a finalized public alpha', async () => {
  let deleted = false;
  const gh = (args) => {
    if (args.includes('DELETE')) {
      deleted = true;
      return '';
    }
    if (args[0] === 'release' && args[1] === 'view') {
      return JSON.stringify({
        databaseId: 42,
        tagName: plan.tag,
        isDraft: false,
        isPrerelease: true,
        isImmutable: false,
        assets: [],
        body: releaseBody(publicationOwner, 'finalized'),
      });
    }
    if (args[0] === 'api') {
      return JSON.stringify({
        object: { type: 'commit', sha: plan.commitSha },
      });
    }
    return '';
  };

  await assert.rejects(
    cleanupIncompleteRelease(
      plan,
      publicationOwner,
      publicationCandidateId,
      gh,
    ),
    /finalized public alpha release will not be deleted/,
  );
  assert.equal(deleted, false);
});

test('reservation creates one bootstrap release without transferring ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-release-reserve-'));
  try {
    const candidateRoot = join(root, 'candidate');
    const candidate = await writeMinimalCandidate(candidateRoot, plan);
    const firstOwner = `12345:1:${candidate.candidateId}`;
    const secondOwner = `12346:1:${candidate.candidateId}`;
    let release = null;
    let tagExists = false;
    let createCalls = 0;
    const gh = (args) => {
      if (args[0] === 'release' && args[1] === 'view') {
        return release === null ? null : JSON.stringify(release);
      }
      if (args[0] === 'release' && args[1] === 'create') {
        const notesPath = args[args.indexOf('--notes-file') + 1];
        release = {
          databaseId: 42,
          tagName: plan.tag,
          isDraft: false,
          isPrerelease: true,
          isImmutable: false,
          assets: [],
          body: readFileSync(notesPath, 'utf8'),
        };
        tagExists = true;
        createCalls += 1;
        return '';
      }
      if (args[0] === 'api' && args[1].includes('/git/ref/tags/')) {
        return tagExists
          ? JSON.stringify({
              object: { type: 'commit', sha: plan.commitSha },
            })
          : null;
      }
      throw new Error(`Unexpected gh call: ${args.join(' ')}`);
    };
    const reserve = (owner) =>
      publishAssets(
        {
          mode: 'reserve',
          'candidate-root': candidateRoot,
          'candidate-id': candidate.candidateId,
          'publication-owner': owner,
          plan: join(
            candidateRoot,
            'release',
            'metadata',
            'release-plan.json',
          ),
        },
        gh,
      );

    assert.deepEqual(await reserve(firstOwner), {
      releaseOwnedByCaller: true,
      publicationState: 'ocr-bootstrap',
    });
    assert.deepEqual(await reserve(secondOwner), {
      releaseOwnedByCaller: false,
      publicationState: 'ocr-bootstrap',
    });
    assert.equal(createCalls, 1);
    assert.equal(
      releasePublicationOwner(release, candidate.candidateId),
      firstOwner,
    );
    assert.equal(
      releasePublicationState(release, candidate.candidateId),
      'ocr-bootstrap',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('final publication marks the release before cleanup can observe success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-release-finalize-'));
  try {
    const candidateRoot = join(root, 'candidate');
    const candidate = await writeMinimalCandidate(candidateRoot, plan);
    const owner = `12345:1:${candidate.candidateId}`;
    const releaseRoot = await writeFinalReleaseRoot(
      join(root, 'final-release'),
      candidate,
    );
    const release = {
      databaseId: 42,
      tagName: plan.tag,
      isDraft: false,
      isPrerelease: true,
      isImmutable: false,
      assets: [],
      body: releaseBody(owner, 'ocr-bootstrap', candidate.candidateId),
    };
    let deleted = false;
    const gh = (args) => {
      if (args.includes('DELETE')) {
        deleted = true;
        return '';
      }
      if (args[0] === 'release' && args[1] === 'view') {
        return JSON.stringify(release);
      }
      if (args[0] === 'release' && args[1] === 'upload') {
        const path = args[3];
        release.assets.push({
          name: path.split(/[\\/]/).at(-1),
          digest: `sha256:${sha256FileSync(path)}`,
        });
        return '';
      }
      if (args[0] === 'release' && args[1] === 'edit') {
        release.body = readFileSync(
          args[args.indexOf('--notes-file') + 1],
          'utf8',
        );
        return '';
      }
      if (args[0] === 'api' && args[1].includes('/git/ref/tags/')) {
        return JSON.stringify({
          object: { type: 'commit', sha: plan.commitSha },
        });
      }
      throw new Error(`Unexpected gh call: ${args.join(' ')}`);
    };

    const result = await publishAssets(
      {
        mode: 'final',
        'candidate-root': candidateRoot,
        'candidate-id': candidate.candidateId,
        'publication-owner': owner,
        'release-root': releaseRoot,
        plan: join(releaseRoot, 'metadata', 'release-plan.json'),
      },
      gh,
    );
    assert.equal(result.releaseFinalized, true);
    assert.equal(
      releasePublicationState(release, candidate.candidateId),
      'finalized',
    );
    await assert.rejects(
      cleanupIncompleteRelease(plan, owner, candidate.candidateId, gh),
      /finalized public alpha release will not be deleted/,
    );
    assert.equal(deleted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local candidates reject every publication mode before GitHub access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-local-publish-'));
  try {
    const localPlan = {
      ...plan,
      repository: 'local/nonpublishable',
      tag: 'cert-prep-local-v0.1.0-alpha.1-aaaaaaaaaaaa',
      channel: LOCAL_NONPUBLISHABLE_PROFILE,
      assetBaseUrl: 'file:///C:/cert-prep-local-runtime',
      distributionProfile: LOCAL_NONPUBLISHABLE_PROFILE,
      publishable: false,
    };
    const candidateRoot = join(root, 'candidate');
    const candidate = await writeMinimalCandidate(candidateRoot, localPlan);
    const decoyPlanPath = join(root, 'public-plan.json');
    writeJson(decoyPlanPath, plan);
    let ghCalls = 0;
    const gh = () => {
      ghCalls += 1;
      throw new Error('GitHub must not be reached');
    };
    for (const mode of ['reserve', 'ocr', 'final', 'cleanup']) {
      await assert.rejects(
        () =>
          publishAssets(
            {
              mode,
              'candidate-root': candidateRoot,
              'candidate-id': candidate.candidateId,
              'release-root': join(candidateRoot, 'release'),
              plan: decoyPlanPath,
            },
            gh,
          ),
        /cannot be finalized or published/,
      );
    }
    assert.equal(ghCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('final publication requires metadata bound to the exact candidate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-final-publish-'));
  try {
    const candidateRoot = join(root, 'candidate');
    const candidate = await writeMinimalCandidate(candidateRoot, plan);
    const releaseRoot = join(root, 'final-release');
    mkdirSync(join(releaseRoot, 'metadata'), { recursive: true });
    const planPath = join(releaseRoot, 'metadata', 'release-plan.json');
    writeJson(planPath, plan);
    writeJson(join(releaseRoot, 'metadata', 'release-metadata.json'), {
      evidence: { candidateId: '0'.repeat(64) },
    });
    await assert.rejects(
      () =>
        validatePublishingInputs({
          mode: 'final',
          'candidate-root': candidateRoot,
          'candidate-id': candidate.candidateId,
          'release-root': releaseRoot,
          plan: planPath,
        }),
      /does not bind the candidate ID/,
    );
    writeJson(join(releaseRoot, 'metadata', 'release-metadata.json'), {
      ...plan,
      evidence: { candidateId: candidate.candidateId },
      artifacts: [],
    });
    writeFileSync(join(releaseRoot, 'injected.exe'), 'unfinalized');
    await assert.rejects(
      () =>
        validatePublishingInputs({
          mode: 'final',
          'candidate-root': candidateRoot,
          'candidate-id': candidate.candidateId,
          'release-root': releaseRoot,
          plan: planPath,
        }),
      /lacks completed acceptance evidence/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function writeMinimalCandidate(root, releasePlan) {
  const planPath = join(root, 'release', 'metadata', 'release-plan.json');
  const harnessPath = join(root, 'harness', 'harness.txt');
  mkdirSync(join(root, 'release', 'metadata'), { recursive: true });
  mkdirSync(join(root, 'harness'), { recursive: true });
  writeJson(planPath, releasePlan);
  writeFileSync(harnessPath, 'harness');
  const files = [
    `harness/harness.txt:${await sha256File(harnessPath)}`,
    `release/metadata/release-plan.json:${await sha256File(planPath)}`,
  ].sort();
  const candidateId = createHash('sha256')
    .update(files.join('\n'))
    .digest('hex');
  const candidate = {
    schemaVersion: 1,
    candidateId,
    version: releasePlan.version,
    tag: releasePlan.tag,
    repository: releasePlan.repository,
    commitSha: releasePlan.commitSha,
    distributionProfile: releasePlan.distributionProfile,
    publishable: releasePlan.publishable,
    files,
  };
  writeJson(join(root, 'candidate.json'), candidate);
  return candidate;
}

async function writeFinalReleaseRoot(root, candidate) {
  const metadataRoot = join(root, 'metadata');
  mkdirSync(metadataRoot, { recursive: true });
  const planPath = join(metadataRoot, 'release-plan.json');
  const payloadPath = join(root, 'payload.bin');
  writeJson(planPath, plan);
  writeFileSync(payloadPath, 'publishable payload');
  const artifacts = await Promise.all(
    [
      ['metadata/release-plan.json', planPath],
      ['payload.bin', payloadPath],
    ].map(async ([path, file]) => ({
      path,
      fileName: path.split('/').at(-1),
      bytes: statSync(file).size,
      sha256: await sha256File(file),
    })),
  );
  const evidenceDigest = 'd'.repeat(64);
  writeJson(join(metadataRoot, 'release-metadata.json'), {
    ...plan,
    evidence: {
      candidateId: candidate.candidateId,
      cleanInstall: 'passed-msi-and-nsis',
      cleanInstallReports: [{ package: 'msi' }, { package: 'nsis' }],
      hardware: 'passed-cert-prep-alpha-hardware',
      hardwareResultSha256: evidenceDigest,
      recordingProbeSha256: evidenceDigest,
      recordingSha256: evidenceDigest,
      hardwareHarnessSha256: evidenceDigest,
      acceptanceRunId: 'acceptance-run',
      cancellationReports: Object.fromEntries(
        HARDWARE_CANCELLATION_CHECKS.map((key) => [key, evidenceDigest]),
      ),
    },
    artifacts,
  });
  const checksummed = [
    planPath,
    payloadPath,
    join(metadataRoot, 'release-metadata.json'),
  ];
  writeFileSync(
    join(root, 'SHA256SUMS'),
    `${(
      await Promise.all(
        checksummed.map(async (file) =>
          `${await sha256File(file)} *${file.split(/[\\/]/).at(-1)}`,
        ),
      )
    ).join('\n')}\n`,
  );
  return root;
}

function sha256FileSync(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
