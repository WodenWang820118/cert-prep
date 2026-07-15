import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  cleanupIncompleteRelease,
  publishAssets,
  validatePublishingInputs,
} from './publish-assets.ts';
import {
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
      });
    }
    if (args[0] === 'api' && args[1].startsWith('repos/')) {
      return JSON.stringify({
        object: { type: 'commit', sha: plan.commitSha },
      });
    }
    return '';
  };

  const result = await cleanupIncompleteRelease(plan, gh);

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
    cleanupIncompleteRelease(plan, gh),
    /different commit SHA/,
  );
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
    for (const mode of ['ocr', 'final', 'cleanup']) {
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
