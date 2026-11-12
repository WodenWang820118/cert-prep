// Runs the checks and Nx targets of .github/workflows/ci.yml on this machine.
// Pull requests do not run CI on GitHub, so run this before merging and paste
// the summary into the PR description.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

type JobId = 'portable-quality' | 'windows-quality';

interface Step {
  readonly job: JobId;
  readonly name: string;
  readonly nx?: readonly string[];
  readonly pnpm?: readonly string[];
  readonly node?: readonly string[];
  readonly commands?: readonly (readonly string[])[];
  readonly run?: () => boolean;
}

// keep in step with .github/workflows/ci.yml
const steps: readonly Step[] = [
  // --- Job: portable-quality (Portable quality) ---
  {
    job: 'portable-quality',
    name: 'Install published Capture Workbench packages',
    run: () => installLockedDependencies(),
  },
  {
    job: 'portable-quality',
    name: 'Sync backend Python environment',
    commands: [
      [
        'uv',
        'sync',
        '--project',
        'apps/cert-prep-backend',
        '--python',
        '3.14',
        '--frozen',
        '--reinstall-package',
        'capture-runtime-client',
      ],
    ],
  },
  {
    job: 'portable-quality',
    name: 'Lint portable projects',
    nx: [
      'run-many',
      '-t',
      'lint',
      '-p',
      'cert-prep',
      'cert-prep-contracts',
      'cert-prep-ollama',
      'cert-prep-backend',
      '--parallel=3',
    ],
  },
  {
    job: 'portable-quality',
    name: 'Test portable projects',
    nx: [
      'run-many',
      '-t',
      'test',
      '-p',
      'cert-prep',
      'cert-prep-contracts',
      'cert-prep-ollama',
      'cert-prep-backend',
      '--parallel=3',
    ],
  },
  {
    job: 'portable-quality',
    name: 'Type-check projects',
    nx: ['run-many', '-t', 'typecheck', '--parallel=3'],
  },
  {
    job: 'portable-quality',
    name: 'Dead-code gate',
    commands: [
      [
        'node',
        '--import',
        './apps/cert-prep-desktop/scripts/package-qa/canonical-test-temp.mts',
        '--test',
        'tools/dead-code-gate.test.mts',
      ],
      ['node', 'tools/dead-code-gate.mts', '--ci'],
    ],
  },
  {
    job: 'portable-quality',
    name: 'Test architecture tools',
    node: [
      '--import',
      './apps/cert-prep-desktop/scripts/package-qa/canonical-test-temp.mts',
      '--test',
      'tools/architecture-graph.test.mts',
      'tools/architecture-diff.test.mts',
      'tools/architecture-exceptions-gate.test.mts',
    ],
  },
  {
    job: 'portable-quality',
    name: 'Architecture diagrams',
    node: ['tools/architecture-graph.mts', '--check'],
  },
  {
    job: 'portable-quality',
    name: 'Architecture exceptions gate',
    node: ['tools/architecture-exceptions-gate.mts', '--ci'],
  },
  {
    job: 'portable-quality',
    name: 'Test generated API client',
    nx: ['run', 'cert-prep-api:vite:test'],
  },
  {
    job: 'portable-quality',
    name: 'Build Angular application',
    nx: ['run', 'cert-prep:build'],
  },
  {
    job: 'portable-quality',
    // CI also passes --with-deps, which installs Linux system packages with sudo;
    // a workstation only needs the browser revision Playwright pins.
    name: 'Install Playwright Chromium',
    pnpm: ['exec', 'playwright', 'install', 'chromium'],
  },
  {
    job: 'portable-quality',
    name: 'Test mocked browser regression',
    nx: [
      'run',
      'cert-prep-e2e:e2e-local-package',
      '--args=--project=chromium --workers=2',
    ],
  },

  // --- Job: windows-quality (Windows product quality) ---
  {
    job: 'windows-quality',
    name: 'Verify source Capture Runtime consumer declarations',
    node: ['--test', 'tools/capture-runtime-version.test.mts'],
  },
  {
    job: 'windows-quality',
    name: 'Install published Capture Workbench packages',
    run: () => installLockedDependencies(),
  },
  {
    job: 'windows-quality',
    name: 'Sync backend Python environment',
    commands: [
      [
        'uv',
        'sync',
        '--project',
        'apps/cert-prep-backend',
        '--python',
        '3.14',
        '--frozen',
        '--reinstall-package',
        'capture-runtime-client',
      ],
    ],
  },
  {
    job: 'windows-quality',
    name: 'Type-check desktop scripts',
    nx: ['run', 'cert-prep-desktop:typecheck-scripts'],
  },
  {
    job: 'windows-quality',
    name: 'Test package QA',
    nx: ['run', 'cert-prep-desktop:package-qa-test'],
  },
  {
    job: 'windows-quality',
    name: 'Test release tooling contract',
    nx: ['run', 'cert-prep-desktop:release-tool-test'],
  },
  {
    job: 'windows-quality',
    name: 'Stage the published Capture Runtime release',
    nx: ['run', 'cert-prep-desktop:install-capture-runtime', '--skip-nx-cache'],
  },
  {
    job: 'windows-quality',
    name: 'Verify Capture Runtime installer behavior',
    node: ['--test', 'tools/install-capture-runtime.test.mts'],
  },
  {
    job: 'windows-quality',
    name: 'Run the Capture Runtime consumer smoke',
    nx: [
      'run',
      'cert-prep-desktop:capture-runtime-consumer-smoke',
      '--skip-nx-cache',
    ],
  },
  {
    job: 'windows-quality',
    name: 'Test Capture consumer contract',
    nx: [
      'run',
      'cert-prep-desktop:capture-runtime-consumer-test',
      '--skip-nx-cache',
    ],
  },
  {
    job: 'windows-quality',
    name: 'Verify adopted Capture versions and installed contract',
    nx: ['run', 'cert-prep-desktop:version-check', '--skip-nx-cache'],
  },
  {
    job: 'windows-quality',
    name: 'Verify published Capture registry installation',
    run: () => {
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
  },
  {
    job: 'windows-quality',
    name: 'Test Capture candidate gates',
    nx: [
      'run-many',
      '-p',
      'cert-prep-desktop',
      '-t',
      'capture-candidate-gate-test',
      'capture-candidate-install-binding-test',
    ],
  },
  {
    job: 'windows-quality',
    name: 'Test Tauri host',
    nx: ['run', 'cert-prep-desktop:cargo-test'],
  },
];

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

function executeStep(step: Step): boolean {
  if (step.run) {
    return step.run();
  }
  if (step.nx) {
    return runNx(step.nx);
  }
  if (step.pnpm) {
    return runPnpm(step.pnpm);
  }
  if (step.node) {
    return runNode(step.node);
  }
  if (step.commands) {
    for (const [cmd, ...args] of step.commands) {
      const exe = cmd === 'node' ? process.execPath : cmd;
      if (!runCommand(exe, args)) return false;
    }
    return true;
  }
  throw new Error(`Step "${step.name}" has no execution handler.`);
}

interface StepResult {
  readonly job: JobId;
  readonly name: string;
  readonly status: 'passed' | 'failed';
  readonly duration: string;
}

function printSummary(results: readonly StepResult[]): void {
  console.log('\n=== Local CI Summary ===');
  let currentJob: JobId | '' = '';
  for (const r of results) {
    if (r.job !== currentJob) {
      currentJob = r.job;
      console.log(`\n-- ${currentJob} --`);
    }
    if (r.status === 'passed') {
      console.log(`- [passed]  ${r.name} (${r.duration})`);
    } else {
      console.log(`- [failed]  ${r.name} (${r.duration})`);
    }
  }
  console.log('========================');
}

const KNOWN_JOBS = new Map<string, JobId>([
  ['portable', 'portable-quality'],
  ['portable-quality', 'portable-quality'],
  ['windows', 'windows-quality'],
  ['windows-quality', 'windows-quality'],
]);

const userArgs = process.argv.slice(2);
const unknown = userArgs.filter((arg) => !KNOWN_JOBS.has(arg.toLowerCase()));
if (unknown.length > 0) {
  console.error(
    `Unknown CI job: ${unknown.join(', ')}. Valid jobs: portable, windows (or portable-quality, windows-quality).`,
  );
  process.exit(2);
}

const requestedJobs = new Set(
  userArgs.flatMap((arg) => KNOWN_JOBS.get(arg.toLowerCase()) ?? []),
);

const results: StepResult[] = [];

for (const step of steps) {
  if (requestedJobs.size > 0 && !requestedJobs.has(step.job)) {
    continue;
  }

  console.log(`\n== [${step.job}] ${step.name}`);
  const start = performance.now();
  const passed = executeStep(step);
  const duration = `${((performance.now() - start) / 1000).toFixed(1)}s`;

  if (!passed) {
    results.push({
      job: step.job,
      name: step.name,
      status: 'failed',
      duration,
    });
    printSummary(results);
    console.error(`\nLocal CI failed at step "${step.name}" in ${step.job}.`);
    process.exit(1);
  }

  results.push({
    job: step.job,
    name: step.name,
    status: 'passed',
    duration,
  });
}

printSummary(results);
console.log('\nLocal CI passed.');
