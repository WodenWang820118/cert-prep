import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  type Command,
  type CommandResult,
  type ResolvedRelease,
  bumpBranch,
  parseOpenArguments,
  readPinnedContractSet,
  runCaptureBump,
} from './capture-bump.mts';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

/** The resolve-capture-release outputs for a newer release. */
function release(overrides: Partial<ResolvedRelease> = {}): ResolvedRelease {
  return {
    tag: 'v0.8.1',
    version: '0.8.1',
    manifestSha256: SHA_A,
    contractClassification: 'additive',
    contractSetSha256: SHA_B,
    changed: true,
    mode: 'route-a',
    ...overrides,
  };
}

type FakeState = {
  readonly branchExists?: boolean;
  readonly pulls?: readonly { number: number; state: string }[];
};

/** A fake runner for git, gh, node, pnpm, uv and cargo that records calls. */
function fakeRunner(state: FakeState = {}) {
  const calls: Command[] = [];
  const ok = (stdout = ''): CommandResult => ({
    status: 0,
    stdout,
    stderr: '',
  });
  const runner = (command: Command): CommandResult => {
    calls.push(command);
    const [first, second] = command.args;
    if (command.command === 'git' && first === 'ls-remote')
      return ok(
        state.branchExists ? `abc\trefs/heads/${command.args[3]}\n` : '',
      );
    if (command.command === 'gh' && first === 'pr' && second === 'list')
      return ok(JSON.stringify(state.pulls ?? []));
    if (command.command === 'git' && first === 'status')
      return ok(' M release/capture-version.json\n');
    if (command.command === 'node' && command.args[1] === 'plan')
      return ok('{"mode":"plan"}');
    return ok();
  };
  return { runner, calls };
}

const words = (calls: readonly Command[]) =>
  calls.map((call) => [call.command, ...call.args].join(' '));

function run(target: ResolvedRelease, state: FakeState = {}, dryRun = false) {
  const { runner, calls } = fakeRunner(state);
  const lines: string[] = [];
  const decision = runCaptureBump(target, runner, {
    dryRun,
    from: '0.8.0',
    log: (line) => lines.push(line),
  });
  return { decision, calls, lines };
}

test('an unchanged release is a no-op that runs no command', () => {
  const { decision, calls } = run(
    release({ version: '0.8.0', tag: 'v0.8.0', changed: false }),
  );
  assert.equal(decision.action, 'no-op');
  assert.deepEqual(calls, []);
});

test('an existing PR for the version skips the bump', () => {
  const { decision, calls } = run(release(), {
    pulls: [{ number: 41, state: 'CLOSED' }],
  });
  assert.equal(decision.action, 'skip');
  assert.match(decision.action === 'skip' ? decision.reason : '', /#41/u);
  assert.deepEqual(
    calls.map((call) => call.command),
    ['git', 'gh'],
  );
});

test('an existing branch for the version skips the bump', () => {
  const { decision, calls } = run(release(), { branchExists: true });
  assert.equal(decision.action, 'skip');
  assert.ok(!words(calls).some((call) => call.startsWith('node')));
});

for (const classification of ['additive', 'no-impact'] as const) {
  test(`a ${classification} release opens a ready PR after the bump steps`, () => {
    const { decision, calls } = run(
      release({ contractClassification: classification }),
    );
    assert.equal(decision.action, 'open-pr');
    const commands = words(calls);
    const order = [
      'node tools/version-owner.mts apply --version 0.8.1',
      'pnpm install --lockfile-only',
      'uv lock --upgrade-package capture-runtime-client',
      'cargo metadata --format-version 1 --manifest-path apps/cert-prep-desktop/src-tauri/Cargo.toml',
      'pnpm install --frozen-lockfile',
      'pnpm nx run cert-prep-backend:generate-openapi-client --skip-nx-cache',
      'node tools/version-owner.mts check',
      'git switch --create bot/capture-bump-0.8.1',
      'git push origin HEAD:refs/heads/bot/capture-bump-0.8.1',
    ].map((expected) => commands.indexOf(expected));
    assert.ok(
      order.every((index) => index >= 0),
      commands.join('\n'),
    );
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    );
    // Locks are refreshed only for Capture packages, never a blanket upgrade.
    assert.ok(
      !commands.some((call) =>
        /^(?:pnpm|cargo) (?:update|up)\b|--upgrade(?!-package)/u.test(call),
      ),
    );
    const create = calls.find(
      (call) => call.command === 'gh' && call.args[1] === 'create',
    );
    assert.ok(create);
    assert.ok(!create.args.includes('--draft'));
    const body = create.args[create.args.indexOf('--body') + 1];
    assert.match(body, new RegExp(`\`${classification}\``, 'u'));
    assert.match(body, new RegExp(SHA_A, 'u'));
    assert.match(body, new RegExp(SHA_B, 'u'));
    assert.match(body, /`ci\.yml` runs both jobs/u);
    assert.doesNotMatch(create.args.join(' '), /需遷移/u);
  });
}

