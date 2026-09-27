import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectCaptureRuntimePythonWheel } from './capture-runtime-python-wheel.mts';

const CONTRACT_BYTES = Buffer.from('{"contract":"phase1"}', 'utf8');
const CONTRACT_SHA256 = createHash('sha256').update(CONTRACT_BYTES).digest('hex');
const EXPECTED = {
  runtimeVersion: '0.4.2',
  contractSetSha256: CONTRACT_SHA256,
};

test('Python wheel provenance re-hashes the wheel and requires Phase 1 generated fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cert-python-wheel-'));
  try {
    const wheelPath = join(root, 'capture_runtime_client-0.4.2-py3-none-any.whl');
    const wheel = createWheel({
      'capture_runtime_client/private/generated_models.py':
        Buffer.from(
          'class OcrComputePreflightV2:\n    pass\n\nclass OcrComputePreflightV2(BaseModel):\n    worker_sha256: str | None\n    pdf_page_numbers: list[int] | None\n',
        ),
      'capture_runtime_client/private/assets/contract-set.json': CONTRACT_BYTES,
      'capture_runtime_client/private/assets/contract-set.sha256': Buffer.from(`${CONTRACT_SHA256}\n`),
      'capture_runtime_client-0.4.2.dist-info/METADATA': Buffer.from(
        'Metadata-Version: 2.5\nName: capture-runtime-client\nVersion: 0.4.2\n',
      ),
    });
    await writeFile(wheelPath, wheel);

    const result = await inspectCaptureRuntimePythonWheel(wheelPath, EXPECTED);

    assert.deepEqual(result, {
      fileName: 'capture_runtime_client-0.4.2-py3-none-any.whl',
      sha256: createHash('sha256').update(wheel).digest('hex'),
      bytes: wheel.length,
      packageName: 'capture-runtime-client',
      packageVersion: '0.4.2',
      contractSetSha256: CONTRACT_SHA256,
      generatedModels: { workerSha256: true, pdfPageNumbers: true },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Python wheel provenance rejects a stale 0.4.2 wheel without worker identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cert-python-wheel-stale-'));
  try {
    const wheelPath = join(root, 'capture_runtime_client-0.4.2-py3-none-any.whl');
    await writeFile(
      wheelPath,
      createWheel({
        'capture_runtime_client/private/generated_models.py':
          Buffer.from(
            'class OcrComputePreflightV2(BaseModel):\n    pdf_page_numbers: list[int] | None\n',
          ),
        'capture_runtime_client/private/assets/contract-set.json': CONTRACT_BYTES,
        'capture_runtime_client/private/assets/contract-set.sha256': Buffer.from(`${CONTRACT_SHA256}\n`),
        'capture_runtime_client-0.4.2.dist-info/METADATA': Buffer.from(
          'Name: capture-runtime-client\nVersion: 0.4.2\n',
        ),
      }),
    );

    await assert.rejects(
      inspectCaptureRuntimePythonWheel(wheelPath, EXPECTED),
      /generated models omitted worker_sha256/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Python wheel provenance rejects an embedded contract identity drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cert-python-wheel-contract-'));
  try {
    const wheelPath = join(root, 'capture_runtime_client-0.4.2-py3-none-any.whl');
    const changedContract = Buffer.from('{"contract":"different"}', 'utf8');
    const changedDigest = createHash('sha256').update(changedContract).digest('hex');
    await writeFile(
      wheelPath,
      createWheel({
        'capture_runtime_client/private/generated_models.py':
          Buffer.from(
            'class OcrComputePreflightV2(BaseModel):\n    worker_sha256: str | None\n    pdf_page_numbers: list[int] | None\n',
          ),
        'capture_runtime_client/private/assets/contract-set.json': changedContract,
        'capture_runtime_client/private/assets/contract-set.sha256': Buffer.from(`${changedDigest}\n`),
        'capture_runtime_client-0.4.2.dist-info/METADATA': Buffer.from(
          'Name: capture-runtime-client\nVersion: 0.4.2\n',
        ),
      }),
    );

    await assert.rejects(
      inspectCaptureRuntimePythonWheel(wheelPath, EXPECTED),
      /embedded contract set does not match/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createWheel(entries: Record<string, Uint8Array>): Buffer {
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;
  for (const [name, payload] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(payload);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    localEntries.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralEntries.push(central);
    offset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralEntries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centralEntries.length, 8);
  end.writeUInt16LE(centralEntries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localEntries, centralDirectory, end]);
}
