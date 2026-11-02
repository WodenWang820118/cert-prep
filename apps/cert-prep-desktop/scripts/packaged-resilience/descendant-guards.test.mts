import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import type { InstalledCandidateRunnerBinding } from './args.mts';
import { verifyLocalResilienceEvidence } from './local-evidence-verifier.mts';

// The verifier's evidence-root guard: equality, `..` traversal and escapes
// are rejected with the variable name and the resolved parent in the message.
test('local verifier requires evidence roots strictly under the evidence parent', async (t) => {
  const workspaceRoot = realpathSync(
    mkdtempSync(join(tmpdir(), 'cert-prep-descendant-')),
  );
  const evidenceParent = join(workspaceRoot, 'tmp', 'cert-prep-desktop');
  mkdirSync(evidenceParent, { recursive: true });
  const outside = join(workspaceRoot, 'outside');
  mkdirSync(outside);
  const binding = {
    workspaceRoot,
    candidateDistributionProfile: 'local_nonpublishable',
  } as unknown as InstalledCandidateRunnerBinding;
  const name = 'CERT_PREP_RESILIENCE_DOCUMENT_OUTPUT_ROOT';
  const verify = (root: string) =>
    verifyLocalResilienceEvidence(
      {
        [name]: root,
        CERT_PREP_RESILIENCE_REMAINING_OUTPUT_ROOT: root,
      },
      workspaceRoot,
      { loadInstalledCandidate: async () => binding },
    );
  const message = `${name} must stay under ${resolve(evidenceParent)}.`;

  try {
    for (const [label, root] of [
      ['the parent itself', evidenceParent],
      ['an ancestor reached through ..', join(evidenceParent, '..')],
      ['a sibling outside the parent', outside],
    ] as const) {
      await t.test(label, async () => {
        await assert.rejects(verify(root), (error: Error) => {
          assert.equal(error.message, message);
          return true;
        });
      });
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
