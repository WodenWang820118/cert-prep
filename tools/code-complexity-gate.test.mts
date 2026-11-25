import '../apps/cert-prep-desktop/scripts/package-qa/canonical-test-temp.mts';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  clippyBaseRef,
  clippyRunsForChanges,
  nulSeparatedPaths,
  runComplexityRatchet as runRatchet,
  stopHookExit,
  stopHookRun,
  toolsLeftOut,
} from './code-complexity-gate.mts';
import {
  compareFindings,
  parseComplexityConfig,
  parseEslintFindings,
  parseRuffFindings,
  productionFile,
  readRuffDiagnostics,
  type Finding,
} from './code-complexity-findings.mts';
import {
  applyNestingProbe,
  cargoErrors,
  changesRustFindings,
  clippyFindings,
  readClippyFindings,
} from './code-complexity-rust.mts';

const policy = readFileSync(new URL('./quality/code-complexity.json', import.meta.url), 'utf8');
const config = parseComplexityConfig(policy);
const root = tmpdir();

// The ratchet with findings already collected.
function runComplexityRatchet(repo: string, findings: Finding[] | (() => Finding[]), argv: string[]): number {
  return runRatchet(repo, typeof findings === 'function' ? findings : () => findings, argv);
}

function finding(symbol: string, value: number): Finding {
  return { tool: 'eslint', rule: 'complexity', file: 'src/application.ts', symbol, value };
}

test('ratchet rejects new and worsened findings, and only CI rejects a vanished entry', (t) => {
  const errors = t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'log', () => undefined);
  const repo = mkdtempSync(join(root, 'complexity-ratchet-'));
  const baseline = join(repo, 'tools/quality/code-complexity-baseline.json');
  mkdirSync(join(repo, 'tools/quality'), { recursive: true });
  writeFileSync(baseline, '[]\n');
  const known = [finding('first', 23), finding('second', 19)];

  assert.equal(runComplexityRatchet(repo, known, []), 1);
  assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), /2 new finding/);
  assert.equal(runComplexityRatchet(repo, known, ['--update']), 0);
  assert.equal(runComplexityRatchet(repo, known, ['--ci']), 0);

  assert.equal(runComplexityRatchet(repo, [finding('first', 24), known[1]], []), 1);
  assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), /worsened/);
  const improved = [finding('first', 21)];
  assert.equal(runComplexityRatchet(repo, improved, []), 0);
  assert.equal(runComplexityRatchet(repo, improved, ['--ci']), 1);
  assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), /baseline finding\(s\) are gone/);

  assert.equal(runComplexityRatchet(repo, improved, ['--update']), 0);
  assert.deepEqual(JSON.parse(readFileSync(baseline, 'utf8')), improved);
  assert.equal(runComplexityRatchet(repo, improved, ['--ci']), 0);
  assert.equal(runComplexityRatchet(repo, [finding('first', 22)], ['--ci']), 1);
  assert.equal(runComplexityRatchet(repo, [...improved, finding('first', 17)], ['--ci']), 1);
});

