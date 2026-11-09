/**
 * Opens Cert Prep's Capture Runtime version-bump pull request.
 *
 * `.github/workflows/capture-bump.yml` resolves the next Capture release with
 * gx-capture/capture-workbench's `resolve-capture-release` action (digest,
 * attestation and supersession checks live there) and hands its outputs to
 * this script, which decides whether to act and then runs the bump:
 *
 *   node tools/capture-bump.mts current
 *   node tools/capture-bump.mts open --tag v0.8.1 --version 0.8.1 \
 *     --manifest-sha256 <sha> --contract-classification additive \
 *     --contract-set-sha256 <sha> --changed true [--mode route-a] [--dry-run]
 *
 * `current` prints the pinned version and its contract-set digest in
 * GITHUB_OUTPUT form. `open --dry-run` writes nothing: it prints the decision,
 * the read-only source plan and the commands a real run would execute.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CAPTURE_REPOSITORY = 'gx-capture/capture-workbench';
const RUNTIME_MANIFEST_ASSET = 'capture-runtime-candidate-manifest.json';
/** The resolver's signers; the pinned manifest may come from either path. */
const SIGNER_WORKFLOWS = [
  `${CAPTURE_REPOSITORY}/.github/workflows/_publish-runtime-github-release.yml`,
  `${CAPTURE_REPOSITORY}/.github/workflows/_publish-github-release.yml`,
] as const;
const CLASSIFICATIONS = [
  'no-impact',
  'additive',
  'breaking',
  'manual-review',
] as const;
/** Classifications whose PR must stay a draft until Cert Prep migrates. */
const MIGRATION_CLASSIFICATIONS: ReadonlySet<ContractClassification> = new Set([
  'breaking',
  'manual-review',
]);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE_BRANCH = 'main';
const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

type ContractClassification = (typeof CLASSIFICATIONS)[number];

/** The resolve-capture-release action outputs, validated. */
export type ResolvedRelease = {
  readonly tag: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly contractClassification: ContractClassification;
  readonly contractSetSha256: string;
  readonly changed: boolean;
  readonly mode: string;
};

export type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** A command a bump runs; `cwd` is relative to the workspace root. */
export type Command = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Streams output to the job log instead of returning it. */
  readonly stream?: boolean;
};

/** Runs one command; injected so tests need neither network nor tools. */
export type CommandRunner = (command: Command) => CommandResult;

export type BumpDecision =
  | { readonly action: 'no-op'; readonly reason: string }
  | { readonly action: 'skip'; readonly reason: string }
  | {
      readonly action: 'open-pr';
      readonly branch: string;
      readonly draft: boolean;
      readonly title: string;
      readonly body: string;
      readonly commitMessage: string;
    };

type ExistingBump = {
  readonly branch: boolean;
  readonly pullRequest?: { readonly number: number; readonly state: string };
};

export function bumpBranch(version: string): string {
  return `bot/capture-bump-${version}`;
}

/**
 * The source, lock and contract steps, in order. Locks change only for the
 * Capture packages:
 * - `pnpm install --lockfile-only` re-resolves only importers whose specifier
 *   changed (the @gx-capture packages); `pnpm update` would also dedupe and
 *   prune unrelated entries.
 * - `uv lock --upgrade-package` upgrades only capture-runtime-client.
 * - `cargo metadata` only satisfies the changed capture-sidecar-launcher
 *   requirement; `cargo update -p` also rewrites unrelated windows-sys edges.
 * The frozen install puts the adopted SDK in node_modules, the API client is
 * regenerated with the adopted Python SDK, and `version-owner.mts check`
 * then proves the declarations, installed packages and contract bytes agree.
 */
