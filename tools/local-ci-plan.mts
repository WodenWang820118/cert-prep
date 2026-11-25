/** Pure planning, CLI parsing, and summary formatting for tools/run-local-ci.mts. */

export const DEFAULT_BASE = 'origin/main';

export type JobId = 'portable-quality' | 'windows-quality';

export type SetupId =
  | 'pnpm-install'
  | 'uv-sync'
  | 'playwright-chromium'
  | 'install-capture-runtime';

const KNOWN_JOBS = new Map<string, JobId>([
  ['portable', 'portable-quality'],
  ['portable-quality', 'portable-quality'],
  ['windows', 'windows-quality'],
  ['windows-quality', 'windows-quality'],
]);

const MAIN_PROJECTS = [
  'cert-prep',
  'cert-prep-api',
  'ui-helm',
  'cert-prep-contracts',
  'cert-prep-ollama',
  'cert-prep-backend',
  'cert-prep-e2e',
  'cert-prep-desktop',
] as const;

const PYTHON_PROJECTS: ReadonlySet<string> = new Set([
  'cert-prep-contracts',
  'cert-prep-ollama',
  'cert-prep-backend',
]);

export const SETUP_LABELS: Record<SetupId, string> = {
  'pnpm-install': 'Install published Capture Workbench packages',
  'uv-sync': 'Sync backend Python environment',
  'playwright-chromium': 'Install Playwright Chromium',
  'install-capture-runtime': 'Stage the published Capture Runtime release',
};

const SETUP_ORDER: readonly SetupId[] = [
  'pnpm-install',
  'uv-sync',
  'playwright-chromium',
  'install-capture-runtime',
];

export interface LocalCiOptions {
  readonly all: boolean;
  readonly base: string;
  readonly jobs: readonly JobId[];
}

export interface PlannedLane {
  readonly id: string;
  readonly job: JobId;
  readonly name: string;
  readonly setups: readonly SetupId[];
  readonly nx?: readonly string[];
}

export interface LanePlan {
  readonly setups: readonly SetupId[];
  readonly skippedSetups: readonly SetupId[];
  readonly selected: readonly PlannedLane[];
  readonly skipped: readonly PlannedLane[];
  readonly excluded: readonly PlannedLane[];
}

export interface RanLaneRecord {
  readonly job: JobId;
  readonly name: string;
  readonly detail?: string;
  readonly durationSeconds: number;
}

/** Thrown on invalid CLI flags, missing option values, or unknown job names. */
export class LocalCiOptionError extends Error {}

type LaneSpec =
  | {
      readonly kind: 'always';
      readonly id: string;
      readonly job: JobId;
      readonly name: string;
      readonly setups: readonly SetupId[];
      readonly nx?: readonly string[];
    }
  | {
      readonly kind: 'run-many-projects';
      readonly id: string;
      readonly job: JobId;
      readonly name: string;
      readonly prefix: readonly string[];
      readonly projects: readonly string[];
      readonly suffix: readonly string[];
      readonly setupsForProjects: (
        selectedProjects: readonly string[],
      ) => readonly SetupId[];
    }
  | {
      readonly kind: 'when-any';
      readonly id: string;
      readonly job: JobId;
      readonly name: string;
      readonly setups: readonly SetupId[];
      readonly nx?: readonly string[];
      readonly triggerProjects: readonly string[];
    };

function portableProjectSetups(
  selectedProjects: readonly string[],
): readonly SetupId[] {
  const needsUv = selectedProjects.some((project) =>
    PYTHON_PROJECTS.has(project),
  );
  return needsUv ? ['pnpm-install', 'uv-sync'] : ['pnpm-install'];
}