for (const classification of ['breaking', 'manual-review'] as const) {
  test(`a ${classification} release opens a draft marked migration required`, () => {
    const { decision, calls } = run(
      release({ contractClassification: classification }),
    );
    assert.equal(decision.action, 'open-pr');
    const create = calls.find(
      (call) => call.command === 'gh' && call.args[1] === 'create',
    );
    assert.ok(create);
    assert.ok(create.args.includes('--draft'));
    const title = create.args[create.args.indexOf('--title') + 1];
    assert.match(title, /需遷移 \/ migration required/u);
  });
}

test('a dry run plans the bump without running any write', () => {
  const { decision, calls, lines } = run(release(), {}, true);
  assert.equal(decision.action, 'open-pr');
  assert.deepEqual(words(calls), [
    'git ls-remote --heads origin refs/heads/bot/capture-bump-0.8.1',
    'gh pr list --head bot/capture-bump-0.8.1 --state all --json number,state --limit 1',
    'node tools/version-owner.mts plan --version 0.8.1',
  ]);
  assert.ok(lines.some((line) => line.includes('gh pr create')));
});

test('a failing step stops before anything is committed or pushed', () => {
  const { runner, calls } = fakeRunner();
  const failing = (command: Command): CommandResult =>
    command.command === 'uv'
      ? (calls.push(command), { status: 1, stdout: '', stderr: 'no index' })
      : runner(command);
  assert.throws(
    () =>
      runCaptureBump(release(), failing, {
        dryRun: false,
        from: '0.8.0',
        log: () => undefined,
      }),
    /uv lock --upgrade-package failed/u,
  );
  assert.ok(!words(calls).some((call) => call.startsWith('git push')));
});

test('arguments are validated before anything runs', () => {
  const args = [
    '--tag',
    'v0.8.1',
    '--version',
    '0.8.1',
    '--manifest-sha256',
    SHA_A,
    '--contract-classification',
    'additive',
    '--contract-set-sha256',
    SHA_B,
    '--changed',
    'true',
  ];
  assert.equal(parseOpenArguments(args).release.version, '0.8.1');
  assert.equal(parseOpenArguments([...args, '--dry-run']).dryRun, true);
  const replace = (name: string, value: string) => {
    const copy = [...args];
    copy[copy.indexOf(name) + 1] = value;
    return copy;
  };
  assert.throws(() => parseOpenArguments(replace('--tag', 'v0.8.2')));
  assert.throws(() => parseOpenArguments(replace('--version', '0.8.1; rm')));
  assert.throws(() => parseOpenArguments(replace('--manifest-sha256', 'x')));
  assert.throws(() =>
    parseOpenArguments(replace('--contract-classification', 'minor')),
  );
  assert.throws(() => parseOpenArguments(replace('--changed', 'yes')));
  assert.throws(() => parseOpenArguments([...args, '--tag', 'v0.8.1']));
});

test('the pinned contract-set digest comes only from an attested manifest', () => {
  for (const attested of [true, false]) {
    let directory = '';
    const lines: string[] = [];
    const digest = readPinnedContractSet(
      (command) => {
        if (command.args[1] === 'download') {
          directory = command.args[command.args.indexOf('--dir') + 1];
          writeFileSync(
            join(directory, 'capture-runtime-candidate-manifest.json'),
            JSON.stringify({
              releaseVersion: '0.8.0',
              contractSetSha256: SHA_B,
            }),
          );
        }
        const verify = command.args[0] === 'attestation';
        return { status: verify && !attested ? 1 : 0, stdout: '', stderr: '' };
      },
      '0.8.0',
      (line) => lines.push(line),
    );
    assert.equal(digest, attested ? SHA_B : '');
    assert.equal(lines.length, attested ? 0 : 1);
    assert.equal(existsSync(directory), false, 'temp directory is removed');
  }
});

test('bump branches are versioned', () => {
  assert.equal(bumpBranch('1.2.3'), 'bot/capture-bump-1.2.3');
});