export function bumpSteps(version: string): readonly Command[] {
  return [
    {
      command: 'node',
      args: ['tools/version-owner.mts', 'apply', '--version', version],
      stream: true,
    },
    { command: 'pnpm', args: ['install', '--lockfile-only'], stream: true },
    {
      command: 'uv',
      args: ['lock', '--upgrade-package', 'capture-runtime-client'],
      cwd: 'apps/cert-prep-backend',
      stream: true,
    },
    {
      command: 'cargo',
      args: [
        'metadata',
        '--format-version',
        '1',
        '--manifest-path',
        'apps/cert-prep-desktop/src-tauri/Cargo.toml',
      ],
    },
    { command: 'pnpm', args: ['install', '--frozen-lockfile'], stream: true },
    {
      command: 'pnpm',
      args: [
        'nx',
        'run',
        'cert-prep-backend:generate-openapi-client',
        '--skip-nx-cache',
      ],
      stream: true,
    },
    {
      command: 'node',
      args: ['tools/version-owner.mts', 'check'],
      stream: true,
    },
  ];
}

function publishSteps(
  decision: Extract<BumpDecision, { action: 'open-pr' }>,
): readonly Command[] {
  return [
    { command: 'git', args: ['switch', '--create', decision.branch] },
    { command: 'git', args: ['add', '--all'] },
    {
      command: 'git',
      args: [
        '-c',
        `user.name=${BOT_NAME}`,
        '-c',
        `user.email=${BOT_EMAIL}`,
        'commit',
        '--message',
        decision.commitMessage,
      ],
    },
    {
      command: 'git',
      args: ['push', 'origin', `HEAD:refs/heads/${decision.branch}`],
    },
    {
      command: 'gh',
      args: [
        'pr',
        'create',
        '--base',
        BASE_BRANCH,
        '--head',
        decision.branch,
        '--title',
        decision.title,
        '--body',
        decision.body,
        ...(decision.draft ? ['--draft'] : []),
      ],
    },
  ];
}

function prBody(
  release: ResolvedRelease,
  from: string,
  migration: boolean,
): string {
  return [
    `Automated Capture Runtime bump: \`${from}\` -> \`${release.version}\` (release \`${release.tag}\`, resolved in \`${release.mode}\` mode by \`resolve-capture-release\`).`,
    '',
    ...(migration
      ? [
          `> **需遷移 / migration required.** The contract classification is \`${release.contractClassification}\`: migrate Cert Prep's Capture consumers on this branch before marking it ready.`,
          '',
        ]
      : []),
    '| Field | Value |',
    '| --- | --- |',
    `| Contract classification | \`${release.contractClassification}\` |`,
    `| Contract-set SHA-256 | \`${release.contractSetSha256}\` |`,
    `| Manifest SHA-256 | \`${release.manifestSha256}\` |`,
    '',
    'Applied with `cert-prep-desktop:version-apply` (`tools/version-owner.mts`); only the Capture packages were re-locked (pnpm, uv, Cargo), `libs/cert-prep-api` was regenerated with the adopted SDK and `version-check` passed.',
    '',
    '## Before merging',
    '',
    '- [ ] Check out this branch and run `pnpm ci:local` (portable quality; packaging, Capture Runtime install and Tauri host on Windows), paste its summary into this PR, and merge only when it passes.',
    '- [ ] Run the real OCR acceptance `pnpm nx run cert-prep-desktop:acceptance-real` on the packaged app.',
    '',
    'This PR was opened with `GITHUB_TOKEN`, so it triggers no other workflow; the checks above are the gate.',
  ].join('\n');
}

/** Pure decision: what to do for a resolved release and the existing state. */
export function decideCaptureBump(
  release: ResolvedRelease,
  from: string,
  findExisting: (branch: string) => ExistingBump,
): BumpDecision {
  if (!release.changed)
    return {
      action: 'no-op',
      reason: `Capture ${release.version} is already pinned.`,
    };
  const branch = bumpBranch(release.version);
  const existing = findExisting(branch);
  if (existing.pullRequest)
    return {
      action: 'skip',
      reason: `PR #${existing.pullRequest.number} (${existing.pullRequest.state}) already exists for ${branch}.`,
    };
  if (existing.branch)
    return { action: 'skip', reason: `Branch ${branch} already exists.` };
  const migration = MIGRATION_CLASSIFICATIONS.has(
    release.contractClassification,
  );
  const title = `chore(capture): bump Capture Runtime to ${release.version}${migration ? ' (需遷移 / migration required)' : ''}`;
  return {
    action: 'open-pr',
    branch,
    draft: migration,
    title,
    body: prBody(release, from, migration),
    commitMessage: `chore(capture): bump Capture Runtime to ${release.version}\n\nContract classification: ${release.contractClassification}\nContract-set SHA-256: ${release.contractSetSha256}\nManifest SHA-256: ${release.manifestSha256}`,
  };
}

