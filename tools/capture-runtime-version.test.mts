import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  assertCaptureRuntimeConsumerVersions,
  CAPTURE_RUNTIME_CONSUMER_INVENTORY_FIELDS,
  captureRuntimeConsumerSnapshotFromWorkspace,
  inspectCaptureRuntimeConsumerInventory,
  readCaptureRuntimeConsumerInventory,
  readCaptureRuntimeConsumerInventoryFromSnapshot,
  verifyCaptureRuntimeConsumerSnapshotAgainstWorkspace,
  type CaptureRuntimeContractSource,
  type CaptureRuntimeConsumerInventoryEntry,
} from './capture-runtime-version-check.mts';
import {
  CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS,
  captureRuntimeConsumerSnapshot,
  readCaptureRuntimeConsumerSnapshot,
  type CaptureRuntimeConsumerSnapshotFile,
  type CaptureRuntimeConsumerSource,
} from './capture-runtime-consumer-source.mts';

// The Capture consumer gate sets CAPTURE_CANDIDATE_INSTALL=1 for its own
// checks; these tests opt into candidate mode explicitly where they need it.
delete process.env.CAPTURE_CANDIDATE_INSTALL;

const CONTRACT_FIXTURE = JSON.stringify({
  contractSetVersion: '2',
  schemas: [
    {
      name: 'CaptureOcrProjectionV3',
      schema: {
        properties: {
          apiVersion: { const: '2.0' },
          runtimeVersion: { const: '0.4.2' },
          schemaVersion: { const: '3' },
        },
      },
    },
    {
      name: 'OcrComputePreflightV2',
      schema: {
        properties: {
          apiVersion: { const: '2.0' },
          contractSetVersion: { const: '2' },
          runtimeVersion: { const: '0.4.2' },
          schemaVersion: { const: '1' },
        },
      },
    },
    {
      name: 'RuntimeReady',
      schema: {
        properties: {
          apiVersion: { const: '2.0' },
          captureDocumentSchemaVersion: { const: '2' },
          contractSetVersion: { const: '2' },
          runtimeVersion: { const: '0.4.2' },
        },
      },
    },
  ],
});

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function contractSource(
  bytes = Buffer.from(CONTRACT_FIXTURE, 'utf8'),
): CaptureRuntimeContractSource {
  return {
    source: 'deterministic producer-contract fixture',
    bytes,
    declaredSha256: sha256(bytes),
  };
}

function validEntries(): CaptureRuntimeConsumerInventoryEntry[] {
  return CAPTURE_RUNTIME_CONSUMER_INVENTORY_FIELDS.map((field) => ({
    key: field.key,
    source: `fixture/${field.key}`,
    value:
      field.kind === 'runtimeVersion'
        ? '0.4.2'
        : field.kind === 'apiVersion'
          ? '2.0'
          : field.kind === 'documentSchemaVersion'
            ? '2'
            : field.kind === 'runtimeProvenanceIdentity'
              ? 'runtime=0.4.2;wheel=0.4.2'
              : field.kind === 'runtimeReadyIdentity'
                ? 'api=2.0;document=2;contractSet=2'
                : field.kind === 'preflightIdentity'
                  ? 'runtime=0.4.2;api=2.0;contractSet=2'
                  : 'structural',
  }));
}

function inventoryInput(entries = validEntries(), source = contractSource()) {
  return { entries, contract: source };
}

