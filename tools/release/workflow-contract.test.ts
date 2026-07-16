import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/release-alpha.yml'),
  'utf8',
);
const gitAttributes = readFileSync(
  resolve(import.meta.dirname, '../../.gitattributes'),
  'utf8',
);
const cleanInstall = readFileSync(
  resolve(import.meta.dirname, 'clean-install.ps1'),
  'utf8',
);
const assemble = readFileSync(
  resolve(import.meta.dirname, 'assemble.ts'),
  'utf8',
);

const jobNames = [
  ...workflow
    .slice(workflow.indexOf('\njobs:\n'))
    .matchAll(/^  ([a-z][a-z0-9-]+):$/gm),
].map((match) => match[1]);

function jobBody(name) {
  const index = jobNames.indexOf(name);
  assert.notEqual(index, -1, `job ${name} must exist`);
  const start = workflow.indexOf(`  ${name}:`, workflow.indexOf('\njobs:\n'));
  const nextName = jobNames[index + 1];
  const end = nextName
    ? workflow.indexOf(`  ${nextName}:`, start + 1)
    : workflow.length;
  return workflow.slice(start, end);
}

test('release workflow keeps only the four phased jobs', () => {
  assert.deepEqual(jobNames, [
    'build-candidate',
    'clean-install',
    'publish-alpha',
    'cleanup-incomplete-prerelease',
  ]);
  assert.match(jobBody('clean-install'), /needs:\s*build-candidate/);
  assert.match(
    jobBody('publish-alpha'),
    /needs:\s*\[build-candidate, clean-install\]/,
  );
});

test('dispatch and alpha-tag triggers require only public release confirmations', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cert-prep-v\*-alpha\.\*/);
  assert.match(workflow, /confirm_public_repository:/);
  assert.match(workflow, /confirm_release_environment_protected:/);
  assert.doesNotMatch(workflow, /confirm_hardware_runner_ready/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
});

test('all third-party actions are pinned and every Node setup uses Node 24', () => {
  const actionUses = [...workflow.matchAll(/uses:\s*([^\s@]+)@([^\s]+)/g)];
  assert.ok(actionUses.length >= 10);
  for (const [, action, ref] of actionUses) {
    assert.match(ref, /^[0-9a-f]{40}$/, `${action} must use an immutable SHA`);
  }
  const setupNodeCount = (workflow.match(/uses: actions\/setup-node@/g) ?? [])
    .length;
  assert.equal(
    (workflow.match(/node-version:\s*24/g) ?? []).length,
    setupNodeCount,
  );
  assert.match(
    workflow,
    /astral-sh\/setup-uv@11f9893b081a58869d3b5fccaea48c9e9e46f990/,
  );
});

test('candidate build validates the exact public release source and runs quality through Nx', () => {
  const body = jobBody('build-candidate');
  assert.match(body, /actions\/checkout@/);
  assert.match(body, /fetch-depth:\s*0/);
  assert.match(body, /--sha "\$\{\{ github\.sha \}\}"/);
  assert.match(body, /git merge-base --is-ancestor/);
  assert.match(body, /ALPHA_EXPECTED_REPOSITORY/);
  assert.match(body, /gh api "repos\/\$env:GITHUB_REPOSITORY"/);
  assert.match(body, /pnpm nx run-many -t lint test/);
  assert.match(body, /pnpm nx run cert-prep-desktop:typecheck-scripts/);
  assert.match(body, /pnpm nx run cert-prep-desktop:package-qa-test/);
  assert.match(body, /pnpm nx run cert-prep-desktop:release-tool-test/);
  assert.match(body, /pnpm nx run cert-prep-desktop:cargo-test/);
  assert.match(body, /pnpm nx run cert-prep-e2e:e2e-real-backend/);
  assert.equal((body.match(/e2e-real-backend/g) ?? []).length, 1);
  assert.match(body, /pnpm nx run cert-prep-desktop:package-qa/);
  assert.match(body, /--include-distribution PyInstaller==6\.20\.0/);
  assert.match(body, /collect-runtime-payloads\.py/);
  assert.match(body, /--mode candidate/);
  assert.match(body, /candidate_id=/);
});

test('downstream jobs reuse the exact candidate without checkout or rebuild', () => {
  for (const name of [
    'clean-install',
    'publish-alpha',
    'cleanup-incomplete-prerelease',
  ]) {
    const body = jobBody(name);
    assert.match(body, /actions\/download-artifact@/);
    assert.doesNotMatch(body, /actions\/checkout@/);
    assert.doesNotMatch(body, /pnpm (?:install|nx)|cargo |uv sync/);
  }
  assert.match(workflow, /candidate_artifact:/);
  assert.match(workflow, /candidate_id:/);
  assert.match(workflow, /ExpectedCandidateId/);
  assert.match(workflow, /ExpectedCommitSha/);
});

