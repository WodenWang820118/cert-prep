import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_BASE,
  type LanePlan,
  LocalCiOptionError,
  type LocalCiOptions,
  affectedMainProjects,
  extractJsonArray,
  formatSummary,
  parseOptions,
  selectLanes,
} from './local-ci-plan.mts';

const workspaceRoot = resolve(import.meta.dirname, '..');
const nx = createRequire(join(workspaceRoot, 'package.json')).resolve(
  'nx/bin/nx',
);

const ALWAYS_LANE_IDS = [
  'dead-code-gate',
  'test-architecture-tools',
  'architecture-diagrams',
  'architecture-exceptions-gate',
  'verify-capture-version-source',
];

const ALL_LANE_IDS = [
  'lint-portable',
  'test-portable',
  'typecheck',
  'dead-code-gate',
  'test-architecture-tools',
  'architecture-diagrams',
  'architecture-exceptions-gate',
  'test-api-client',
  'build-angular',
  'e2e-mocked',
  'verify-capture-version-source',
  'desktop-typecheck-scripts',
  'desktop-package-qa-test',
  'desktop-release-tool-test',
  'verify-capture-installer',
  'desktop-capture-smoke',
  'desktop-capture-consumer-test',
  'desktop-version-check',
  'verify-capture-registry',
  'desktop-capture-candidate-gates',
  'desktop-cargo-test',
];

function laneIds(plan: LanePlan): string[] {
  return plan.selected.map((lane) => lane.id);
}

function nxAffectedForFile(file: string): string[] {
  const result = spawnSync(
    process.execPath,
    [nx, 'show', 'projects', '--affected', `--files=${file}`, '--json'],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: { ...process.env, NX_DAEMON: 'false' },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    `nx show projects failed for ${file}: ${result.stderr || result.error?.message}`,
  );
  return extractJsonArray(result.stdout);
}

test('selectLanes runs only always-run gates when nothing is affected', () => {
  const plan = selectLanes([]);
  assert.deepEqual(laneIds(plan), ALWAYS_LANE_IDS);
  assert.deepEqual(plan.setups, ['pnpm-install', 'uv-sync']);
  assert.deepEqual(plan.skippedSetups, [
    'playwright-chromium',
    'install-capture-runtime',
  ]);
  assert.equal(plan.skipped.length, 16);
  assert.deepEqual(plan.excluded, []);
});

test('selectLanes for web-only change skips backend and Tauri lanes', () => {
  const plan = selectLanes(['cert-prep']);
  assert.deepEqual(laneIds(plan), [
    'lint-portable',
    'test-portable',
    'typecheck',
    'dead-code-gate',
    'test-architecture-tools',
    'architecture-diagrams',
    'architecture-exceptions-gate',
    'build-angular',
    'verify-capture-version-source',
  ]);
  assert.deepEqual(plan.selected[0]?.nx, [
    'run-many',
    '-t',
    'lint',
    '-p',
    'cert-prep',
    '--parallel=3',
  ]);
  assert.deepEqual(plan.selected[1]?.nx, [
    'run-many',
    '-t',
    'test',
    '-p',
    'cert-prep',
    '--parallel=3',
  ]);
  assert.equal(
    plan.selected.some((lane) => lane.id === 'desktop-cargo-test'),
    false,
  );
  assert.deepEqual(plan.skippedSetups, [
    'playwright-chromium',
    'install-capture-runtime',
  ]);
});

test('selectLanes for backend change runs backend lanes and desktop lanes that package it', () => {
  const plan = selectLanes(['cert-prep-backend', 'cert-prep-desktop']);
  const ids = laneIds(plan);
  assert.ok(ids.includes('lint-portable'));
  assert.ok(ids.includes('test-portable'));
  assert.ok(ids.includes('desktop-cargo-test'));
  assert.ok(ids.includes('desktop-package-qa-test'));
  assert.ok(ids.includes('desktop-capture-smoke'));
  assert.equal(ids.includes('build-angular'), false);
  assert.equal(ids.includes('e2e-mocked'), false);
  assert.equal(ids.includes('test-api-client'), false);
  assert.deepEqual(plan.selected[0]?.nx, [
    'run-many',
    '-t',
    'lint',
    '-p',
    'cert-prep-backend',
    '--parallel=3',
  ]);
  assert.deepEqual(plan.setups, [
    'pnpm-install',
    'uv-sync',
    'install-capture-runtime',
  ]);
});

test('selectLanes for contracts change runs every consumer', () => {
  const plan = selectLanes([
    'cert-prep-contracts',
    'cert-prep-ollama',
    'cert-prep-backend',
    'cert-prep-desktop',
  ]);
  assert.deepEqual(plan.selected[0]?.nx, [
    'run-many',
    '-t',
    'lint',
    '-p',
    'cert-prep-contracts',
    'cert-prep-ollama',
    'cert-prep-backend',
    '--parallel=3',
  ]);
  assert.deepEqual(plan.selected[1]?.nx, [
    'run-many',
    '-t',
    'test',
    '-p',
    'cert-prep-contracts',
    'cert-prep-ollama',
    'cert-prep-backend',
    '--parallel=3',
  ]);
  assert.ok(laneIds(plan).includes('desktop-cargo-test'));
});

test('selectLanes with --all runs every lane and setup regardless of affected projects', () => {
  const plan = selectLanes([], { all: true });
  assert.deepEqual(laneIds(plan), ALL_LANE_IDS);
  assert.deepEqual(plan.setups, [
    'pnpm-install',
    'uv-sync',
    'playwright-chromium',
    'install-capture-runtime',
  ]);
  assert.deepEqual(plan.skippedSetups, []);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.excluded, []);
});