test('a run without Clippy ignores its baseline rows and never rewrites the baseline', (t) => {
  const errors = t.mock.method(console, 'error', () => undefined);
  const logs = t.mock.method(console, 'log', () => undefined);
  const repo = mkdtempSync(join(root, 'complexity-without-'));
  const baseline = join(repo, 'tools/quality/code-complexity-baseline.json');
  mkdirSync(join(repo, 'tools/quality'), { recursive: true });
  const rust: Finding = { tool: 'clippy', rule: 'too_many_lines', file: 'src/lib.rs', symbol: 'run', value: 80 };
  const typescript = finding('first', 23);
  writeFileSync(baseline, JSON.stringify([typescript, rust]));
  let collected = false;
  const collect = (findings: Finding[]) => () => {
    collected = true;
    return findings;
  };

  // The Clippy row is neither compared nor reported as gone, even with --ci.
  assert.equal(runComplexityRatchet(repo, collect([typescript]), ['--ci', '--without', 'clippy']), 0);
  assert.equal(runComplexityRatchet(repo, collect([typescript]), ['--ci']), 1);
  assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), /clippy\/too_many_lines/);
  // The other tools are still compared.
  assert.equal(runComplexityRatchet(repo, collect([finding('first', 24)]), ['--without', 'clippy']), 1);

  collected = false;
  assert.equal(runComplexityRatchet(repo, collect([typescript]), ['--update', '--without', 'clippy']), 2);
  assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), /--update needs every tool/);
  assert.equal(collected, false);
  assert.deepEqual(JSON.parse(readFileSync(baseline, 'utf8')), [typescript, rust]);

  // The Rust-only step with no Rust change: no tool runs, and that passes with a line saying so.
  collected = false;
  assert.equal(runComplexityRatchet(repo, collect([]), ['--ci', '--without', 'eslint,ruff', '--without', 'clippy']), 0);
  assert.equal(collected, false);
  assert.match(String(logs.mock.calls.at(-1)?.arguments[0]), /every tool is left out; nothing to check/);

  assert.deepEqual(toolsLeftOut(['--without', 'clippy,ruff', '--ci']), ['clippy', 'ruff']);
  assert.throws(() => toolsLeftOut(['--without', 'rustfmt']), /unknown tool 'rustfmt'/);
  assert.throws(() => toolsLeftOut(['--without']), /needs a tool name/);
});

test('Rust sources, manifests, lockfiles, Cargo, Clippy and toolchain configuration, the gate and CI can change Clippy findings', () => {
  for (const path of [
    'apps/cert-prep-desktop/src-tauri/src/backend_process.rs',
    'apps/cert-prep-desktop/scripts/fixtures/src/main.rs',
    'apps/cert-prep-desktop/src-tauri/Cargo.toml',
    'apps/cert-prep-desktop/src-tauri/Cargo.lock',
    'clippy.toml',
    'apps/cert-prep-desktop/src-tauri/.clippy.toml',
    'rust-toolchain.toml',
    'rust-toolchain',
    '.cargo/config.toml',
    'apps/cert-prep-desktop/src-tauri/.cargo/config',
    'tools/code-complexity-rust.mts',
    'tools/quality/code-complexity-baseline.json',
    'tools/quality/code-complexity.json',
    '.github/workflows/ci.yml',
    'tools/capture-runtime-version.json',
    'apps/cert-prep-desktop/src-tauri/tauri.conf.json',
  ]) assert.equal(changesRustFindings([path]), true, path);
  for (const path of [
    'apps/cert-prep-backend/src/cert_prep_backend/bootstrap/app.py',
    'apps/cert-prep/src/app/capture/data/cert-prep-capture-protocol.ts',
    'docs/domain/speech.md',
    'tools/dead-code-gate.mts',
    'tools/quality/dead-code-baseline.json',
    '.github/workflows/wiki-overview.yml',
    'apps/cert-prep-desktop/src-tauri/Cargo.toml.orig',
    'src/rust.rsx',
    'apps/cert-prep-desktop/src-tauri/cargo/config.toml',
    '.cargo/config.toml.orig',
  ]) assert.equal(changesRustFindings([path]), false, path);
  assert.equal(changesRustFindings([]), false);
});

test('the Stop hook runs only for measured changes, and Clippy only for Rust changes', () => {
  const typescript = 'apps/cert-prep/src/app/capture/data/cert-prep-capture-protocol.ts';
  const rust = 'apps/cert-prep-desktop/src-tauri/src/backend_process.rs';
  assert.equal(stopHookRun(false, [], config), undefined);
  assert.equal(stopHookRun(false, ['docs/domain/speech.md', 'AGENTS.md', 'tools/kept-run-trees.ts'], config), undefined);
  assert.equal(stopHookRun(false, ['apps/cert-prep/src/app/capture/data/cert-prep-capture-protocol.spec.ts'], config), undefined);
  assert.deepEqual(stopHookRun(false, ['docs/domain/speech.md', typescript], config), { leftOut: ['clippy'] });
  assert.deepEqual(stopHookRun(false, ['apps\\cert-prep-backend\\src\\cert_prep_backend\\bootstrap\\app.py'], config), { leftOut: ['clippy'] });
  assert.deepEqual(stopHookRun(false, [typescript, rust], config), { leftOut: [] });
  assert.deepEqual(stopHookRun(false, ['tools/quality/code-complexity.json'], config), { leftOut: [] });
  assert.deepEqual(stopHookRun(false, ['.cargo/config.toml'], config), { leftOut: [] });
  assert.equal(stopHookRun(true, [typescript, rust], config), undefined);
  // The hook's list joins `changedPaths` (porcelain lines, then the commits
  // ahead of the upstream) with the unquoted uncommitted listing: a committed
  // path counts on a clean tree, and the porcelain forms of a new directory
  // and a rename neither start nor stop a run on their own.
  assert.deepEqual(stopHookRun(false, [rust], config), { leftOut: [] });
  assert.equal(stopHookRun(false, ['apps/cert-prep/src/new-dir/', 'docs/a.md -> docs/b.md'], config), undefined);
  assert.deepEqual(stopHookRun(false, ['apps/cert-prep/src/new-dir/', typescript], config), { leftOut: ['clippy'] });
});