test('OCR bootstrap remains remote, candidate-bound and hash-verified', () => {
  const body = jobBody('clean-install');
  assert.match(body, /environment:\s*alpha-release/);
  assert.match(body, /id:\s*reserve_ocr/);
  assert.match(body, /--mode reserve/);
  assert.match(body, /--mode ocr/);
  assert.match(body, /--candidate-root candidate/);
  assert.match(body, /--candidate-id/);
  assert.match(body, /--publication-owner/);
  assert.match(
    cleanInstall,
    /Invoke-WebRequest -Uri \$contract\.ocr\.artifact\.url/,
  );
  assert.match(
    cleanInstall,
    /Public OCR runtime download failed byte\/hash verification/,
  );
});

test('clean-install proves one fresh NSIS install, launch, health check and uninstall', () => {
  assert.doesNotMatch(cleanInstall, /ValidateSet\('msi'/i);
  assert.doesNotMatch(cleanInstall, /\$PackageKind|msiexec/i);
  assert.match(cleanInstall, /-Filter '\*setup\.exe'/);
  assert.match(cleanInstall, /-ArgumentList '\/S'/);
  assert.match(cleanInstall, /Wait-InstalledBackendHealth/);
  assert.match(cleanInstall, /runtime_mode -eq 'packaged'/);
  assert.match(cleanInstall, /freshAppDataVerified = \$true/);
  assert.match(cleanInstall, /backendHealthVerified = \$true/);
  assert.match(cleanInstall, /Invoke-CertPrepNsisUninstall/);
  assert.match(cleanInstall, /uninstallVerified = \$true/);
  assert.match(
    cleanInstall,
    /functionalSmoke = 'fresh-install-launch-backend-health'/,
  );
  assert.match(jobBody('clean-install'), /clean-install-nsis\.json/);
  const uninstallFunction = cleanInstall.slice(
    cleanInstall.indexOf('function Invoke-CertPrepNsisUninstall'),
    cleanInstall.indexOf('function Find-InstalledExecutable'),
  );
  assert.doesNotMatch(uninstallFunction, /ErrorAction SilentlyContinue/);
  assert.match(uninstallFunction, /installRootRemoved/);
  assert.match(uninstallFunction, /Test-Path -LiteralPath \$InstallRoot/);
  assert.ok(
    cleanInstall.lastIndexOf('Invoke-CertPrepNsisUninstall') <
      cleanInstall.indexOf("$result['uninstallVerified'] = $true"),
    'the report must be marked verified only after uninstall succeeds',
  );
  assert.match(assemble, /['"]uninstallVerified['"]/);
});

test('final publish keeps SPDX, notices, checksums and anonymous verification', () => {
  const body = jobBody('publish-alpha');
  assert.match(body, /--mode finalize/);
  assert.match(body, /--clean-evidence clean-evidence/);
  assert.match(body, /--mode final/);
  assert.match(body, /--mode verify-public/);
  assert.match(body, /Verify every public asset anonymously against its hash/);
  const anonymousStep = body.slice(
    body.indexOf(
      '- name: Verify every public asset anonymously against its hash',
    ),
    body.indexOf('- name: Write release summary'),
  );
  assert.doesNotMatch(anonymousStep, /GH_TOKEN|Authorization/);
  assert.match(workflow, /SPDX SBOM/);
  assert.match(workflow, /licenses and checksums/);
  assert.doesNotMatch(workflow, /--clobber/);
});

test('failed pre-finalization publication cleans up only the owned prerelease', () => {
  const body = jobBody('cleanup-incomplete-prerelease');
  assert.match(body, /always\(\)/);
  assert.match(body, /clean-install\.outputs\.release_owned_by_run == 'true'/);
  assert.match(body, /publish-alpha\.outputs\.release_finalized != 'true'/);
  assert.match(body, /publish-alpha\.result != 'success'/);
  assert.match(body, /--mode cleanup/);
  assert.match(body, /environment:\s*alpha-release/);
});

test('removed release gates and artifact formats cannot return unnoticed', () => {
  const forbidden = [
    /alpha-hardware/i,
    /self-hosted/i,
    /ALPHA_HARDWARE/i,
    /acceptance[_ -]pdf/i,
    /ffprobe/i,
    /verify-hardware-result/i,
    /hardware-evidence/i,
    /CycloneDX|\.cdx\.json/i,
    /attest|provenance/i,
    /recording|video-evidence/i,
    /\bmsi\b/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(workflow, pattern);
  }
  assert.doesNotMatch(gitAttributes, /alpha-acceptance-pdf-manifest\.json/);
});
