import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertDownloadedWorkerPathBudget,
  createAcceptanceAppDataDirectory,
  removeAcceptanceAppDataDirectory,
} from './acceptance-app-data.mts';

test('acceptance app-data leases use a canonical direct-child directory', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cert-prep-app-data-'));
  try {
    const directory = createAcceptanceAppDataDirectory(workspace, 'run-123', 'image');
    assert.match(directory, /cp-a[\\/]+run-123-image-[^\\/]+$/u);
    removeAcceptanceAppDataDirectory(workspace, directory);
    assert.throws(() => removeAcceptanceAppDataDirectory(workspace, workspace));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('downloaded worker path preflight rejects a deep loader path', () => {
  const shortDirectory = 'C:\\work\\acceptance-app-data\\run-image-abc123';
  const archive = fakeZip(['_internal/pillow/_imaging.cp312-win_amd64.pyd']);
  assert.doesNotThrow(() =>
    assertDownloadedWorkerPathBudget(shortDirectory, '0.4.1', archive),
  );

  const deepDirectory = `C:\\${'a'.repeat(240)}`;
  assert.throws(
    () => assertDownloadedWorkerPathBudget(deepDirectory, '0.4.1', archive),
    /Windows loader budget/u,
  );
});

function fakeZip(names: readonly string[]): Uint8Array {
  const entries = names.map((name) => {
    const encoded = Buffer.from(name, 'utf8');
    const entry = Buffer.alloc(46 + encoded.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(encoded.length, 28);
    encoded.copy(entry, 46);
    return entry;
  });
  const centralDirectory = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(0, 16);
  return Buffer.concat([centralDirectory, end]);
}