test('the Stop hook exits 2 for findings and 1, with the error on stderr, when its check fails', (t) => {
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  assert.equal(stopHookExit(() => 0), 0);
  assert.equal(stopHookExit(() => 1), 2);
  assert.equal(stderr.mock.callCount(), 0);
  assert.equal(stopHookExit(() => {
    throw new Error('git status failed (128)');
  }), 1);
  assert.match(String(stderr.mock.calls.at(-1)?.arguments[0]), /^code-complexity gate: git status failed \(128\)/);
});

test('--clippy-when-changed-since takes the ref Clippy decides against', () => {
  assert.equal(clippyBaseRef(['--ci']), undefined);
  assert.equal(clippyBaseRef(['--ci', '--clippy-when-changed-since', 'origin/main']), 'origin/main');
  assert.throws(() => clippyBaseRef(['--clippy-when-changed-since']), /needs a git ref/);
  assert.throws(() => clippyBaseRef(['--clippy-when-changed-since', '--ci']), /needs a git ref/);
});

test('Clippy runs when either the commits since the base or the working tree change a Rust input', () => {
  const docs = ['docs/domain/glossary.md', 'apps/cert-prep/src/main.ts'];
  const rust = 'apps/cert-prep-desktop/src-tauri/src/backend_process.rs';
  assert.equal(clippyRunsForChanges(docs, [rust]), true);
  assert.equal(clippyRunsForChanges(docs, ['apps/cert-prep-backend/src/cert_prep_backend/bootstrap/app.py']), false);
  assert.equal(clippyRunsForChanges([], []), false);
  assert.equal(clippyRunsForChanges([...docs, rust], []), true);
});

test('the changed-since diff is read as NUL-separated paths, so an unusual Rust path still counts', () => {
  // `git diff --name-only -z --no-renames`: unquoted paths, and both sides of
  // a rename from a Rust file to another name.
  const output = 'docs/domain/speech.md\0apps/cert-prep-desktop/src-tauri/src/名稱 process.rs\0';
  const paths = nulSeparatedPaths(output);
  assert.deepEqual(paths, ['docs/domain/speech.md', 'apps/cert-prep-desktop/src-tauri/src/名稱 process.rs']);
  assert.equal(changesRustFindings(paths), true);
  assert.equal(changesRustFindings(nulSeparatedPaths('src/old.rs\0src/old.md\0')), true);
  assert.equal(changesRustFindings(nulSeparatedPaths('docs/domain/speech.md\0')), false);
  assert.deepEqual(nulSeparatedPaths(''), []);
});

test('a failed cargo run reports its compiler errors past output that only looks like JSON', () => {
  const error = JSON.stringify({ reason: 'compiler-message', message: { level: 'error', rendered: 'error[E0425]: cannot find value' } });
  const warning = JSON.stringify({ reason: 'compiler-message', message: { level: 'warning', rendered: 'warning: unused' } });
  assert.equal(cargoErrors(['{ build script: not json', warning, error, 'Compiling x'].join('\n')), 'error[E0425]: cannot find value');
});