// Keep in step with .github/workflows/ci.yml.
const LANES: readonly LaneSpec[] = [
  {
    kind: 'run-many-projects',
    id: 'lint-portable',
    job: 'portable-quality',
    name: 'Lint portable projects',
    prefix: ['run-many', '-t', 'lint', '-p'],
    projects: [
      'cert-prep',
      'cert-prep-contracts',
      'cert-prep-ollama',
      'cert-prep-backend',
    ],
    suffix: ['--parallel=3'],
    setupsForProjects: portableProjectSetups,
  },
  {
    kind: 'run-many-projects',
    id: 'test-portable',
    job: 'portable-quality',
    name: 'Test portable projects',
    prefix: ['run-many', '-t', 'test', '-p'],
    projects: [
      'cert-prep',
      'cert-prep-contracts',
      'cert-prep-ollama',
      'cert-prep-backend',
    ],
    suffix: ['--parallel=3'],
    setupsForProjects: portableProjectSetups,
  },
  {
    kind: 'when-any',
    id: 'typecheck',
    job: 'portable-quality',
    name: 'Type-check projects',
    setups: ['pnpm-install'],
    nx: ['run-many', '-t', 'typecheck', '--parallel=3'],
    triggerProjects: [
      'cert-prep',
      'cert-prep-api',
      'cert-prep-e2e',
      'ui-helm',
      'cert-prep-desktop',
    ],
  },
  {
    kind: 'always',
    id: 'dead-code-gate',
    job: 'portable-quality',
    name: 'Dead-code gate',
    setups: ['pnpm-install', 'uv-sync'],
  },
  {
    kind: 'always',
    id: 'retired-names-gate',
    job: 'portable-quality',
    name: 'Retired-names gate',
    setups: [],
  },
  {
    kind: 'always',
    id: 'code-complexity-gate',
    job: 'portable-quality',
    name: 'Code size and complexity gate (TypeScript and Python)',
    setups: ['pnpm-install', 'uv-sync'],
  },
  {
    kind: 'always',
    id: 'test-architecture-tools',
    job: 'portable-quality',
    name: 'Test architecture tools',
    setups: ['pnpm-install'],
  },
  {
    kind: 'always',
    id: 'architecture-diagrams',
    job: 'portable-quality',
    name: 'Architecture diagrams',
    setups: ['pnpm-install', 'uv-sync'],
  },
  {
    kind: 'always',
    id: 'architecture-exceptions-gate',
    job: 'portable-quality',
    name: 'Architecture exceptions gate',
    setups: [],
  },
  {
    kind: 'when-any',
    id: 'test-api-client',
    job: 'portable-quality',
    name: 'Test generated API client',
    setups: ['pnpm-install'],
    nx: ['run', 'cert-prep-api:vite:test'],
    triggerProjects: ['cert-prep-api'],
  },
  {
    kind: 'when-any',
    id: 'build-angular',
    job: 'portable-quality',
    name: 'Build Angular application',
    setups: ['pnpm-install', 'uv-sync'],
    nx: ['run', 'cert-prep:build'],
    triggerProjects: ['cert-prep'],
  },
  {
    kind: 'when-any',
    id: 'e2e-mocked',
    job: 'portable-quality',
    name: 'Test mocked browser regression',
    setups: ['pnpm-install', 'playwright-chromium'],
    nx: [
      'run',
      'cert-prep-e2e:e2e-mocked-api',
      '--args=--project=chromium --workers=2',
    ],
    triggerProjects: ['cert-prep-e2e'],
  },
  {
    kind: 'always',
    id: 'verify-capture-version-source',
    job: 'windows-quality',
    name: 'Verify source Capture Runtime consumer declarations',
    setups: [],
  },
  {
    kind: 'when-any',
    id: 'desktop-typecheck-scripts',
    job: 'windows-quality',
    name: 'Type-check desktop scripts',
    setups: ['pnpm-install'],
    nx: ['run', 'cert-prep-desktop:typecheck-scripts'],
    triggerProjects: ['cert-prep-desktop'],
  },
  {
    // Always planned: in affected mode the gate itself leaves Clippy out when
    // no change since the base can alter the Rust findings.
    kind: 'always',
    id: 'rust-code-complexity-gate',
    job: 'windows-quality',
    name: 'Code size and complexity gate (Rust)',
    setups: ['pnpm-install'],
  },
  {
    kind: 'when-any',
    id: 'desktop-package-qa-test',
    job: 'windows-quality',
    name: 'Test package QA',
    setups: ['pnpm-install'],
    nx: ['run', 'cert-prep-desktop:package-qa-test'],
    triggerProjects: ['cert-prep-desktop'],
  },
  {
    kind: 'when-any',
    id: 'desktop-release-tool-test',
    job: 'windows-quality',
    name: 'Test release tooling contract',
    setups: ['pnpm-install', 'uv-sync'],
    nx: ['run', 'cert-prep-desktop:release-tool-test'],
    triggerProjects: ['cert-prep-desktop'],
  },
  {
    kind: 'when-any',
    id: 'verify-capture-installer',
    job: 'windows-quality',
    name: 'Verify Capture Runtime installer behavior',
    setups: [],
    triggerProjects: ['cert-prep-desktop'],
  },
  {
    kind: 'when-any',
    id: 'desktop-capture-smoke',
    job: 'windows-quality',
    name: 'Run the Capture Runtime consumer smoke',
    setups: ['pnpm-install', 'install-capture-runtime'],
    nx: [
      'run',
      'cert-prep-desktop:capture-runtime-consumer-smoke',
      '--skip-nx-cache',
    ],
    triggerProjects: ['cert-prep-desktop'],
  },
  {
    kind: 'when-any',
    id: 'desktop-capture-consumer-test',
    job: 'windows-quality',
    name: 'Test Capture consumer contract',
    setups: ['pnpm-install', 'install-capture-runtime'],
    nx: [
      'run',
      'cert-prep-desktop:capture-runtime-consumer-test',
      '--skip-nx-cache',
    ],
    triggerProjects: ['cert-prep-desktop'],
  },
  {
    kind: 'when-any',
    id: 'desktop-version-check',
    job: 'windows-quality',
    name: 'Verify adopted Capture versions and installed contract',
    setups: ['pnpm-install', 'install-capture-runtime'],
    nx: ['run', 'cert-prep-desktop:version-check', '--skip-nx-cache'],
    triggerProjects: ['cert-prep-desktop'],
  },
  {
    kind: 'when-any',
    id: 'verify-capture-registry',
    job: 'windows-quality',
    name: 'Verify published Capture registry installation',
    setups: [],
    triggerProjects: ['cert-prep-desktop'],
  },
  {
    kind: 'when-any',
    id: 'desktop-capture-candidate-gates',
    job: 'windows-quality',
    name: 'Test Capture candidate gates',
    setups: ['pnpm-install'],
    nx: [
      'run-many',
      '-p',
      'cert-prep-desktop',
      '-t',
      'capture-candidate-gate-test',
      'capture-candidate-install-binding-test',
    ],
    triggerProjects: ['cert-prep-desktop'],
  },
  {
    kind: 'when-any',
    id: 'desktop-cargo-test',
    job: 'windows-quality',
    name: 'Test Tauri host',
    setups: ['pnpm-install'],
    nx: ['run', 'cert-prep-desktop:cargo-test'],
    triggerProjects: ['cert-prep-desktop'],
  },
];