function describe(command: Command): string {
  const cwd = command.cwd ? `(cd ${command.cwd}) ` : '';
  return `${cwd}${command.command} ${command.args.map((arg) => (/^[\w./:=@-]+$/u.test(arg) ? arg : JSON.stringify(arg))).join(' ')}`;
}

function runChecked(runner: CommandRunner, command: Command): CommandResult {
  const result = runner(command);
  if (result.status !== 0)
    throw new Error(
      `${command.command} ${command.args.slice(0, 2).join(' ')} failed (exit ${String(result.status)}): ${(result.stderr || result.stdout).trim()}`,
    );
  return result;
}

function findExistingBump(runner: CommandRunner, branch: string): ExistingBump {
  const remote = runChecked(runner, {
    command: 'git',
    args: ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
  });
  const listed = runChecked(runner, {
    command: 'gh',
    args: [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'number,state',
      '--limit',
      '1',
    ],
  });
  const pulls = JSON.parse(listed.stdout || '[]') as {
    number: number;
    state: string;
  }[];
  return {
    branch: remote.stdout.trim().length > 0,
    pullRequest: pulls[0],
  };
}

export type RunOptions = {
  readonly dryRun: boolean;
  readonly from: string;
  readonly log: (line: string) => void;
};

/** Decides, then (unless dry-run) bumps, commits, pushes and opens the PR. */
export function runCaptureBump(
  release: ResolvedRelease,
  runner: CommandRunner,
  options: RunOptions,
): BumpDecision {
  const decision = decideCaptureBump(release, options.from, (branch) =>
    findExistingBump(runner, branch),
  );
  if (decision.action !== 'open-pr') {
    options.log(`${decision.action}: ${decision.reason}`);
    return decision;
  }
  options.log(
    `open-pr: ${decision.branch} (${decision.draft ? 'draft, migration required' : 'ready for review'})`,
  );
  if (options.dryRun) {
    const steps = [...bumpSteps(release.version), ...publishSteps(decision)];
    const plan = runChecked(runner, {
      command: 'node',
      args: ['tools/version-owner.mts', 'plan', '--version', release.version],
    });
    options.log(`Source plan:\n${plan.stdout.trim()}`);
    options.log('Commands a real run executes:');
    for (const step of steps) options.log(`  ${describe(step).slice(0, 160)}`);
    options.log(`PR title: ${decision.title}`);
    options.log(`PR body:
${decision.body}`);
    return decision;
  }
  for (const step of bumpSteps(release.version)) {
    options.log(`$ ${describe(step)}`);
    runChecked(runner, step);
  }
  const status = runChecked(runner, {
    command: 'git',
    args: ['status', '--porcelain'],
  });
  if (!status.stdout.trim())
    throw new Error(`Bumping to ${release.version} changed no file.`);
  for (const step of publishSteps(decision)) {
    options.log(`$ ${describe(step).slice(0, 160)}`);
    runChecked(runner, step);
  }
  return decision;
}

/**
 * The contract-set digest of the pinned release, read from its attested
 * runtime manifest. Empty when it cannot be proven; the resolver then
 * classifies a changed release as manual-review (draft), never as no-impact.
 */