test('ESLint measurements use qualified names and survive a line shift', () => {
  const source = 'class Service {\n  execute() {\n    if (condition) {}\n  }\n  callback = () => {};\n}\n';
  function report(shift: number) {
    return parseEslintFindings([{
      filePath: join(root, 'src/application.ts'),
      messages: [
        { ruleId: 'complexity', line: 2 + shift, column: 3, message: "Method 'execute' has a complexity of 19. Maximum allowed is 15." },
        { ruleId: 'max-depth', line: 3 + shift, column: 5, message: 'Blocks are nested too deeply (4). Maximum allowed is 3.' },
        { ruleId: 'max-params', line: 5 + shift, column: 3, message: "Method 'callback' has too many parameters (5). Maximum allowed is 4." },
        { ruleId: 'max-lines', line: 269 + shift, column: 1, message: 'File has too many lines (270). Maximum allowed is 268.' },
      ],
    }], root, () => '\n'.repeat(shift) + source);
  }
  assert.deepEqual(report(0), [
    finding('Service.execute', 19),
    { ...finding('Service.execute', 4), rule: 'max-depth' },
    { ...finding('Service.callback', 5), rule: 'max-params' },
    { ...finding('<file>', 270), rule: 'max-lines' },
  ]);
  assert.deepEqual(report(12), report(0));
});

test('the threshold file supplies all rule values and rejects missing or invalid values', () => {
  const adjusted = JSON.parse(policy);
  adjusted.thresholds.ruff.C901 = 27;
  assert.equal(parseComplexityConfig(JSON.stringify(adjusted)).thresholds.ruff.C901, 27);
  adjusted.thresholds.ruff.C901 = '27';
  assert.throws(() => parseComplexityConfig(JSON.stringify(adjusted)), /ruff\/C901/);
  adjusted.thresholds.ruff.C901 = 27;
  delete adjusted.thresholds.eslint.complexity;
  assert.throws(() => parseComplexityConfig(JSON.stringify(adjusted)), /eslint\/complexity/);
  assert.throws(() => parseComplexityConfig(policy.replace('"exclude": [', '"unrecognized": [')), /glob list: exclude/);
});

test('only PLR0913 is exempt in actual FastAPI route modules', () => {
  const file = 'apps/cert-prep-backend/src/cert_prep_backend/capture_integration/api/router.py';
  const helper = file.replace('router.py', 'helpers.py');
  const diagnostic = (name: string, code: string, message: string) =>
    ({ filename: join(root, name), code, location: { row: 20 }, message });
  const output = JSON.stringify([
    diagnostic(file, 'PLR0913', 'Too many arguments in function definition (8 > 5)'),
    diagnostic(file, 'C901', 'function is too complex (17 > 15)'),
    diagnostic(file, 'PLR0915', 'Too many statements (62 > 60)'),
    diagnostic(file, 'PLR1702', 'Too many nested blocks (4 > 3)'),
    diagnostic(helper, 'PLR0913', 'Too many arguments in function definition (8 > 5)'),
    diagnostic('apps/cert-prep-backend/tests/test_api.py', 'C901', 'function is too complex (20 > 15)'),
  ]);
  const findings = parseRuffFindings(readRuffDiagnostics(output, root, config), () => 'route');
  assert.deepEqual(findings.map(({ file, rule, value }) => [file, rule, value]), [
    [file, 'C901', 17], [file, 'PLR0915', 62], [file, 'PLR1702', 4], [helper, 'PLR0913', 8],
  ]);
});

