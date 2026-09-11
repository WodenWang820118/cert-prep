import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  assertCaptureRuntimeConsumerVersions,
  CAPTURE_RUNTIME_CONSUMER_INVENTORY_FIELDS,
  inspectCaptureRuntimeConsumerInventory,
  readCaptureRuntimeConsumerInventory,
  type CaptureRuntimeContractSource,
  type CaptureRuntimeConsumerInventoryEntry,
} from './capture-runtime-version-check.mts';

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

const INVENTORY_SOURCE_PATHS = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tools/capture-runtime-version.mts',
  'apps/cert-prep-backend/pyproject.toml',
  'apps/cert-prep-backend/uv.lock',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_policy.py',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/client.py',
  'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_provenance.py',
  'apps/cert-prep-desktop/src-tauri/src/constants.rs',
  'apps/cert-prep-desktop/src-tauri/Cargo.toml',
  'apps/cert-prep-desktop/src-tauri/Cargo.lock',
  'apps/cert-prep-desktop/project.json',
  'apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs',
  'apps/cert-prep-desktop/src-tauri/src/manifests.rs',
  'apps/cert-prep-desktop/src-tauri/src/backend_process.rs',
  'apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs',
  'apps/cert-prep-desktop/scripts/package-qa/constants.mts',
  'tools/install-capture-runtime.mts',
  'tools/capture-runtime-consumer-smoke.mts',
  'apps/cert-prep/src/app/pages/capture-workbench-trial/cert-prep-capture-client.ts',
  'libs/cert-prep-api/src/lib/cert-prep-api.generated.ts',
] as const;

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
                  ? 'api=2.0;contractSet=2'
                  : 'structural',
  }));
}

function inventoryInput(entries = validEntries(), source = contractSource()) {
  return { entries, contract: source };
}

function withInventoryWorkspace<T>(callback: (workspaceRoot: string) => T): T {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cert-inventory-'));
  try {
    for (const relativePath of INVENTORY_SOURCE_PATHS) {
      const target = join(workspaceRoot, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(process.cwd(), relativePath), target);
    }
    return callback(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
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

test('the current installed 0.4.1 owners are reported blocked against the 0.4.2 producer target', () => {
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
    '0.4.1',
  );
  assert.equal(
    input.entries.find((entry) => entry.key === 'cert.backend.uvLock')?.value,
    '0.4.1',
  );
  assert.equal(
    input.entries.find((entry) => entry.key === 'cert.desktop.cargoLock')
      ?.value,
    '0.4.1',
  );
  assert.equal(
    input.entries.find((entry) => entry.key === 'cert.desktop.captureManifest')
      ?.value,
    'structural',
  );
  assert.deepEqual(input.sourceErrors, []);
  const report = inspectCaptureRuntimeConsumerInventory(input);

  assert.equal(report.status, 'blocked');
  assert.equal(report.expectedRuntimeVersion, '0.4.2');
  assert.doesNotMatch(report.errors.join('\n'), /missing inventory owner/u);
  assert.ok(report.errors.some((error) => error.includes('0.4.1')));
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
      '0.4.1',
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
