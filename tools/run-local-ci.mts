// Runs the checks and Nx targets of .github/workflows/ci.yml on this machine.
// By default it runs the always-on workspace gates plus only the lanes affected
// between --base (default origin/main) and the working tree; pass --all before
// a release or whenever a full run is wanted, or positional job names
// (portable-quality, windows-quality) to restrict the run. Pull requests do not
// run CI on GitHub, so run this before merging and paste the summary into the
// PR description; keep the lane list in tools/local-ci-plan.mts in step with ci.yml.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import {
  type JobId,
  LocalCiOptionError,
  type LocalCiOptions,
  type PlannedLane,
  type RanLaneRecord,
  SETUP_LABELS,
  type SetupId,
  affectedMainProjects,
  extractJsonArray,
  formatSummary,
  parseOptions,
  selectLanes,
} from './local-ci-plan.mts';

const workspaceRoot = resolve(import.meta.dirname, '..');

// Run Nx with this Node directly: spawning pnpm on Windows needs a shell.
// Resolved per step, after the install step, so a fresh checkout without
// node_modules can bootstrap and a changed Nx version is picked up.
function resolveNx(): string {
  return createRequire(join(workspaceRoot, 'package.json')).resolve(
    'nx/bin/nx',
  );
}

function getCaptureRuntimeVersion(): string {
  const pinPath = join(workspaceRoot, 'tools/capture-runtime-version.json');
  const pin = JSON.parse(readFileSync(pinPath, 'utf8')) as {
    runtimeVersion: string;
  };
  return pin.runtimeVersion;
}

function runCommand(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true', NX_DAEMON: 'false' },
  });
  return result.status === 0;
}

function runNode(args: readonly string[]): boolean {
  return runCommand(process.execPath, args);
}

// pnpm is a .cmd shim on Windows, which only a shell can start. The arguments
// are fixed literals from the step list, so joining them is safe.
// PLAYWRIGHT_SKIP_BROWSER_GC keeps `playwright install` from deleting browser
// builds other checkouts on this machine still use from the shared cache.
function runPnpm(args: readonly string[]): boolean {
  const result = spawnSync(['pnpm', ...args].join(' '), {
    cwd: workspaceRoot,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      CI: 'true',
      NX_DAEMON: 'false',
      PLAYWRIGHT_SKIP_BROWSER_GC: '1',
    },
  });
  return result.status === 0;
}

// Same as CI's `pnpm install --frozen-lockfile`, so a branch whose lockfile and
// package.json disagree fails here. --prefer-offline reuses the local store, so
// GitHub Packages is contacted only for packages this machine has never fetched.
function installLockedDependencies(): boolean {
  if (runPnpm(['install', '--frozen-lockfile', '--prefer-offline'])) {
    return true;
  }
  console.error(
    'pnpm install failed. If GitHub Packages answered 401 or 404, point NPM_CONFIG_USERCONFIG at a temporary npmrc that holds //npm.pkg.github.com/:_authToken=<token> for this run and delete it afterwards; never commit or print the token.',
  );
  return false;
}

function runNx(args: readonly string[]): boolean {
  return runCommand(process.execPath, [
    resolveNx(),
    ...args,
    '--outputStyle=static',
  ]);
}