function withInventoryWorkspace<T>(callback: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-inventory-'));
  try {
    for (const relativePath of CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS) {
      const target = join(workspaceRoot, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(process.cwd(), relativePath), target);
    }
    return callback(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function withDirectoryJunction<T>(
  workspaceRoot: string,
  relativeDirectory: 'apps' | 'tools',
  outsideWorkspace: boolean,
  callback: () => T,
): T {
  const directory = join(workspaceRoot, relativeDirectory);
  const backup = join(workspaceRoot, `${relativeDirectory}-original`);
  const outsideRoot = outsideWorkspace
    ? mkdtempSync(join(tmpdir(), 'cert-consumer-junction-outside-'))
    : undefined;
  const target = outsideRoot ? join(outsideRoot, relativeDirectory) : backup;
  renameSync(directory, backup);
  if (outsideRoot) renameSync(backup, target);
  try {
    symlinkSync(target, directory, 'junction');
    return callback();
  } finally {
    rmSync(directory, { recursive: true, force: true });
    renameSync(target, directory);
    if (outsideRoot) rmSync(outsideRoot, { recursive: true, force: true });
  }
}

function cloneSnapshot<T extends { readonly files: readonly unknown[] }>(
  snapshot: T,
): T {
  return structuredClone(snapshot);
}

function rewriteRuntimeVersion(workspaceRoot: string, version: string): void {
  for (const relativePath of CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS) {
    const path = join(workspaceRoot, relativePath);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replaceAll('0.4.2', version),
    );
  }
}

function mutateLockEntry(
  content: string,
  section: 'packages' | 'snapshots',
  packageName: string,
  version: string,
  operation: 'remove' | 'duplicate',
): string {
  const lines = content.split(/\r?\n/u);
  const sectionStarts = lines.reduce<number[]>((starts, line, index) => {
    if (line === `${section}:`) starts.push(index);
    return starts;
  }, []);
  const sectionStart = sectionStarts.at(-1);
  assert.ok(sectionStart !== undefined);

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (lines[index] === '---' || /^\S.*:$/u.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  const key = `  '${packageName}@${version}':`;
  const entryStart = lines.findIndex(
    (line, index) => index > sectionStart && index < sectionEnd && line === key,
  );
  assert.ok(entryStart >= 0);
  let entryEnd = entryStart + 1;
  while (entryEnd < sectionEnd && !/^  \S/u.test(lines[entryEnd])) {
    entryEnd += 1;
  }

  if (operation === 'remove') {
    lines.splice(entryStart, entryEnd - entryStart);
  } else {
    lines.splice(entryEnd, 0, ...lines.slice(entryStart, entryEnd));
  }
  return lines.join('\n');
}

test('all Cert Prep Capture Runtime consumers use one release version', () => {
  assert.doesNotThrow(() => assertCaptureRuntimeConsumerVersions());
});

test('CI installs the published Capture Workbench packages directly', () => {
  const workflow = readFileSync(
    join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  assert.match(workflow, /pnpm install --frozen-lockfile/u);
  assert.doesNotMatch(workflow, /CAPTURE_PUBLISHED_/u);
  assert.doesNotMatch(workflow, /prepublication-stable-version/u);
});

test('the alpha release workflow is a published consumer with runtime gates', () => {
  const workflow = readFileSync(
    join(
      import.meta.dirname,
      '..',
      '.github',
      'workflows',
      'release-alpha.yml',
    ),
    'utf8',
  );
  assert.doesNotMatch(workflow, /pre-publication Capture Workbench bridge/u);
  assert.match(workflow, /packages:\s*read/u);
  assert.match(workflow, /registry-url:\s*https:\/\/npm\.pkg\.github\.com/u);
  assert.doesNotMatch(workflow, /CAPTURE_REQUIRE_PUBLISHED_CAPTURE_ARTIFACTS/u);
  assert.match(workflow, /cert-prep-desktop:install-capture-runtime/u);
  assert.match(workflow, /cert-prep-desktop:capture-runtime-consumer-smoke/u);
});

test('the complete inventory accepts a producer contract source only after hashing its bytes', () => {
  const report = inspectCaptureRuntimeConsumerInventory(inventoryInput());

  assert.equal(report.status, 'ready');
  assert.deepEqual(report.errors, []);
  assert.equal(report.contractSetSha256, sha256(Buffer.from(CONTRACT_FIXTURE)));
  assert.equal(report.ocrProjectionSchemaVersion, '3');
});

test('the contract parser rejects duplicate required schemas and a wrong identity floor', () => {
  const duplicate = JSON.parse(CONTRACT_FIXTURE) as {
    contractSetVersion: string;
    schemas: Array<Record<string, unknown>>;
  };
  const runtimeReady = duplicate.schemas.find(
    (schema) => schema.name === 'RuntimeReady',
  );
  const projection = duplicate.schemas.find(
    (schema) => schema.name === 'CaptureOcrProjectionV3',
  );
  assert.ok(runtimeReady);
  assert.ok(projection);
  duplicate.schemas.push(
    structuredClone(runtimeReady),
    structuredClone(projection),
  );
  const duplicateReport = inspectCaptureRuntimeConsumerInventory(
    inventoryInput(
      validEntries(),
      contractSource(Buffer.from(JSON.stringify(duplicate))),
    ),
  );
  assert.equal(duplicateReport.status, 'blocked');
  assert.ok(
    duplicateReport.errors.some((error) =>
      error.includes('duplicate RuntimeReady'),
    ),
  );
  assert.ok(
    duplicateReport.errors.some((error) =>
      error.includes('duplicate CaptureOcrProjectionV3'),
    ),
  );

  const wrongFloor = JSON.parse(CONTRACT_FIXTURE) as {
    schemas: Array<Record<string, any>>;
  };
  const ready = wrongFloor.schemas.find(
    (schema) => schema.name === 'RuntimeReady',
  );
  assert.ok(ready);
  ready.schema.properties.apiVersion.const = '9.0';
  const wrongFloorReport = inspectCaptureRuntimeConsumerInventory(
    inventoryInput(
      validEntries(),
      contractSource(Buffer.from(JSON.stringify(wrongFloor))),
    ),
  );
  assert.equal(wrongFloorReport.status, 'blocked');
  assert.ok(
    wrongFloorReport.errors.some((error) =>
      error.includes('API version is incompatible'),
    ),
  );

  const wrongContractSet = JSON.parse(CONTRACT_FIXTURE) as {
    schemas: Array<Record<string, any>>;
  };
  const wrongReady = wrongContractSet.schemas.find(
    (schema) => schema.name === 'RuntimeReady',
  );
  assert.ok(wrongReady);
  wrongReady.schema.properties.contractSetVersion.const = '9';
  const wrongContractSetReport = inspectCaptureRuntimeConsumerInventory(
    inventoryInput(
      validEntries(),
      contractSource(Buffer.from(JSON.stringify(wrongContractSet))),
    ),
  );
  assert.equal(wrongContractSetReport.status, 'blocked');
  assert.ok(
    wrongContractSetReport.errors.some((error) =>
      error.includes('runtime-ready contract-set version is incompatible'),
    ),
  );
});

test('the inventory rejects duplicate and missing consumer owners', () => {
  const entries = validEntries();
  entries.pop();
  entries.push({ ...entries[0] });

  const report = inspectCaptureRuntimeConsumerInventory(
    inventoryInput(entries),
  );

  assert.equal(report.status, 'blocked');
  assert.ok(report.errors.some((error) => error.includes('duplicate')));
  assert.ok(report.errors.some((error) => error.includes('missing')));
});

test('the inventory rejects stale and mixed runtime owners', () => {
  const entries = validEntries();
  entries[0] = { ...entries[0], value: '0.4.1' };
  entries[1] = { ...entries[1], value: '0.4.2' };

  const report = inspectCaptureRuntimeConsumerInventory(
    inventoryInput(entries),
  );

  assert.equal(report.status, 'blocked');
  assert.ok(report.errors.some((error) => error.includes('0.4.1')));
  assert.ok(report.errors.some((error) => error.includes('0.4.2')));
});

test('the inventory rejects a missing projection schema and a corrupted contract digest', () => {
  const corruptedBytes = Buffer.from(
    JSON.stringify({
      schemas: [
        {
          name: 'RuntimeReady',
          schema: {
            properties: {
              apiVersion: { const: '2.0' },
              captureDocumentSchemaVersion: { const: '2' },
              runtimeVersion: { const: '0.4.2' },
            },
          },
        },
      ],
    }),
    'utf8',
  );
  const source = contractSource(corruptedBytes);
  const originalBytes = Buffer.from(source.bytes);
  const report = inspectCaptureRuntimeConsumerInventory(
    inventoryInput(validEntries(), {
      ...source,
      declaredSha256: 'f'.repeat(64),
    }),
  );

  assert.equal(report.status, 'blocked');
  assert.ok(report.errors.some((error) => error.includes('contract-set')));
  assert.ok(
    report.errors.some((error) =>
      error.includes('missing CaptureOcrProjectionV3'),
    ),
  );
  assert.deepEqual(Buffer.from(source.bytes), originalBytes);
});

test('the current installed 0.4.2 owners are ready against the 0.4.2 producer target', () => {
  const input = readCaptureRuntimeConsumerInventory(
    process.cwd(),
    contractSource(),
  );
  assert.equal(
    input.entries.length,
    CAPTURE_RUNTIME_CONSUMER_INVENTORY_FIELDS.length,
  );
  assert.equal(
    input.entries.find((entry) => entry.key === 'cert.lock.workbenchUi')?.value,
    '0.4.2',
  );
  assert.equal(
    input.entries.find((entry) => entry.key === 'cert.backend.uvLock')?.value,
    '0.4.2',
  );
  assert.equal(
    input.entries.find((entry) => entry.key === 'cert.desktop.cargoLock')
      ?.value,
    '0.4.2',
  );
  assert.equal(
    input.entries.find((entry) => entry.key === 'cert.desktop.captureManifest')
      ?.value,
    'structural',
  );
  assert.deepEqual(input.sourceErrors, []);
  const report = inspectCaptureRuntimeConsumerInventory(input);

  assert.equal(report.status, 'ready');
  assert.equal(report.expectedRuntimeVersion, '0.4.2');
  assert.deepEqual(report.errors, []);
});

test('a canonical snapshot reads the same inventory and survives workspace mutation', () => {
  withInventoryWorkspace((workspaceRoot) => {
    const snapshot = captureRuntimeConsumerSnapshotFromWorkspace(
      workspaceRoot,
      'synthetic-consumer-head-1',
    );
    const repeatedSnapshot = captureRuntimeConsumerSnapshotFromWorkspace(
      workspaceRoot,
      'synthetic-consumer-head-1',
    );
    const diskInput = readCaptureRuntimeConsumerInventory(
      workspaceRoot,
      contractSource(),
    );
    const snapshotInput = readCaptureRuntimeConsumerInventoryFromSnapshot(
      snapshot,
      contractSource(),
    );
    const snapshotReport =
      inspectCaptureRuntimeConsumerInventory(snapshotInput);

    assert.equal(
      snapshot.files.length,
      CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS.length,
    );
    assert.equal(CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS.length, 23);
    assert.equal(CAPTURE_RUNTIME_CONSUMER_INVENTORY_FIELDS.length, 29);
    assert.equal(repeatedSnapshot.aggregateSha256, snapshot.aggregateSha256);
    assert.deepEqual(repeatedSnapshot.files, snapshot.files);
    assert.deepEqual(snapshotInput.entries, diskInput.entries);
    assert.deepEqual(snapshotInput.sourceErrors, diskInput.sourceErrors);
    assert.equal(snapshotReport.status, 'ready');
    assert.equal(snapshotReport.expectedRuntimeVersion, '0.4.2');
    assert.deepEqual(snapshotReport.errors, []);

    rewriteRuntimeVersion(workspaceRoot, '0.4.3');
    assert.deepEqual(
      readCaptureRuntimeConsumerInventoryFromSnapshot(
        snapshot,
        contractSource(),
      ).entries,
      snapshotInput.entries,
    );
    assert.throws(
      () =>
        verifyCaptureRuntimeConsumerSnapshotAgainstWorkspace(
          snapshot,
          workspaceRoot,
          'synthetic-consumer-head-1',
        ),
      /source drifted/u,
    );
    assert.throws(
      () =>
        verifyCaptureRuntimeConsumerSnapshotAgainstWorkspace(
          snapshot,
          workspaceRoot,
          'synthetic-consumer-head-2',
        ),
      /sourceHead is stale/u,
    );

    rmSync(join(workspaceRoot, 'package.json'));
    assert.deepEqual(
      readCaptureRuntimeConsumerInventoryFromSnapshot(
        snapshot,
        contractSource(),
      ).entries,
      snapshotInput.entries,
    );
    assert.throws(
      () =>
        verifyCaptureRuntimeConsumerSnapshotAgainstWorkspace(
          snapshot,
          workspaceRoot,
          'synthetic-consumer-head-1',
        ),
      /package\.json is missing/u,
    );
  });
});

test('a consistent synthetic 0.4.2 workspace has identical disk and snapshot reports', () => {
  withInventoryWorkspace((workspaceRoot) => {
    rewriteRuntimeVersion(workspaceRoot, '0.4.2');
    const snapshot = captureRuntimeConsumerSnapshotFromWorkspace(
      workspaceRoot,
      'synthetic-consumer-head-2',
    );
    const diskReport = inspectCaptureRuntimeConsumerInventory(
      readCaptureRuntimeConsumerInventory(workspaceRoot, contractSource()),
    );
    const snapshotReport = inspectCaptureRuntimeConsumerInventory(
      readCaptureRuntimeConsumerInventoryFromSnapshot(
        snapshot,
        contractSource(),
      ),
    );

    assert.equal(diskReport.status, 'ready');
    assert.deepEqual(snapshotReport, diskReport);

    const packagePath = join(workspaceRoot, 'package.json');
    writeFileSync(packagePath, `${readFileSync(packagePath, 'utf8')}\n`);
    assert.throws(
      () =>
        verifyCaptureRuntimeConsumerSnapshotAgainstWorkspace(
          snapshot,
          workspaceRoot,
          'synthetic-consumer-head-2',
        ),
      /source drifted at package\.json/u,
    );
  });
});

test('snapshot validation rejects missing, extra, duplicate, traversal, byte, and digest tampering', () => {
  withInventoryWorkspace((workspaceRoot) => {
    const snapshot = captureRuntimeConsumerSnapshotFromWorkspace(
      workspaceRoot,
      'synthetic-consumer-head-3',
    );
    const missing = cloneSnapshot(snapshot) as typeof snapshot;
    (missing.files as CaptureRuntimeConsumerSnapshotFile[]).pop();
    assert.throws(
      () => readCaptureRuntimeConsumerSnapshot(missing),
      /exactly .* files/u,
    );

    const extra = cloneSnapshot(snapshot) as typeof snapshot;
    (extra.files as CaptureRuntimeConsumerSnapshotFile[]).push(
      structuredClone(extra.files[0]),
    );
    assert.throws(
      () => readCaptureRuntimeConsumerSnapshot(extra),
      /exactly .* files/u,
    );

    const duplicate = cloneSnapshot(snapshot) as typeof snapshot;
    (duplicate.files as CaptureRuntimeConsumerSnapshotFile[])[1] =
      structuredClone(duplicate.files[0]);
    assert.throws(
      () => readCaptureRuntimeConsumerSnapshot(duplicate),
      /canonical at index 1/u,
    );

    const traversal = cloneSnapshot(snapshot) as typeof snapshot;
    (traversal.files as Array<{ path: string }>)[0].path = '../package.json';
    assert.throws(
      () => readCaptureRuntimeConsumerSnapshot(traversal),
      /outside the canonical registry/u,
    );

    const bytes = cloneSnapshot(snapshot) as typeof snapshot;
    (bytes.files[0].bytes as Uint8Array)[0] ^= 1;
    assert.throws(
      () => readCaptureRuntimeConsumerSnapshot(bytes),
      /bytes do not match/u,
    );

    const digest = cloneSnapshot(snapshot) as typeof snapshot;
    (digest as { aggregateSha256: string }).aggregateSha256 = '0'.repeat(64);
    assert.throws(
      () => readCaptureRuntimeConsumerSnapshot(digest),
      /aggregate SHA-256/u,
    );
  });
});

test('snapshot capture rejects symlink, missing, and non-file source owners', () => {
  withInventoryWorkspace((workspaceRoot) => {
    const baseline = captureRuntimeConsumerSnapshotFromWorkspace(
      workspaceRoot,
      'synthetic-consumer-head-4',
    );
    const baselineSource = readCaptureRuntimeConsumerSnapshot(baseline);
    const alteredSource = (
      kind: 'symlink' | 'missing' | 'other',
    ): CaptureRuntimeConsumerSource => ({
      readFile(path) {
        if (path === CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS[0]) {
          return { kind };
        }
        return baselineSource.readFile(path);
      },
    });

    for (const kind of ['symlink', 'missing', 'other'] as const) {
      assert.throws(
        () =>
          captureRuntimeConsumerSnapshot(
            alteredSource(kind),
            'synthetic-consumer-head-4',
          ),
        new RegExp(`${kind}.*regular file`, 'u'),
      );
    }
  });
});

test('disk source rejects parent junctions before reading ordinary child files', (testContext) => {
  withInventoryWorkspace((workspaceRoot) => {
    for (const relativeDirectory of ['apps', 'tools'] as const) {
      for (const outsideWorkspace of [false, true]) {
        try {
          withDirectoryJunction(
            workspaceRoot,
            relativeDirectory,
            outsideWorkspace,
            () =>
              assert.throws(
                () =>
                  captureRuntimeConsumerSnapshotFromWorkspace(
                    workspaceRoot,
                    `junction-${relativeDirectory}-${outsideWorkspace}`,
                  ),
                new RegExp(`${relativeDirectory}.*symlink.*regular file`, 'u'),
              ),
          );
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            (error.code === 'EPERM' || error.code === 'EACCES')
          ) {
            testContext.skip(
              `junction creation unavailable: ${String(error.code)}`,
            );
            return;
          }
          throw error;
        }
      }
    }
  });
});

test('the canonical source registry cannot be mutated at runtime', () => {
  const original = [...CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS];
  const mutableView =
    CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS as unknown as string[];
  assert.throws(() => mutableView.push('unexpected.ts'), TypeError);
  assert.throws(() => mutableView.sort(), TypeError);
  assert.throws(() => {
    mutableView[0] = 'unexpected.ts';
  }, TypeError);
  assert.deepEqual([...CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS], original);
});

test('snapshot capture copies source bytes and rejects mutation of its own bytes', () => {
  withInventoryWorkspace((workspaceRoot) => {
    const original = captureRuntimeConsumerSnapshotFromWorkspace(
      workspaceRoot,
      'synthetic-consumer-head-5',
    );
    const bytesByPath = new Map(
      original.files.map((file) => [file.path, Uint8Array.from(file.bytes)]),
    );
    const mutableSource: CaptureRuntimeConsumerSource = {
      readFile(path) {
        return { kind: 'file', bytes: bytesByPath.get(path) };
      },
    };
    const captured = captureRuntimeConsumerSnapshot(
      mutableSource,
      'synthetic-consumer-head-5',
    );
    const mutablePackageBytes = bytesByPath.get(
      CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS[0],
    );
    assert.ok(mutablePackageBytes);
    mutablePackageBytes[0] ^= 1;
    assert.equal(sha256(captured.files[0].bytes), original.files[0].sha256);

    (captured.files[0].bytes as Uint8Array)[0] ^= 1;
    assert.throws(
      () => readCaptureRuntimeConsumerSnapshot(captured),
      /bytes do not match/u,
    );
  });
});

test('the lock reader separates package and snapshot ownership', () => {
  withInventoryWorkspace((workspaceRoot) => {
    const lockPath = join(workspaceRoot, 'pnpm-lock.yaml');
    const original = readFileSync(lockPath, 'utf8').replaceAll(
      '@gx-capture/capture-runtime-client@0.4.1',
      '@gx-capture/capture-runtime-client@0.4.2',
    );
    writeFileSync(
      lockPath,
      mutateLockEntry(
        mutateLockEntry(
          original,
          'packages',
          '@gx-capture/capture-runtime-client',
          '0.4.2',
          'duplicate',
        ),
        'snapshots',
        '@gx-capture/capture-runtime-client',
        '0.4.2',
        'remove',
      ),
    );

    const input = readCaptureRuntimeConsumerInventory(
      workspaceRoot,
      contractSource(),
    );
    assert.ok(
      input.sourceErrors?.some((error) =>
        error.includes('packages section; found 2'),
      ),
    );
    assert.ok(
      input.sourceErrors?.some((error) =>
        error.includes('snapshots section; found 0'),
      ),
    );
    assert.equal(
      inspectCaptureRuntimeConsumerInventory(input).status,
      'blocked',
    );
  });

  withInventoryWorkspace((workspaceRoot) => {
    const lockPath = join(workspaceRoot, 'pnpm-lock.yaml');
    const original = readFileSync(lockPath, 'utf8').replaceAll(
      '@gx-capture/capture-runtime-client@0.4.1',
      '@gx-capture/capture-runtime-client@0.4.2',
    );
    writeFileSync(
      lockPath,
      mutateLockEntry(
        mutateLockEntry(
          original,
          'packages',
          '@gx-capture/capture-runtime-client',
          '0.4.2',
          'remove',
        ),
        'snapshots',
        '@gx-capture/capture-runtime-client',
        '0.4.2',
        'duplicate',
      ),
    );

    const input = readCaptureRuntimeConsumerInventory(
      workspaceRoot,
      contractSource(),
    );
    assert.ok(
      input.sourceErrors?.some((error) =>
        error.includes('packages section; found 0'),
      ),
    );
    assert.ok(
      input.sourceErrors?.some((error) =>
        error.includes('snapshots section; found 2'),
      ),
    );
    assert.equal(
      inspectCaptureRuntimeConsumerInventory(input).status,
      'blocked',
    );
  });
});

test('the lock reader rejects duplicate sections and ignores unrelated blocks', () => {
  withInventoryWorkspace((workspaceRoot) => {
    const lockPath = join(workspaceRoot, 'pnpm-lock.yaml');
    writeFileSync(
      lockPath,
      `${readFileSync(lockPath, 'utf8')}\npackages:\nsnapshots:\n`,
    );
    const input = readCaptureRuntimeConsumerInventory(
      workspaceRoot,
      contractSource(),
    );
    assert.ok(
      input.sourceErrors?.some((error) =>
        error.includes('packages section in the owning lock document; found 2'),
      ),
    );
    assert.ok(
      input.sourceErrors?.some((error) =>
        error.includes(
          'snapshots section in the owning lock document; found 2',
        ),
      ),
    );
  });

  withInventoryWorkspace((workspaceRoot) => {
    const lockPath = join(workspaceRoot, 'pnpm-lock.yaml');
    const lockWithoutPackage = mutateLockEntry(
      readFileSync(lockPath, 'utf8'),
      'packages',
      '@gx-capture/capture-runtime-client',
      '0.4.2',
      'remove',
    );
    writeFileSync(
      lockPath,
      `${lockWithoutPackage}\nforeign:\n  '@gx-capture/capture-runtime-client@0.4.2': {}\n`,
    );
    const input = readCaptureRuntimeConsumerInventory(
      workspaceRoot,
      contractSource(),
    );
    assert.ok(
      input.sourceErrors?.some((error) =>
        error.includes(
          'must have exactly one declaration in the packages section; found 0',
        ),
      ),
    );
    assert.equal(
      inspectCaptureRuntimeConsumerInventory(input).status,
      'blocked',
    );
  });
});

test('the reader rejects duplicate or mixed package and lock source owners', () => {
  withInventoryWorkspace((workspaceRoot) => {
    const lockPath = join(workspaceRoot, 'pnpm-lock.yaml');
    writeFileSync(
      lockPath,
      `${readFileSync(lockPath, 'utf8')}\n  '@gx-capture/capture-runtime-client@0.4.2':\n    resolution: {}\n`,
    );
    assert.doesNotThrow(() =>
      assertCaptureRuntimeConsumerVersions(workspaceRoot),
    );
    const input = readCaptureRuntimeConsumerInventory(
      workspaceRoot,
      contractSource(),
    );
    const report = inspectCaptureRuntimeConsumerInventory(input);
    assert.equal(report.status, 'blocked');
    assert.ok(
      report.errors.some((error) =>
        error.includes(
          'pnpm-lock.yaml:@gx-capture/capture-runtime-client must have exactly one declaration in the snapshots section; found 2',
        ),
      ),
    );
  });

  withInventoryWorkspace((workspaceRoot) => {
    const uvPath = join(workspaceRoot, 'apps/cert-prep-backend/uv.lock');
    writeFileSync(
      uvPath,
      `${readFileSync(uvPath, 'utf8')}\n[[package]]\nname = "capture-runtime-client"\nversion = "0.4.2"\n`,
    );
    assert.doesNotThrow(() =>
      assertCaptureRuntimeConsumerVersions(workspaceRoot),
    );
    const report = inspectCaptureRuntimeConsumerInventory(
      readCaptureRuntimeConsumerInventory(workspaceRoot, contractSource()),
    );
    assert.equal(report.status, 'blocked');
    assert.ok(
      report.errors.some((error) =>
        error.includes(
          'uv.lock must contain exactly one capture-runtime-client package block',
        ),
      ),
    );
  });

  withInventoryWorkspace((workspaceRoot) => {
    const cargoPath = join(
      workspaceRoot,
      'apps/cert-prep-desktop/src-tauri/Cargo.lock',
    );
    writeFileSync(
      cargoPath,
      `${readFileSync(cargoPath, 'utf8')}\n[[package]]\nname = "capture-sidecar-launcher"\nversion = "0.4.2"\n`,
    );
    assert.doesNotThrow(() =>
      assertCaptureRuntimeConsumerVersions(workspaceRoot),
    );
    const report = inspectCaptureRuntimeConsumerInventory(
      readCaptureRuntimeConsumerInventory(workspaceRoot, contractSource()),
    );
    assert.equal(report.status, 'blocked');
    assert.ok(
      report.errors.some((error) =>
        error.includes(
          'Cargo.lock must contain exactly one capture-sidecar-launcher package block',
        ),
      ),
    );
  });
});

test('the reader validates generated identity and backend launch forwarding from workspace source', () => {
  withInventoryWorkspace((workspaceRoot) => {
    const generatedPath = join(
      workspaceRoot,
      'libs/cert-prep-api/src/lib/cert-prep-api.generated.ts',
    );
    const generated = readFileSync(generatedPath, 'utf8');
    writeFileSync(
      generatedPath,
      generated.replace(
        /(RuntimeReady:\s*\{[\s\S]*?"apiVersion":\s*)"2\.0"/u,
        '$1"9.0"',
      ),
    );
    assert.doesNotThrow(() =>
      assertCaptureRuntimeConsumerVersions(workspaceRoot),
    );
    const report = inspectCaptureRuntimeConsumerInventory(
      readCaptureRuntimeConsumerInventory(workspaceRoot, contractSource()),
    );
    assert.equal(report.status, 'blocked');
    assert.ok(
      report.errors.some((error) =>
        error.includes('generated.ts:RuntimeReady is stale or mixed'),
      ),
    );
  });

  withInventoryWorkspace((workspaceRoot) => {
    const constantsPath = join(
      workspaceRoot,
      'apps/cert-prep-desktop/src-tauri/src/constants.rs',
    );
    const constants = readFileSync(constantsPath, 'utf8');
    writeFileSync(
      constantsPath,
      constants.replace(
        'CAPTURE_RUNTIME_API_VERSION: &str = "2.0"',
        'CAPTURE_RUNTIME_API_VERSION: &str = "9.0"',
      ),
    );
    assert.doesNotThrow(() =>
      assertCaptureRuntimeConsumerVersions(workspaceRoot),
    );
    const report = inspectCaptureRuntimeConsumerInventory(
      readCaptureRuntimeConsumerInventory(workspaceRoot, contractSource()),
    );
    assert.equal(report.status, 'blocked');
    assert.ok(
      report.errors.some((error) =>
        error.includes(
          'constants.rs:CAPTURE_RUNTIME_API_VERSION is stale or mixed',
        ),
      ),
    );
  });

  withInventoryWorkspace((workspaceRoot) => {
    const launchPath = join(
      workspaceRoot,
      'apps/cert-prep-desktop/src-tauri/src/backend_process.rs',
    );
    const launch = readFileSync(launchPath, 'utf8');
    writeFileSync(
      launchPath,
      launch.replace(
        'capture_runtime.api_version.clone()',
        'capture_runtime.runtime_version.clone()',
      ),
    );
    assert.doesNotThrow(() =>
      assertCaptureRuntimeConsumerVersions(workspaceRoot),
    );
    const report = inspectCaptureRuntimeConsumerInventory(
      readCaptureRuntimeConsumerInventory(workspaceRoot, contractSource()),
    );
    assert.equal(report.status, 'blocked');
    assert.ok(
      report.errors.some((error) =>
        error.includes('missing inventory owner cert.desktop.backendLaunchEnv'),
      ),
    );
  });
});

test('candidate mode fails closed when its producer identity source is missing', () => {
  const previous = process.env.CAPTURE_CANDIDATE_INSTALL;
  process.env.CAPTURE_CANDIDATE_INSTALL = '1';
  try {
    assert.throws(
      () => assertCaptureRuntimeConsumerVersions(),
      /requires a producer contract identity source/u,
    );
  } finally {
    if (previous === undefined) delete process.env.CAPTURE_CANDIDATE_INSTALL;
    else process.env.CAPTURE_CANDIDATE_INSTALL = previous;
  }
});