/**
 * Gate arguments of the two complexity steps, as `ci.yml` runs them. Only
 * affected mode lets the Rust step leave Clippy out when no Rust input changed.
 */
export function codeComplexityGateArgs(
  step: 'typescript-python' | 'rust',
  options: LocalCiOptions,
): string[] {
  if (step === 'typescript-python') return ['--ci', '--without', 'clippy'];
  return [
    '--ci',
    '--without',
    'eslint,ruff',
    ...(options.all ? [] : ['--clippy-when-changed-since', options.base]),
  ];
}

function validateBaseRef(value: string): string {
  if (value === '' || value.startsWith('-')) {
    throw new LocalCiOptionError(
      '--base requires a git ref such as origin/main.',
    );
  }
  return value;
}

/** Parses CLI arguments for local CI; throws LocalCiOptionError on bad input. */
export function parseOptions(argv: readonly string[]): LocalCiOptions {
  let all = false;
  let base = DEFAULT_BASE;
  const jobs: JobId[] = [];
  const unknownJobs: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--all') {
      all = true;
    } else if (arg === '--base') {
      base = validateBaseRef(argv[++index] ?? '');
    } else if (arg.startsWith('--base=')) {
      base = validateBaseRef(arg.slice('--base='.length));
    } else if (arg.startsWith('-')) {
      throw new LocalCiOptionError(`Unknown CI option: ${arg}.`);
    } else {
      const mapped = KNOWN_JOBS.get(arg.toLowerCase());
      if (mapped) {
        if (!jobs.includes(mapped)) jobs.push(mapped);
      } else {
        unknownJobs.push(arg);
      }
    }
  }

  if (unknownJobs.length > 0) {
    throw new LocalCiOptionError(
      `Unknown CI job: ${unknownJobs.join(', ')}. Valid jobs: portable, windows (or portable-quality, windows-quality).`,
    );
  }

  return { all, base, jobs };
}

/** Extracts a JSON array of project names from Nx stdout (ignoring banner lines). */
export function extractJsonArray(output: string): string[] {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Nx output did not contain a JSON array.');
  }
  const parsed: unknown = JSON.parse(output.slice(start, end + 1));
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item): item is string => typeof item === 'string')
  ) {
    throw new Error('Nx affected output must be a JSON array of strings.');
  }
  return parsed;
}

/** Filters an affected-projects list down to the workspace's main projects. */
export function affectedMainProjects(
  affectedProjects: readonly string[],
): string[] {
  const affected = new Set(affectedProjects);
  return MAIN_PROJECTS.filter((project) => affected.has(project));
}