test('exclusions cover tooling, tests, generated, copied and vendored code', () => {
  const excluded = [
    'tools/measure.ts',
    'apps/cert-prep/eslint.config.mts',
    'apps/cert-prep/src/app/home.spec.ts',
    'apps/cert-prep-e2e/src/playwright-helper.ts',
    'libs/ui/src/lib/button.ts',
    'apps/cert-prep-desktop/src-tauri/tests/main.rs',
    'apps/cert-prep-desktop/scripts/fixtures/deterministic-runtime/src/main.rs',
    'apps/cert-prep-desktop/scripts/build.py',
    'apps/cert-prep-backend/src/cert_prep_backend/platform/_vendor/library.py',
    'libs/cert-prep-api/src/lib/cert-prep-api.generated.ts',
    '.agents/skills/example/helpers.py',
    'apps/cert-prep/src/app/core/domain/generated-client.typecheck.ts',
    'apps/cert-prep/src/app/runtime/data/health.store.spec-helpers.ts',
    '.github/skills/example/helper.py',
    '.opencode/skills/example/helper.py',
    'apps/cert-prep-desktop/src-tauri/src/process/process_tests.rs',
    'apps/cert-prep-desktop/src-tauri/build.rs',
  ];
  for (const file of excluded) assert.equal(productionFile(file, config), false, file);
  for (const file of [
    'apps/cert-prep/src/main.ts',
    'apps/cert-prep-backend/src/cert_prep_backend/capture_integration/api/router.py',
    'apps/cert-prep-desktop/src-tauri/src/backend_process.rs',
    'apps/cert-prep-backend/src/cert_prep_backend/platform/database.py',
  ]) assert.equal(productionFile(file, config), true, file);
});

test('Clippy probes record the deepest descendant with the enclosing Rust symbol', () => {
  const manifest = join(root, 'Cargo.toml');
  const source = 'impl Store {\n  fn update() {\n    { { work(); } }\n  }\n}\n';
  const start = source.indexOf('{ {');
  const nested = source.indexOf('{ work');
  function diagnostic(rule: string, message: string, from: number, to: number, file = 'src/store.rs') {
    return JSON.stringify({
      reason: 'compiler-message',
      manifest_path: manifest,
      message: {
        code: { code: 'clippy::' + rule },
        message,
        spans: [{ is_primary: true, file_name: file, byte_start: from, byte_end: to }],
      },
    });
  }
  const base = readClippyFindings([
    diagnostic('excessive_nesting', 'this block is too nested', start, source.indexOf('\n  }')),
    diagnostic('too_many_lines', 'this function has too many lines (62/60)', source.indexOf('fn'), source.lastIndexOf('}')),
    diagnostic('too_many_lines', 'this function has too many lines (80/60)', 0, 10, 'build.rs'),
  ].join('\n'), root, manifest, config, 5);
  const probe = readClippyFindings(
    diagnostic('excessive_nesting', 'this block is too nested', nested, source.indexOf('}', nested) + 1),
    root, manifest, config, 6,
  );
  applyNestingProbe(base, probe);
  assert.deepEqual(clippyFindings(base, () => source).map(({ rule, symbol, value }) => [rule, symbol, value]), [
    ['excessive_nesting', 'impl Store::update', 7],
    ['too_many_lines', 'impl Store::update', 62],
  ]);
});

function unchanged(current: Finding[], baseline: Finding[]): void {
  assert.deepEqual(compareFindings(current, baseline), { added: [], stale: [], worsened: [] });
}

test('ESLint names interface and type-literal members that hold function types', () => {
  const source = [
    'interface Context {',
    '  failTask(a: string, b: string, c: string, d: string, e: string): void;',
    '  readonly retry: (a: number, b: number, c: number, d: number, e: number) => void;',
    '}',
    'type Options = {',
    '  readonly report: (a: number, b: number, c: number, d: number, e: number) => void;',
    '};',
    '',
  ].join('\n');
  const lines = source.split('\n');
  const at = (line: number, text: string) => ({
    ruleId: 'max-params',
    line,
    column: lines[line - 1].indexOf(text) + 1,
    message: 'Function has too many parameters (5). Maximum allowed is 4.',
  });
  const findings = parseEslintFindings([{
    filePath: join(root, 'src/contracts.ts'),
    messages: [at(2, 'failTask'), at(3, '(a'), at(6, '(a')],
  }], root, () => source);
  assert.deepEqual(findings.map(({ symbol }) => symbol), ['Context.failTask', 'Context.retry', 'Options.report']);
});