function queryAffectedProjects(base: string): string[] {
  const result = spawnSync(
    process.execPath,
    [resolveNx(), 'show', 'projects', '--affected', `--base=${base}`, '--json'],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: { ...process.env, NX_DAEMON: 'false' },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new Error(
      `Failed to run Nx affected query against ${base}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `Nx affected query against ${base} exited with status ${result.status}${detail ? `: ${detail}` : '.'}`,
    );
  }
  return extractJsonArray(result.stdout);
}

const CUSTOM_LANE_RUNNERS: Readonly<Record<string, () => boolean>> = {
  'dead-code-gate': () =>
    runNode([
      '--import',
      './apps/cert-prep-desktop/scripts/package-qa/canonical-test-temp.mts',
      '--test',
      'tools/dead-code-gate.test.mts',
      'tools/retired-names-gate.test.mts',
    ]) && runNode(['tools/dead-code-gate.mts', '--ci']),
  'retired-names-gate': () =>
    runNode(['tools/retired-names-gate.mts', '--ci']),
  'test-architecture-tools': () =>
    runNode([
      '--import',
      './apps/cert-prep-desktop/scripts/package-qa/canonical-test-temp.mts',
      '--test',
      'tools/architecture-graph.test.mts',
      'tools/architecture-diff.test.mts',
      'tools/architecture-exceptions-gate.test.mts',
      'tools/run-local-ci.test.mts',
    ]),
  'architecture-diagrams': () =>
    runNode(['tools/architecture-graph.mts', '--check']),
  'architecture-exceptions-gate': () =>
    runNode(['tools/architecture-exceptions-gate.mts', '--ci']),
  'verify-capture-version-source': () =>
    runNode([
      '--import',
      './apps/cert-prep-desktop/scripts/package-qa/canonical-test-temp.mts',
      '--test',
      'tools/capture-runtime-version.test.mts',
    ]),
  'verify-capture-installer': () =>
    runNode([
      '--import',
      './apps/cert-prep-desktop/scripts/package-qa/canonical-test-temp.mts',
      '--test',
      'tools/install-capture-runtime.test.mts',
    ]),
  'verify-capture-registry': () => {
    const captureVersion = getCaptureRuntimeVersion();
    return runCommand('uv', [
      'run',
      '--isolated',
      '--no-project',
      '--with',
      `capture-runtime-client==${captureVersion}`,
      '--',
      'python',
      '-c',
      `import capture_runtime_client; assert capture_runtime_client.CAPTURE_RUNTIME_VERSION == '${captureVersion}'`,
    ]);
  },
};

function executeSetup(setup: SetupId): boolean {
  switch (setup) {
    case 'pnpm-install':
      return installLockedDependencies();
    case 'uv-sync':
      return runCommand('uv', [
        'sync',
        '--project',
        'apps/cert-prep-backend',
        '--python',
        '3.14',
        '--frozen',
        '--reinstall-package',
        'capture-runtime-client',
      ]);
    case 'playwright-chromium':
      return runPnpm(['exec', 'playwright', 'install', 'chromium']);
    case 'install-capture-runtime':
      return runNx([
        'run',
        'cert-prep-desktop:install-capture-runtime',
        '--skip-nx-cache',
      ]);
  }
}

function executeLane(lane: PlannedLane): boolean {
  const custom = CUSTOM_LANE_RUNNERS[lane.id];
  if (custom) {
    return custom();
  }
  if (lane.nx) {
    return runNx(lane.nx);
  }
  throw new Error(`Lane "${lane.id}" has no execution handler.`);
}

let options: LocalCiOptions;
try {
  options = parseOptions(process.argv.slice(2));
} catch (error) {
  if (error instanceof LocalCiOptionError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}

let affectedProjects: string[] = [];
if (!options.all) {
  try {
    affectedProjects = queryAffectedProjects(options.base);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${message}\nCould not determine affected projects; re-run with --all to run every lane.`,
    );
    process.exit(1);
  }
}

const affectedMain = affectedMainProjects(affectedProjects);
if (options.all) {
  console.log('Local CI mode: all');
} else {
  const mainList =
    affectedMain.length > 0 ? affectedMain.join(', ') : '(none)';
  console.log(`Local CI base: ${options.base}`);
  console.log(`Affected projects: ${mainList}`);
}

const plan = selectLanes(affectedProjects, options);
const completedSetups = new Set<SetupId>();
const ran: RanLaneRecord[] = [];

function runSetupForJob(setup: SetupId, job: JobId): void {
  if (completedSetups.has(setup)) return;
  const label = SETUP_LABELS[setup];
  console.log(`\n== [${job}] ${label}`);
  const start = performance.now();
  const passed = executeSetup(setup);
  const durationSeconds = (performance.now() - start) / 1000;
  if (!passed) {
    console.error(`\nLocal CI failed at setup "${label}" in ${job}.`);
    process.exit(1);
  }
  completedSetups.add(setup);
  ran.push({ job, name: label, durationSeconds });
}

for (const lane of plan.selected) {
  for (const setup of lane.setups) {
    runSetupForJob(setup, lane.job);
  }

  console.log(`\n== [${lane.job}] ${lane.name}`);
  const start = performance.now();
  const passed = executeLane(lane);
  const durationSeconds = (performance.now() - start) / 1000;

  if (!passed) {
    console.error(`\nLocal CI failed at step "${lane.name}" in ${lane.job}.`);
    process.exit(1);
  }

  ran.push({
    job: lane.job,
    name: lane.name,
    ...(lane.nx ? { detail: `nx ${lane.nx.join(' ')}` } : {}),
    durationSeconds,
  });
}

console.log(`\n${formatSummary(plan, options, affectedMain, ran)}`);
const modeNote = options.all ? 'all' : `affected, base ${options.base}`;
console.log(`\nLocal CI passed. (${modeNote})`);
