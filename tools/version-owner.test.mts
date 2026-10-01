import { isCaptureRuntimePythonWheelFileName } from '../apps/cert-prep-desktop/scripts/capture-runtime-python-wheel.mts';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  CAPTURE_RUNTIME_VERSION,
  CAPTURE_SIDECAR_LAUNCHER_VERSION,
  CAPTURE_RUNTIME_MODEL,
} from './capture-runtime-version.mts';
import { CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS } from './capture-runtime-consumer-source.mts';
import {
  applyVersionPlan,
  planVersions,
  readCaptureVersion,
  readInstalledCaptureContract,
  runVersionCommand,
} from './version-owner.mts';

// Candidate gate runs install checks explicitly; these updater fixtures model the published path.
delete process.env.CAPTURE_CANDIDATE_INSTALL;

function fixture(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cert-version-owner-'));
  const paths = new Set([
    ...planVersions(process.cwd(), 'capture').files.map((file) => file.path),
    ...planVersions(process.cwd(), 'product').files.map((file) => file.path),
    ...CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS,
    '.python-version',
    'apps/cert-prep-backend/project.json',
    'apps/cert-prep-backend/scripts/build_backend_runtime.py',
  ]);
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(process.cwd(), path), join(root, path));
  }
  return Promise.resolve()
    .then(() => run(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

function bytes(root: string, paths: readonly string[]): string[] {
  return paths.map((path) => readFileSync(join(root, path), 'utf8'));
}

test('the facade and aliases share the adoption source', () => {
  assert.equal(
    CAPTURE_RUNTIME_VERSION,
    readCaptureVersion(
      readFileSync('tools/capture-runtime-version.json', 'utf8'),
    ),
  );
  assert.equal(CAPTURE_SIDECAR_LAUNCHER_VERSION, CAPTURE_RUNTIME_VERSION);
  assert.equal(
    CAPTURE_RUNTIME_MODEL,
    `capture-runtime@${CAPTURE_RUNTIME_VERSION}`,
  );
  assert.throws(
    () =>
      readCaptureVersion('{"runtimeVersion":"0.4.4","runtimeVersion":"0.4.5"}'),
    /Duplicate JSON field|exactly one/,
  );
  for (const value of [
    'latest',
    '^0.4.4',
    '01.4.4',
    '0.4.4\n',
    '0.4.4-alpha.01',
  ]) {
    assert.throws(
      () => readCaptureVersion(JSON.stringify({ runtimeVersion: value })),
      /Invalid/,
    );
  }
});

test('Capture rehearsal updates only the six declared fields and is idempotent', () =>
  fixture((root) => {
    const manifestPath = join(root, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies['unrelated-same-version'] = CAPTURE_RUNTIME_VERSION;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const preserved = [
      'pnpm-lock.yaml',
      'apps/cert-prep-backend/uv.lock',
      'apps/cert-prep-desktop/src-tauri/Cargo.lock',
      'libs/cert-prep-api/src/lib/cert-prep-api.generated.ts',
      'apps/cert-prep-desktop/src-tauri/tauri.conf.json',
    ];
    const before = bytes(root, preserved);
    const plan = planVersions(root, 'capture', '9.8.7');
    assert.equal(plan.changes.length, 6);
    assert.deepEqual(
      new Set(plan.changes.map((change) => change.path)),
      new Set([
        'tools/capture-runtime-version.json',
        'package.json',
        'pnpm-workspace.yaml',
        'apps/cert-prep-backend/pyproject.toml',
        'apps/cert-prep-desktop/src-tauri/Cargo.toml',
      ]),
    );
    applyVersionPlan(root, plan);
    assert.equal(
      JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies[
        'unrelated-same-version'
      ],
      CAPTURE_RUNTIME_VERSION,
    );
    assert.deepEqual(bytes(root, preserved), before);
    assert.deepEqual(planVersions(root, 'capture', '9.8.7').changes, []);
    assert.ok(plan.pending.some((step) => step.includes('lock')));
  }));

test('Cargo exact pins retain the equals prefix when applying an adoption change', () =>
  fixture((root) => {
    const cargo = join(root, 'apps/cert-prep-desktop/src-tauri/Cargo.toml');
    writeFileSync(
      cargo,
      readFileSync(cargo, 'utf8').replace(
        /^capture-sidecar-launcher[^\r\n]*/mu,
        `capture-sidecar-launcher = "=${CAPTURE_RUNTIME_VERSION}"`,
      ),
    );
    assert.deepEqual(planVersions(root, 'capture').changes, []);
    const plan = planVersions(root, 'capture', '9.8.7');
    assert.deepEqual(
      plan.changes.find((change) => change.path.endsWith('Cargo.toml')),
      {
        path: 'apps/cert-prep-desktop/src-tauri/Cargo.toml',
        field: 'dependencies.capture-sidecar-launcher',
        before: CAPTURE_RUNTIME_VERSION,
        after: '9.8.7',
      },
    );
    applyVersionPlan(root, plan);
    assert.match(
      readFileSync(cargo, 'utf8'),
      /^capture-sidecar-launcher = "=9\.8\.7"\r?$/mu,
    );
    assert.deepEqual(planVersions(root, 'capture', '9.8.7').changes, []);
  }));

test('plan, check and apply reject non-exact Cargo requirements without writing', () =>
  fixture(async (root) => {
    const cargo = join(root, 'apps/cert-prep-desktop/src-tauri/Cargo.toml');
    const original = readFileSync(cargo, 'utf8');
    const paths = planVersions(root, 'capture').files.map((file) => file.path);
    for (const requirement of [
      CAPTURE_RUNTIME_VERSION,
      `^${CAPTURE_RUNTIME_VERSION}`,
      `~${CAPTURE_RUNTIME_VERSION}`,
      `>=${CAPTURE_RUNTIME_VERSION}`,
      `${CAPTURE_RUNTIME_VERSION}, <1.0.0`,
      `=${CAPTURE_RUNTIME_VERSION}, <1.0.0`,
      '*',
    ]) {
      writeFileSync(
        cargo,
        original.replace(
          /^capture-sidecar-launcher[^\r\n]*/mu,
          `capture-sidecar-launcher = "${requirement}"`,
        ),
      );
      const before = bytes(root, paths);
      for (const mode of ['plan', 'check', 'apply']) {
        await assert.rejects(
          runVersionCommand([mode, '--version', '9.8.7'], root),
          /requires one owner|Invalid/,
          `${mode} must reject Cargo requirement ${requirement}`,
        );
        assert.deepEqual(bytes(root, paths), before);
      }
    }
  }));

test('missing and duplicate native owners fail before any mutation', () =>
  fixture((root) => {
    const cargo = join(root, 'apps/cert-prep-desktop/src-tauri/Cargo.toml');
    const original = readFileSync(cargo, 'utf8');
    const source = readFileSync(
      join(root, 'tools/capture-runtime-version.json'),
      'utf8',
    );
    writeFileSync(
      cargo,
      original.replace(
        '[dependencies]',
        `[dependencies]\ncapture-sidecar-launcher = "${CAPTURE_RUNTIME_VERSION}"`,
      ),
    );
    assert.throws(
      () => planVersions(root, 'capture', '9.8.7'),
      /requires one owner/,
    );
    assert.equal(
      readFileSync(join(root, 'tools/capture-runtime-version.json'), 'utf8'),
      source,
    );
    writeFileSync(
      cargo,
      original.replace(/^capture-sidecar-launcher.*\r?\n/mu, ''),
    );
    assert.throws(
      () => planVersions(root, 'capture', '9.8.7'),
      /requires one owner/,
    );
    writeFileSync(
      cargo,
      original.replace('[package]', '[package]\nversion = "0.1.0-alpha.1"'),
    );
    assert.throws(
      () => planVersions(root, 'product', '0.2.0-alpha.1'),
      /requires one owner/,
    );
  }));

test('a stale plan fails before writing any owner', () =>
  fixture((root) => {
    const plan = planVersions(root, 'capture', '9.8.7');
    const path = join(root, 'package.json');
    writeFileSync(path, readFileSync(path, 'utf8') + '\n');
    assert.throws(() => applyVersionPlan(root, plan), /changed after planning/);
    assert.equal(
      readCaptureVersion(
        readFileSync(join(root, 'tools/capture-runtime-version.json'), 'utf8'),
      ),
      CAPTURE_RUNTIME_VERSION,
    );
  }));

test('product releases keep Capture adoption independent', () =>
  fixture((root) => {
    const capture = planVersions(root, 'capture')
      .files.map((file) => file.path)
      .filter(
        (path) =>
          !path.endsWith('Cargo.toml') && !path.endsWith('pyproject.toml'),
      );
    const before = bytes(root, capture);
    const plan = planVersions(root, 'product', '0.2.0-alpha.3');
    applyVersionPlan(root, plan);
    assert.deepEqual(bytes(root, capture), before);
    assert.deepEqual(
      planVersions(root, 'product', '0.2.0-alpha.3').changes,
      [],
    );
    assert.deepEqual(planVersions(root, 'capture').changes, []);
    assert.throws(() => planVersions(root, 'product', '0.2.0'), /alpha/);
  }));

test('CLI plan/check are read-only and stale installed SDK is rejected', () =>
  fixture(async (root) => {
    const paths = [...CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS];
    const before = bytes(root, paths);
    const output: string[] = [];
    const log = console.log;
    console.log = (value: unknown) => {
      output.push(String(value));
    };
    try {
      assert.equal(
        await runVersionCommand(['plan', '--version', '9.8.7'], root),
        0,
      );
      assert.equal(
        await runVersionCommand(['check', '--version', '9.8.7'], root),
        1,
      );
      for (const name of ['capture-workbench-ui', 'capture-runtime-client']) {
        const path = join(
          root,
          'node_modules/@gx-capture',
          name,
          'package.json',
        );
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          JSON.stringify({
            version:
              name === 'capture-runtime-client'
                ? '0.0.1'
                : CAPTURE_RUNTIME_VERSION,
          }),
        );
      }
      assert.equal(await runVersionCommand(['check'], root), 1);
      assert.match(
        output.at(-1) ?? '',
        /Installed capture-runtime-client 0.0.1 does not match/,
      );
      await assert.rejects(
        () =>
          runVersionCommand(
            ['apply', '--version', '9.8.7', '--version', '9.8.8'],
            root,
          ),
        /duplicate/,
      );
    } finally {
      console.log = log;
    }
    assert.deepEqual(bytes(root, paths), before);
  }));

test('escaped duplicate JSON names cannot redirect a version owner', () =>
  fixture((root) => {
    assert.throws(
      () =>
        readCaptureVersion(
          String.raw`{"runtimeVersion":"0.4.4","runtime\u0056ersion":"0.4.4"}`,
        ),
      /Duplicate JSON field/,
    );
    const packagePath = join(root, 'package.json');
    const original = readFileSync(packagePath, 'utf8');
    writeFileSync(
      packagePath,
      original.replace(
        '"@gx-capture/capture-workbench-ui":',
        String.raw`"\u0040gx-capture/capture-workbench-ui":"0.4.4", "@gx-capture/capture-workbench-ui":`,
      ),
    );
    assert.throws(
      () => planVersions(root, 'capture', '9.8.7'),
      /Duplicate JSON field/,
    );
    const productPath = join(
      root,
      'apps/cert-prep-desktop/src-tauri/tauri.conf.json',
    );
    writeFileSync(
      productPath,
      readFileSync(productPath, 'utf8').replace(
        '"version":',
        String.raw`"\u0076ersion":"0.1.0-alpha.1", "version":`,
      ),
    );
    assert.throws(
      () => planVersions(root, 'product', '0.2.0-alpha.1'),
      /Duplicate JSON field/,
    );
  }));

test('same literals outside native owner scopes are preserved and cannot replace missing owners', () =>
  fixture((root) => {
    const pythonPath = join(root, 'apps/cert-prep-backend/pyproject.toml');
    const python = readFileSync(pythonPath, 'utf8');
    writeFileSync(
      pythonPath,
      python.replace(
        `  "capture-runtime-client==${CAPTURE_RUNTIME_VERSION}",`,
        '',
      ) +
        `\n[tool.unrelated]\npin = "capture-runtime-client==${CAPTURE_RUNTIME_VERSION}"\n`,
    );
    assert.throws(
      () => planVersions(root, 'capture', '9.8.7'),
      /requires one owner/,
    );
    writeFileSync(pythonPath, python);
    const yamlPath = join(root, 'pnpm-workspace.yaml');
    const yaml = readFileSync(yamlPath, 'utf8');
    writeFileSync(
      yamlPath,
      yaml.replace('minimumReleaseAgeExclude:', 'unrelated:'),
    );
    assert.throws(
      () => planVersions(root, 'capture', '9.8.7'),
      /requires one section/,
    );
    const unrelated = `\nunrelated:\n  - '@gx-capture/capture-workbench-ui@${CAPTURE_RUNTIME_VERSION}'\n`;
    writeFileSync(yamlPath, yaml + unrelated);
    applyVersionPlan(root, planVersions(root, 'capture', '9.8.7'));
    assert.ok(readFileSync(yamlPath, 'utf8').endsWith(unrelated));
  }));

test('apply rejects injected file edits before mutation', () =>
  fixture((root) => {
    const plan = planVersions(root, 'capture', '9.8.7');
    const unrelated = readFileSync(join(root, '.python-version'), 'utf8');
    const injected = {
      ...plan,
      files: [
        ...plan.files,
        { path: '.python-version', before: unrelated, after: '0.0.0' },
      ],
    };
    assert.throws(() => applyVersionPlan(root, injected), /undeclared edits/);
    assert.equal(
      readFileSync(join(root, '.python-version'), 'utf8'),
      unrelated,
    );
    assert.equal(
      readCaptureVersion(
        readFileSync(join(root, 'tools/capture-runtime-version.json'), 'utf8'),
      ),
      CAPTURE_RUNTIME_VERSION,
    );
  }));

test('a partially written file and earlier owners are restored after write failure', () =>
  fixture((root) => {
    const plan = planVersions(root, 'capture', '9.8.7');
    const before = bytes(
      root,
      plan.files.map((file) => file.path),
    );
    let writes = 0;
    assert.throws(
      () =>
        applyVersionPlan(root, plan, (path, value) => {
          writes++;
          if (writes === 2) {
            writeFileSync(path, '{partial');
            throw new Error('injected partial write');
          }
          writeFileSync(path, value);
        }),
      /injected partial write/,
    );
    assert.equal(writes, 4);
    assert.deepEqual(
      bytes(
        root,
        plan.files.map((file) => file.path),
      ),
      before,
    );
  }));

test('rollback attempts every prior owner and reports failed restorations', () =>
  fixture((root) => {
    const plan = planVersions(root, 'capture', '9.8.7');
    let writes = 0;
    assert.throws(
      () =>
        applyVersionPlan(root, plan, (path, value) => {
          writes++;
          if (writes === 2) {
            writeFileSync(path, '{partial');
            throw new Error('injected write');
          }
          if (writes === 3) throw new Error('injected rollback');
          writeFileSync(path, value);
        }),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        String(error.errors[1]).includes('package.json'),
    );
    assert.equal(writes, 4);
    assert.equal(
      readCaptureVersion(
        readFileSync(join(root, 'tools/capture-runtime-version.json'), 'utf8'),
      ),
      CAPTURE_RUNTIME_VERSION,
    );
  }));

test('wheel filenames compare against the explicit current or historical scope', () => {
  assert.equal(
    isCaptureRuntimePythonWheelFileName(
      'capture_runtime_client-9.8.7-py3-none-any.whl',
      '9.8.7',
    ),
    true,
  );
  assert.equal(
    isCaptureRuntimePythonWheelFileName(
      'capture_runtime_client-9x8x7-py3-none-any.whl',
      '9.8.7',
    ),
    false,
  );
  assert.equal(
    isCaptureRuntimePythonWheelFileName(
      'capture_runtime_client-0.4.4-py3-none-any.whl',
      '9.8.7',
    ),
    false,
  );
});

test('installed SDK verification follows the UI dependency and ignores an obsolete unrelated root alias', () =>
  fixture((root) => {
    const uiRoot = join(root, 'node_modules/@gx-capture/capture-workbench-ui');
    const sdkRoot = join(
      uiRoot,
      'node_modules/@gx-capture/capture-runtime-client',
    );
    const staleRoot = join(
      root,
      'node_modules/@gx-capture/capture-runtime-client',
    );
    mkdirSync(join(sdkRoot, 'private/assets'), { recursive: true });
    mkdirSync(staleRoot, { recursive: true });
    writeFileSync(
      join(uiRoot, 'package.json'),
      JSON.stringify({ version: CAPTURE_RUNTIME_VERSION }),
    );
    writeFileSync(
      join(sdkRoot, 'package.json'),
      JSON.stringify({
        version: CAPTURE_RUNTIME_VERSION,
        contractSetSha256: 'a'.repeat(64),
      }),
    );
    writeFileSync(
      join(sdkRoot, 'private/assets/contract-set.json'),
      '{"actual":"UI dependency"}',
    );
    writeFileSync(
      join(staleRoot, 'package.json'),
      JSON.stringify({ version: '0.0.1' }),
    );
    const contract = readInstalledCaptureContract(
      root,
      CAPTURE_RUNTIME_VERSION,
    );
    assert.equal(contract.bytes.toString('utf8'), '{"actual":"UI dependency"}');
    assert.equal(contract.declaredSha256, 'a'.repeat(64));
    writeFileSync(
      join(sdkRoot, 'package.json'),
      JSON.stringify({ version: '0.0.2' }),
    );
    writeFileSync(
      join(staleRoot, 'package.json'),
      JSON.stringify({ version: CAPTURE_RUNTIME_VERSION }),
    );
    assert.throws(
      () => readInstalledCaptureContract(root, CAPTURE_RUNTIME_VERSION),
      /Installed capture-runtime-client 0.0.2/,
    );
  }));