test('unrecognized or unparsable diagnostics fail with an error instead of being dropped', () => {
  const eslint = (message: { ruleId: string | null; message: string; fatal?: boolean }) =>
    () => parseEslintFindings([{ filePath: join(root, 'src/a.ts'), messages: [{ line: 1, column: 1, ...message }] }], root, () => 'f();\n');
  assert.throws(eslint({ ruleId: 'complexity', message: 'Function is rather complex.' }), /Unrecognized lint diagnostic/);
  assert.throws(eslint({ ruleId: null, message: 'Parsing error: Unexpected token', fatal: true }), /could not parse src\/a\.ts:1/);

  const ruff = (code: string, message: string) => () => parseRuffFindings(readRuffDiagnostics(JSON.stringify([
    { filename: join(root, 'src/app.py'), code, location: { row: 3 }, message },
  ]), root, config), () => 'handler');
  assert.throws(ruff('C901', '`handler` is too complex'), /Unrecognized lint diagnostic/);
  assert.throws(ruff('E501', 'Line too long (120 > 88)'), /Unexpected Ruff diagnostic in src\/app\.py:3/);

  const manifest = join(root, 'Cargo.toml');
  const clippy = JSON.stringify({
    reason: 'compiler-message',
    manifest_path: manifest,
    message: {
      code: { code: 'clippy::too_many_lines' },
      message: 'this function has too many lines',
      spans: [{ is_primary: true, file_name: 'src/lib.rs', byte_start: 0, byte_end: 4 }],
    },
  });
  assert.throws(() => readClippyFindings(clippy, root, manifest, config, 5), /Unrecognized Clippy diagnostic/);
});

test('a Ruff finding that only moved lines compares as unchanged', () => {
  const file = 'apps/cert-prep-backend/src/cert_prep_backend/worker.py';
  const diagnostics = (row: number) => readRuffDiagnostics(JSON.stringify([
    { filename: join(root, file), code: 'C901', location: { row }, message: '`request` is too complex (31 > 15)' },
  ]), root, config);
  // The resolver names the function at each line; the moved copy resolves to the same function.
  const symbolAt = (_file: string, line: number) => (line === 120 || line === 135 ? 'WorkerProcess.request' : '<module>');
  const before = parseRuffFindings(diagnostics(120), symbolAt);
  const after = parseRuffFindings(diagnostics(135), symbolAt);
  assert.deepEqual(after, before);
  unchanged(after, before);
});

const RUST_SOURCE = [
  '// 名稱 impl Fake { fn hidden() {',
  'mod outer {',
  '    mod inner {',
  '        /* } fn /* nested } */ impl } */',
  '        pub fn helper() {',
  '            let text = r#"impl "}" { fn x() {"#;',
  '            let close = "} fn";',
  '            let brace = \'}\';',
  '            let run = |value: u8| {',
  '                if value > 0 { work(); }',
  '            };',
  '        }',
  '    }',
  '}',
  'impl<T> Display for Wrapper<T>',
  'where',
  '    T: Debug,',
  '{',
  '    fn fmt(&self) -> Result {',
  '        { { deep(); } }',
  '    }',
  '}',
  'fn generic<F>(callback: F) -> u8',
  'where',
  '    F: Fn(u8) -> u8,',
  '{',
  '    callback(1)',
  '}',
  '',
].join('\n');

function rustDiagnostics(source: string): string {
  const manifest = join(root, 'Cargo.toml');
  const bytes = (text: string, from = 0) => Buffer.byteLength(source.slice(0, source.indexOf(text, from)));
  const diagnostic = (rule: string, message: string, start: string, end: string) => JSON.stringify({
    reason: 'compiler-message',
    manifest_path: manifest,
    message: {
      code: { code: 'clippy::' + rule },
      message,
      spans: [{ is_primary: true, file_name: 'src/format.rs', byte_start: bytes(start), byte_end: bytes(end, source.indexOf(start)) }],
    },
  });
  return [
    diagnostic('excessive_nesting', 'this block is too nested', '{ work', '}\n'),
    diagnostic('too_many_lines', 'this function has too many lines (64/60)', 'fn fmt', '\n    }'),
    diagnostic('excessive_nesting', 'this block is too nested', '{ deep', '}\n'),
    diagnostic('too_many_arguments', 'this function has too many arguments (6/5)', 'fn generic', 'u8\nwhere'),
  ].join('\n');
}

function rustFindings(source: string): Finding[] {
  const manifest = join(root, 'Cargo.toml');
  return clippyFindings(readClippyFindings(rustDiagnostics(source), root, manifest, config, 5), () => source);
}

