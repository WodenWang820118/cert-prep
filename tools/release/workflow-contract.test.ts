import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflowPath = resolve(
  import.meta.dirname,
  '../../.github/workflows/release-alpha.yml',
);
const workflow = readFileSync(workflowPath, 'utf8');
const cleanInstall = readFileSync(
  resolve(import.meta.dirname, 'clean-install.ps1'),
  'utf8',
);

function jobBody(name, nextName) {
  const start = workflow.indexOf(`  ${name}:`);
  const end = nextName
    ? workflow.indexOf(`  ${nextName}:`, start + 1)
    : workflow.length;
  assert.notEqual(start, -1, `job ${name} must exist`);
  assert.notEqual(end, -1, `job ${nextName} must exist after ${name}`);
  return workflow.slice(start, end);
}

test('release workflow exposes dispatch and alpha tag triggers with confirmations', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cert-prep-v\*-alpha\.\*/);
  for (const input of [
    'confirm_public_repository',
    'confirm_release_environment_protected',
    'confirm_fastflow_terms',
    'confirm_hardware_runner_ready',
  ]) {
    assert.match(workflow, new RegExp(`${input}:`));
  }
});

test('all third-party actions are pinned to full commit SHAs', () => {
  const actionUses = [...workflow.matchAll(/uses:\s*([^\s@]+)@([^\s]+)/g)];
  assert.ok(actionUses.length > 10);
  for (const [, action, ref] of actionUses) {
    assert.match(
      ref,
      /^[0-9a-f]{40}$/,
      `${action} must use an immutable commit SHA`,
    );
  }
});

test('release workflow pins setup-uv to the verified v8.3.2 commit', () => {
  const setupUvUses = workflow.match(/astral-sh\/setup-uv@([0-9a-f]{40})/g) ?? [];
  assert.ok(setupUvUses.length > 0);
  assert.ok(
    setupUvUses.every(
      (value) =>
        value ===
        'astral-sh/setup-uv@11f9893b081a58869d3b5fccaea48c9e9e46f990',
    ),
  );
});

test('every release job uses the explicit Node 24 runtime contract', () => {
  const setupNodeCount = (workflow.match(/uses: actions\/setup-node@/g) ?? [])
    .length;
  const node24Count = (workflow.match(/node-version:\s*24/g) ?? []).length;
  assert.ok(setupNodeCount > 0);
  assert.equal(node24Count, setupNodeCount);
  assert.doesNotMatch(workflow, /node-version-file:/);
});

test('release JavaScript commands use Node 24 native TypeScript entrypoints', () => {
  assert.equal(workflow.includes(`.${'mjs'}`), false);
  assert.match(workflow, /node --test tools\/release\/\*\.test\.ts/);
  for (const entrypoint of [
    'metadata.ts',
    'assemble.ts',
    'publish-assets.ts',
    'verify-hardware-result.ts',
  ]) {
    assert.match(workflow, new RegExp(`tools/release/${entrypoint}`));
  }
});

test('Windows quality and candidate builds run through pnpm Nx', () => {
  assert.match(workflow, /pnpm nx run-many -t lint test/);
  assert.match(workflow, /pnpm nx run cert-prep-desktop:typecheck-scripts/);
  assert.match(workflow, /pnpm nx run cert-prep-desktop:package-qa-test/);
  assert.match(workflow, /pnpm nx run cert-prep-desktop:release-tool-test/);
  assert.match(workflow, /pnpm nx run cert-prep-desktop:cargo-test/);
  assert.match(workflow, /pnpm nx run cert-prep-desktop:package-qa/);
  assert.match(workflow, /pnpm nx run cert-prep-e2e:e2e --args=/);
  assert.match(workflow, /pnpm nx run cert-prep-e2e:e2e-real-backend/);
  assert.match(workflow, /--isolated[\s\S]*--extra ocr-windowsml/);
  assert.match(workflow, /--ocr-python-licenses/);
  assert.match(workflow, /--include-distribution PyInstaller==6\.20\.0/);
  assert.match(workflow, /collect-runtime-payloads\.py/);
  assert.match(workflow, /--ocr-runtime-payloads/);
  assert.match(workflow, /--pyinstaller-executable/);
});

test('clean-install matrix consumes the candidate without a checkout', () => {
  const body = jobBody('clean-install', 'hardware-acceptance');
  assert.match(body, /package:\s*\[msi, nsis\]/);
  assert.match(body, /actions\/download-artifact@/);
  assert.doesNotMatch(body, /actions\/checkout@/);
  assert.match(body, /ExpectedCandidateId/);
  assert.match(body, /ExpectedCommitSha/);
  assert.match(
    cleanInstall,
    /CERT_PREP_PACKAGE_QA_AUTO_INSTALL_BUNDLED_BACKEND/,
  );
  assert.match(cleanInstall, /Wait-InstalledBackendHealth/);
  assert.match(cleanInstall, /runtime_mode -eq 'packaged'/);
  assert.match(cleanInstall, /health\.version -eq \$ExpectedVersion/);
  assert.match(cleanInstall, /health\.python_version/);
  assert.match(cleanInstall, /backendHealthVerified = \$true/);
});

test('hardware gate is protected, labeled and consumes no checkout', () => {
  const body = jobBody('hardware-acceptance', 'finalize-release');
  assert.match(body, /cert-prep-alpha-hardware/);
  assert.match(body, /environment:\s*alpha-hardware/);
  assert.match(body, /ALPHA_HARDWARE_HARNESS/);
  assert.match(body, /ALPHA_HARDWARE_HARNESS_SHA256/);
  assert.match(body, /Get-FileHash[\s\S]*ALPHA_HARDWARE_HARNESS/);
  assert.match(body, /--harness-sha256/);
  assert.match(body, /ALPHA_FFPROBE_PATH/);
  assert.match(body, /ALPHA_FFPROBE_SHA256/);
  assert.match(body, /--ffprobe-path/);
  assert.doesNotMatch(body, /actions\/checkout@/);
  assert.match(body, /verify-hardware-result\.ts/);
});

test('final publish is no-clobber, attested and contains both SBOM formats', () => {
  const ocrPublish = jobBody('publish-ocr-prerelease', 'clean-install');
  assert.doesNotMatch(workflow, /--clobber/);
  assert.match(workflow, /actions\/attest-build-provenance@/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /attestations:\s*write/);
  assert.match(workflow, /environment:\s*alpha-release/);
  assert.match(ocrPublish, /environment:\s*alpha-release/);
  assert.match(workflow, /SPDX|SBOM/i);
  assert.match(workflow, /CycloneDX|both SBOM formats/i);
  assert.match(workflow, /unsigned_public_alpha/);
  for (const body of [
    ocrPublish,
    jobBody('publish-alpha', 'cleanup-incomplete-prerelease'),
    jobBody('cleanup-incomplete-prerelease'),
  ]) {
    assert.match(body, /--candidate-root candidate/);
    assert.match(
      body,
      /--candidate-id '\$\{\{ needs\.build-candidate\.outputs\.candidate_id \}\}'/,
    );
  }
});

test('a failed post-OCR gate withdraws the incomplete prerelease', () => {
  const body = jobBody('cleanup-incomplete-prerelease');
  assert.match(body, /always\(\)/);
  assert.match(body, /publish-ocr-prerelease\.result == 'success'/);
  assert.match(body, /publish-alpha\.result != 'success'/);
  assert.match(body, /--mode cleanup/);
  assert.doesNotMatch(body, /actions\/checkout@/);
});