test('selectLanes combines positional job filters with affected and --all modes', () => {
  const affectedPortable = selectLanes(['cert-prep-backend', 'cert-prep-desktop'], {
    all: false,
    jobs: ['portable-quality'],
  });
  assert.ok(
    affectedPortable.selected.every((lane) => lane.job === 'portable-quality'),
  );
  assert.equal(affectedPortable.excluded.length, 11);
  assert.equal(affectedPortable.setups.includes('install-capture-runtime'), false);

  const windowsDocsOnly = selectLanes([], {
    all: false,
    jobs: ['windows-quality'],
  });
  assert.deepEqual(laneIds(windowsDocsOnly), ['verify-capture-version-source']);
  assert.deepEqual(windowsDocsOnly.setups, []);

  const allWindows = selectLanes([], { all: true, jobs: ['windows-quality'] });
  assert.equal(allWindows.selected.length, 11);
  assert.equal(allWindows.excluded.length, 10);
  assert.deepEqual(allWindows.skipped, []);
});

test('parseOptions handles flags, positional jobs and aliases, and rejects invalid inputs', () => {
  assert.deepEqual(parseOptions([]), {
    all: false,
    base: DEFAULT_BASE,
    jobs: [],
  } satisfies LocalCiOptions);
  assert.deepEqual(
    parseOptions(['--all', '--base=main', 'portable', 'windows-quality', 'portable-quality']),
    {
      all: true,
      base: 'main',
      jobs: ['portable-quality', 'windows-quality'],
    } satisfies LocalCiOptions,
  );
  assert.deepEqual(parseOptions(['--base', 'upstream/main', 'windows']), {
    all: false,
    base: 'upstream/main',
    jobs: ['windows-quality'],
  } satisfies LocalCiOptions);

  assert.throws(() => parseOptions(['unknown-job']), LocalCiOptionError);
  assert.throws(() => parseOptions(['--unknown-flag']), LocalCiOptionError);
  assert.throws(() => parseOptions(['--base']), LocalCiOptionError);
  assert.throws(() => parseOptions(['--base', '--all']), LocalCiOptionError);
  assert.throws(() => parseOptions(['--base=']), LocalCiOptionError);
});

test('extractJsonArray parses Nx JSON output even with extra banner lines', () => {
  assert.deepEqual(
    extractJsonArray('NX   Note about workspace\n\n["a", "b"]\n'),
    ['a', 'b'],
  );
  assert.deepEqual(extractJsonArray('[]'), []);
  assert.throws(() => extractJsonArray('no array here'));
  assert.throws(() => extractJsonArray('[123]'));
});

test('affectedMainProjects and formatSummary format PR-ready output with durations', () => {
  const options = parseOptions(['--base=origin/main']);
  const affected = ['cert-prep-backend', 'cert-prep-desktop'];
  const main = affectedMainProjects(affected);
  assert.deepEqual(main, ['cert-prep-backend', 'cert-prep-desktop']);
  const plan = selectLanes(affected, options);
  const summary = formatSummary(plan, options, main, [
    {
      job: 'portable-quality',
      name: 'Lint portable projects',
      detail: 'nx run-many -t lint -p cert-prep-backend --parallel=3',
      durationSeconds: 3.42,
    },
  ]);
  assert.match(summary, /### Local CI summary \(affected, base `origin\/main`\)/u);
  assert.match(
    summary,
    /Affected projects: `cert-prep-backend`, `cert-prep-desktop`/u,
  );
  assert.match(summary, /\(3\.4s\)/u);
  assert.match(summary, /Ran:/u);
  assert.match(summary, /Skipped \(not affected\):/u);
});

test('Nx file mapping: docs file affects no project', () => {
  assert.deepEqual(nxAffectedForFile('AGENTS.md'), []);
});

test('Nx file mapping: contracts change reaches ollama, backend, and desktop', () => {
  const affected = nxAffectedForFile(
    'packages/cert-prep-contracts/pyproject.toml',
  );
  for (const project of [
    'cert-prep-contracts',
    'cert-prep-ollama',
    'cert-prep-backend',
    'cert-prep-desktop',
  ]) {
    assert.ok(
      affected.includes(project),
      `expected ${project} in ${JSON.stringify(affected)}`,
    );
  }
  assert.equal(affected.includes('cert-prep'), false);
  assert.equal(affected.includes('cert-prep-e2e'), false);
});

test('Nx file mapping: backend change reaches desktop and not web or e2e', () => {
  const affected = nxAffectedForFile('apps/cert-prep-backend/pyproject.toml');
  assert.ok(affected.includes('cert-prep-backend'));
  assert.ok(affected.includes('cert-prep-desktop'));
  assert.equal(affected.includes('cert-prep'), false);
  assert.equal(affected.includes('cert-prep-e2e'), false);
});

test('Nx file mapping: web change reaches cert-prep and e2e and not backend', () => {
  const affected = nxAffectedForFile('apps/cert-prep/src/main.ts');
  assert.ok(affected.includes('cert-prep'));
  assert.ok(affected.includes('cert-prep-e2e'));
  assert.equal(affected.includes('cert-prep-backend'), false);
});

test('Nx file mapping: global files select every lane', () => {
  for (const globalFile of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'nx.json',
    'tsconfig.base.json',
    'tools/run-local-ci.mts',
    'tools/local-ci-plan.mts',
    '.github/workflows/ci.yml',
  ]) {
    const affected = nxAffectedForFile(globalFile);
    assert.deepEqual(
      laneIds(selectLanes(affected)),
      ALL_LANE_IDS,
      `expected ${globalFile} to select all lanes`,
    );
  }
});