export function readPinnedContractSet(
  runner: CommandRunner,
  version: string,
  log: (line: string) => void,
): string {
  const directory = mkdtempSync(join(tmpdir(), 'capture-bump-'));
  try {
    runChecked(runner, {
      command: 'gh',
      args: [
        'release',
        'download',
        `v${version}`,
        '--repo',
        CAPTURE_REPOSITORY,
        '--pattern',
        RUNTIME_MANIFEST_ASSET,
        '--dir',
        directory,
      ],
    });
    const path = join(directory, RUNTIME_MANIFEST_ASSET);
    const attested = SIGNER_WORKFLOWS.some(
      (signer) =>
        runner({
          command: 'gh',
          args: [
            'attestation',
            'verify',
            path,
            '--repo',
            CAPTURE_REPOSITORY,
            '--signer-workflow',
            signer,
          ],
        }).status === 0,
    );
    if (!attested)
      throw new Error(`${RUNTIME_MANIFEST_ASSET} is not attested.`);
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      releaseVersion?: unknown;
      contractSetSha256?: unknown;
    };
    if (
      manifest.releaseVersion !== version ||
      typeof manifest.contractSetSha256 !== 'string' ||
      !SHA256.test(manifest.contractSetSha256)
    )
      throw new Error(
        `${RUNTIME_MANIFEST_ASSET} does not describe ${version}.`,
      );
    return manifest.contractSetSha256;
  } catch (error) {
    log(
      `warning: no proven contract-set digest for ${version}: ${(error as Error).message}`,
    );
    return '';
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function parseOpenArguments(args: readonly string[]): {
  release: ResolvedRelease;
  dryRun: boolean;
} {
  const values = new Map<string, string>();
  let dryRun = false;
  const names = [
    '--tag',
    '--version',
    '--manifest-sha256',
    '--contract-classification',
    '--contract-set-sha256',
    '--changed',
    '--mode',
  ];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--dry-run' && !dryRun) {
      dryRun = true;
      continue;
    }
    const value = args[index + 1];
    if (!names.includes(name) || !value || values.has(name))
      throw new Error(`Invalid capture-bump argument: ${String(name)}.`);
    values.set(name, value);
    index += 1;
  }
  const version = values.get('--version') ?? '';
  const tag = values.get('--tag') ?? '';
  const classification = values.get('--contract-classification') ?? '';
  const changed = values.get('--changed');
  const manifestSha256 = values.get('--manifest-sha256') ?? '';
  const contractSetSha256 = values.get('--contract-set-sha256') ?? '';
  if (!VERSION.test(version) || tag !== `v${version}`)
    throw new Error(
      '--version must be MAJOR.MINOR.PATCH and --tag v<version>.',
    );
  if (!SHA256.test(manifestSha256) || !SHA256.test(contractSetSha256))
    throw new Error('Manifest and contract-set digests must be SHA-256.');
  if (!CLASSIFICATIONS.includes(classification as ContractClassification))
    throw new Error(`Unknown contract classification: ${classification}.`);
  if (changed !== 'true' && changed !== 'false')
    throw new Error('--changed must be true or false.');
  return {
    dryRun,
    release: {
      tag,
      version,
      manifestSha256,
      contractClassification: classification as ContractClassification,
      contractSetSha256,
      changed: changed === 'true',
      mode: values.get('--mode') ?? 'route-a',
    },
  };
}

function spawnRunner(root: string): CommandRunner {
  return (command) => {
    const result = spawnSync(command.command, command.args, {
      cwd: resolve(root, command.cwd ?? '.'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: command.stream ? 'inherit' : 'pipe',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

/** The adopted Capture version, from Cert Prep's single owner. */
function readPinnedVersion(root: string): string {
  const pin = JSON.parse(
    readFileSync(resolve(root, 'tools/capture-runtime-version.json'), 'utf8'),
  ) as { runtimeVersion?: unknown };
  if (
    typeof pin.runtimeVersion !== 'string' ||
    !VERSION.test(pin.runtimeVersion)
  )
    throw new Error(
      'tools/capture-runtime-version.json has no exact runtimeVersion.',
    );
  return pin.runtimeVersion;
}

export function main(
  args = process.argv.slice(2),
  root = resolve(import.meta.dirname, '..'),
  runner = spawnRunner(root),
): void {
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const [command, ...rest] = args;
  const from = readPinnedVersion(root);
  if (command === 'current' && rest.length === 0) {
    const digest = readPinnedContractSet(runner, from, log);
    process.stdout.write(`version=${from}\ncontract_set_sha256=${digest}\n`);
    return;
  }
  if (command !== 'open')
    throw new Error(
      'Usage: capture-bump.mts current | open <release outputs> [--dry-run]',
    );
  const { release, dryRun } = parseOpenArguments(rest);
  runCaptureBump(release, runner, { dryRun, from, log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