/** Selects which CI lanes and setups run or are skipped for the affected projects. */
export function selectLanes(
  affectedProjects: readonly string[],
  options: { readonly all?: boolean; readonly jobs?: readonly string[] } = {},
): LanePlan {
  const all = options.all ?? false;
  const jobFilter = new Set(options.jobs ?? []);
  const affected = new Set(affectedProjects);
  const selected: PlannedLane[] = [];
  const skipped: PlannedLane[] = [];
  const excluded: PlannedLane[] = [];

  for (const spec of LANES) {
    const fullNx =
      spec.kind === 'run-many-projects'
        ? [...spec.prefix, ...spec.projects, ...spec.suffix]
        : spec.nx;
    const fullSetups =
      spec.kind === 'run-many-projects'
        ? spec.setupsForProjects(spec.projects)
        : spec.setups;

    if (jobFilter.size > 0 && !jobFilter.has(spec.job)) {
      excluded.push({
        id: spec.id,
        job: spec.job,
        name: spec.name,
        setups: fullSetups,
        ...(fullNx ? { nx: fullNx } : {}),
      });
      continue;
    }

    if (all || spec.kind === 'always') {
      selected.push({
        id: spec.id,
        job: spec.job,
        name: spec.name,
        setups: fullSetups,
        ...(fullNx ? { nx: fullNx } : {}),
      });
      continue;
    }

    if (spec.kind === 'run-many-projects') {
      const runProjects = spec.projects.filter((project) =>
        affected.has(project),
      );
      const skipProjects = spec.projects.filter(
        (project) => !affected.has(project),
      );
      if (runProjects.length > 0) {
        selected.push({
          id: spec.id,
          job: spec.job,
          name: spec.name,
          setups: spec.setupsForProjects(runProjects),
          nx: [...spec.prefix, ...runProjects, ...spec.suffix],
        });
      }
      if (skipProjects.length > 0) {
        skipped.push({
          id: spec.id,
          job: spec.job,
          name: spec.name,
          setups: spec.setupsForProjects(skipProjects),
          nx: [...spec.prefix, ...skipProjects, ...spec.suffix],
        });
      }
      continue;
    }

    if (spec.triggerProjects.some((project) => affected.has(project))) {
      selected.push({
        id: spec.id,
        job: spec.job,
        name: spec.name,
        setups: spec.setups,
        ...(spec.nx ? { nx: spec.nx } : {}),
      });
    } else {
      skipped.push({
        id: spec.id,
        job: spec.job,
        name: spec.name,
        setups: spec.setups,
        ...(spec.nx ? { nx: spec.nx } : {}),
      });
    }
  }

  const neededSetups = new Set<SetupId>();
  for (const lane of selected) {
    for (const setup of lane.setups) {
      neededSetups.add(setup);
    }
  }
  if (
    neededSetups.has('playwright-chromium') ||
    neededSetups.has('install-capture-runtime')
  ) {
    neededSetups.add('pnpm-install');
  }

  const setups = SETUP_ORDER.filter((setup) => neededSetups.has(setup));
  const skippedSetups = SETUP_ORDER.filter((setup) => !neededSetups.has(setup));

  return { setups, skippedSetups, selected, skipped, excluded };
}

function formatPlannedLaneLines(lanes: readonly PlannedLane[]): string[] {
  if (lanes.length === 0) return ['- (none)'];
  return lanes.map((lane) => {
    const command = lane.nx ? ` (\`nx ${lane.nx.join(' ')}\`)` : '';
    return `- \`${lane.job}\` — ${lane.name}${command}`;
  });
}

function formatRanLines(ran: readonly RanLaneRecord[]): string[] {
  if (ran.length === 0) return ['- (none)'];
  return ran.map((entry) => {
    const detail = entry.detail ? ` (${entry.detail})` : '';
    return `- \`${entry.job}\` — ${entry.name}${detail} (${entry.durationSeconds.toFixed(1)}s)`;
  });
}

/** Formats a Markdown summary suitable for pasting into a PR description. */
export function formatSummary(
  plan: LanePlan,
  options: LocalCiOptions,
  affectedMain: readonly string[],
  ran: readonly RanLaneRecord[],
): string {
  const mode = options.all ? 'all' : `affected, base \`${options.base}\``;
  const lines: string[] = [`### Local CI summary (${mode})`];

  if (!options.all) {
    const projects =
      affectedMain.length > 0
        ? affectedMain.map((project) => `\`${project}\``).join(', ')
        : 'none';
    lines.push(`Affected projects: ${projects}`);
  }

  if (options.jobs.length > 0) {
    lines.push(
      `Jobs requested: ${options.jobs.map((job) => `\`${job}\``).join(', ')}`,
    );
  }

  lines.push('', 'Ran:', ...formatRanLines(ran));

  const skippedLines: string[] = [
    ...plan.skippedSetups.map(
      (setup) => `- setup — ${SETUP_LABELS[setup]}`,
    ),
    ...(plan.skipped.length > 0 ? formatPlannedLaneLines(plan.skipped) : []),
  ];
  lines.push(
    '',
    'Skipped (not affected):',
    ...(skippedLines.length > 0 ? skippedLines : ['- (none)']),
  );

  if (plan.excluded.length > 0) {
    lines.push(
      '',
      'Not run (job filter):',
      ...formatPlannedLaneLines(plan.excluded),
    );
  }

  return lines.join('\n');
}
