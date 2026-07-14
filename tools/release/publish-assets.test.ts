import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupIncompleteRelease } from './publish-assets.ts';

const plan = {
  repository: 'owner/cert-prep',
  tag: 'cert-prep-v0.1.0-alpha.1',
  commitSha: 'a'.repeat(40),
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
