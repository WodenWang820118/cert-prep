import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { rejectFastFlowBinaryInArchive, validatePackageQa } from './assemble.ts';

const publicPlan = {
  version: '0.1.0-alpha.1',
  tag: 'cert-prep-v0.1.0-alpha.1',
  repository: 'example/cert-prep',
  commitSha: 'a'.repeat(40),
  distributionProfile: 'public_unsigned_alpha',
  publishable: true,
  channel: 'unsigned_public_alpha',
  target: 'x86_64-pc-windows-msvc',
  pythonRuntimeVersion: '3.12',
  signed: false,
  assetBaseUrl: 'https://github.com/example/cert-prep/releases/download/cert-prep-v0.1.0-alpha.1',
};

test('package QA accepts the backend plus Capture Runtime public contract', () => {
  assert.doesNotThrow(() =>
    validatePackageQa(
      {
        schema_version: 3,
        target: { rust_triple: 'x86_64-pc-windows-msvc' },
        package: {
          resource_contract: {
            backend_bundled: true,
            capture_runtime_bundled: true,
            release_urls_only: true,
            distribution_profile: 'public_unsigned_alpha',
            publishable: true,
            version: '0.1.0-alpha.1',
            python_runtime_version: '3.12',
            channel: 'unsigned_public_alpha',
            signed: false,
          },
          size_gate: { status: 'passed' },
        },
      },
      publicPlan,
    ),
  );
});

test('archive gate rejects a redistributed FastFlow executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-assemble-'));
  const archive = join(root, 'runtime.zip');
  writeFileSync(archive, 'bin/fastflowlm.exe');
  assert.throws(
    () => rejectFastFlowBinaryInArchive(archive),
    /must not be redistributed/,
  );
  rmSync(root, { recursive: true, force: true });
});