test('Clippy findings are named by the enclosing Rust item, past literals, comments and closures', () => {
  assert.deepEqual(rustFindings(RUST_SOURCE).map(({ rule, symbol }) => [rule, symbol]), [
    ['excessive_nesting', 'outer::inner::helper'],
    ['too_many_lines', 'impl<T> Display for Wrapper<T>::fmt'],
    ['excessive_nesting', 'impl<T> Display for Wrapper<T>::fmt'],
    ['too_many_arguments', 'generic'],
  ]);
});

test('a Clippy finding that only moved lines compares as unchanged', () => {
  const before = rustFindings(RUST_SOURCE);
  const after = rustFindings('use std::fmt::Display;\n\n' + RUST_SOURCE);
  assert.deepEqual(after, before);
  unchanged(after, before);
});

// The symbol Clippy's over-nested block (`{ work(); }` by default) is attributed to.
function nestedBlockSymbol(source: string, block = '{ work'): string {
  const start = source.indexOf(block);
  assert.ok(start >= 0, block);
  const [named] = clippyFindings(
    [{ file: 'src/lib.rs', rule: 'excessive_nesting', start, end: source.indexOf('}', start) + 1, value: 6 }],
    () => source,
  );
  return named.symbol;
}

test('Rust function-pointer and const-generic types do not end or replace a pending item header', () => {
  // A function-pointer field leaves no header behind when its struct closes.
  assert.equal(nestedBlockSymbol('struct S { cb: fn() -> u8 }\nfn after() {\n    { work(); }\n}\n'), 'after');
  // A function-pointer type in a where clause stays part of the impl header.
  assert.equal(
    nestedBlockSymbol('impl<T> Foo<T> where T: Into<fn()> {\n    fn bar() { { work(); } }\n}\n'),
    'impl<T> Foo<T>::bar',
  );
  // A const-generic block argument stays part of the impl header.
  assert.equal(
    nestedBlockSymbol('impl<const N: usize> Foo<{ N + 1 }> {\n    fn bar() { { work(); } }\n}\n'),
    'impl<const N: usize> Foo<{ N + 1 }>::bar',
  );
});

// An odd header, then an ordinary item: both must be named by their own header.
function namesAroundOddHeader(header: string): [string, string] {
  const source = `${header} {\n    fn a() { { inner(); } }\n}\nfn after() {\n    { later(); }\n}\n`;
  return [nestedBlockSymbol(source, '{ inner'), nestedBlockSymbol(source, '{ later')];
}

test('a comparison or shift inside a const-generic block does not move the end of a Rust header', () => {
  assert.deepEqual(
    namesAroundOddHeader('impl<const N: usize> Foo<{ N < 1 }>'),
    ['impl<const N: usize> Foo<{ N < 1 }>::a', 'after'],
  );
  assert.deepEqual(
    namesAroundOddHeader('impl<const N: usize, const M: usize> Bar for Foo<{ N >> 1 }, { M }>'),
    ['impl<const N: usize, const M: usize> Bar for Foo<{ N >> 1 }, { M }>::a', 'after'],
  );
  assert.deepEqual(
    namesAroundOddHeader('impl Foo<{ let small = |x: usize| x < 2; small(1) as usize }>'),
    ['impl Foo<{ let small = |x: usize| x < 2; small(1) as usize }>::a', 'after'],
  );
});

test('a `<` in a comment, string or character literal of a Rust signature does not open its generics', () => {
  const source = (signature: string) =>
    `${signature}\n{\n    { inner(); }\n}\nfn after() {\n    { later(); }\n}\n`;
  for (const [signature, name] of [
    ['fn compare(a: u8, b: u8) -> bool // a < b', 'compare'],
    ['fn tagged(#[cfg_attr(any(), doc = "a < b")] value: u8)', 'tagged'],
    ["fn sized<T>() where [(); \"<\".len() + '<' as usize]: Sized", 'sized'],
    ['fn shifted() -> [u8; 1 << 3]', 'shifted'],
  ]) {
    assert.deepEqual(
      [nestedBlockSymbol(source(signature), '{ inner'), nestedBlockSymbol(source(signature), '{ later')],
      [name, 'after'],
      signature,
    );
  }
});
