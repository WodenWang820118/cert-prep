import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PRELOAD_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'canonical-test-temp.mts'),
).href;

test('package QA expands an aliased temp root before loading tests', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'cert-prep-canonical-test-temp-'));
  const canonicalRoot = join(fixtureRoot, 'canonical');
  const aliasRoot = join(fixtureRoot, 'alias');
  const probePath = join(canonicalRoot, 'canonical-temp-probe.test.mts');
  mkdirSync(canonicalRoot);
  writeFileSync(
    probePath,
    [
      "import assert from 'node:assert/strict';",
      "import { tmpdir } from 'node:os';",
      "import test from 'node:test';",
      "test('worker inherits canonical temp root', () => {",
      '  const expected = process.env.CERT_PREP_EXPECTED_CANONICAL_TEST_TEMP;',
      '  assert.equal(process.env.TEMP, expected);',
      '  assert.equal(process.env.TMP, expected);',
      '  assert.equal(process.env.TMPDIR, expected);',
      '  assert.equal(tmpdir(), expected);',
      '});',
    ].join('\n'),
  );
  symlinkSync(
    canonicalRoot,
    aliasRoot,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  t.after(() => {
    unlinkSync(aliasRoot);
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const canonicalPath = realpathSync.native(canonicalRoot);

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      PRELOAD_URL,
      '--test',
      probePath,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEMP: aliasRoot,
        TMP: aliasRoot,
        TMPDIR: aliasRoot,
        CERT_PREP_EXPECTED_CANONICAL_TEST_TEMP: canonicalPath,
      },
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
