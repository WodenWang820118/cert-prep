import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const WHEEL_NAME_PATTERN = /^capture[_-]runtime[_-]client-(?<version>[^-]+)-.+\.whl$/u;
const GENERATED_MODELS_PATH = 'capture_runtime_client/private/generated_models.py';
const CONTRACT_PATH = 'capture_runtime_client/private/assets/contract-set.json';
const CONTRACT_DIGEST_PATH = 'capture_runtime_client/private/assets/contract-set.sha256';

export const CAPTURE_RUNTIME_PYTHON_WHEEL_ENV =
  'CERT_PREP_CAPTURE_RUNTIME_PYTHON_WHEEL';

export interface CaptureRuntimePythonWheelProvenance {
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly packageName: 'capture-runtime-client';
  readonly packageVersion: string;
  readonly contractSetSha256: string;
  readonly generatedModels: {
    readonly workerSha256: true;
    readonly pdfPageNumbers: true;
  };
}

export interface CaptureRuntimePythonWheelExpectation {
  readonly runtimeVersion: string;
  readonly contractSetSha256: string;
}

interface WheelEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly localHeaderOffset: number;
}

/**
 * Re-hashes and inspects the exact Python wheel used by a local-probe
 * acceptance setup. The wheel is deliberately inspected without importing the
 * ambient virtual environment: a stale wheel can otherwise retain a valid
 * 0.4.2 version while omitting the generated fields needed by Phase 1.
 */
export async function inspectCaptureRuntimePythonWheel(
  wheelPath: string,
  expected: CaptureRuntimePythonWheelExpectation,
): Promise<CaptureRuntimePythonWheelProvenance> {
  const resolvedPath = resolve(wheelPath);
  const metadata = await stat(resolvedPath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size === 0) {
    throw new Error(
      `Capture Runtime local-probe requires a non-empty Python wheel: ${resolvedPath}.`,
    );
  }
  const fileName = basename(resolvedPath);
  const wheelName = WHEEL_NAME_PATTERN.exec(fileName);
  if (!wheelName || wheelName.groups?.version !== expected.runtimeVersion) {
    throw new Error(
      `Capture Runtime Python wheel must be capture-runtime-client ${expected.runtimeVersion}: ${resolvedPath}.`,
    );
  }
  if (!SHA256_PATTERN.test(expected.contractSetSha256)) {
    throw new Error('Capture Runtime Python wheel contract expectation is invalid.');
  }

  const wheelBytes = await readFile(resolvedPath);
  if (wheelBytes.length !== metadata.size) {
    throw new Error(
      `Capture Runtime Python wheel changed while it was being read: ${resolvedPath}.`,
    );
  }
  const entries = parseWheelEntries(wheelBytes, resolvedPath);
  const metadataEntry = findUniqueEntry(entries, (name) =>
    name.endsWith('.dist-info/METADATA'),
  );
  const packageMetadata = decodeUtf8(
    extractWheelEntry(wheelBytes, metadataEntry, resolvedPath),
    `${resolvedPath} METADATA`,
  );
  const packageName = metadataField(packageMetadata, 'Name');
  const packageVersion = metadataField(packageMetadata, 'Version');
  if (packageName !== 'capture-runtime-client') {
    throw new Error(
      `Capture Runtime Python wheel package name must be capture-runtime-client, found ${packageName}.`,
    );
  }
  if (packageVersion !== expected.runtimeVersion) {
    throw new Error(
      `Capture Runtime Python wheel version must be ${expected.runtimeVersion}, found ${packageVersion}.`,
    );
  }

  const generatedModelsEntry = requiredEntry(entries, GENERATED_MODELS_PATH);
  const generatedModels = decodeUtf8(
    extractWheelEntry(wheelBytes, generatedModelsEntry, resolvedPath),
    `${resolvedPath} generated models`,
  );
  if (!/^\s*class\s+OcrComputePreflightV2\s*\(/mu.test(generatedModels)) {
    throw new Error(
      'Capture Runtime Python wheel generated models omitted OcrComputePreflightV2.',
    );
  }
  if (!/^\s*worker_sha256\s*:/mu.test(generatedModels)) {
    throw new Error(
      'Capture Runtime Python wheel generated models omitted worker_sha256.',
    );
  }
  if (!/^\s*pdf_page_numbers\s*:/mu.test(generatedModels)) {
    throw new Error(
      'Capture Runtime Python wheel generated models omitted pdf_page_numbers.',
    );
  }

  const contractBytes = extractWheelEntry(
    wheelBytes,
    requiredEntry(entries, CONTRACT_PATH),
    resolvedPath,
  );
  const contractSetSha256 = sha256(contractBytes);
  const declaredContractSetSha256 = decodeUtf8(
    extractWheelEntry(
      wheelBytes,
      requiredEntry(entries, CONTRACT_DIGEST_PATH),
      resolvedPath,
    ),
    `${resolvedPath} contract-set.sha256`,
  ).trim();
  if (
    !SHA256_PATTERN.test(declaredContractSetSha256) ||
    declaredContractSetSha256 !== contractSetSha256
  ) {
    throw new Error(
      'Capture Runtime Python wheel contract-set digest does not match its embedded contract bytes.',
    );
  }
  if (contractSetSha256 !== expected.contractSetSha256) {
    throw new Error(
      'Capture Runtime Python wheel embedded contract set does not match the Phase 1 final identity.',
    );
  }

  return {
    fileName,
    sha256: sha256(wheelBytes),
    bytes: wheelBytes.length,
    packageName: 'capture-runtime-client',
    packageVersion,
    contractSetSha256,
    generatedModels: {
      workerSha256: true,
      pdfPageNumbers: true,
    },
  };
}

function parseWheelEntries(bytes: Buffer, wheelPath: string): readonly WheelEntry[] {
  const endOfCentralDirectory = findEndOfCentralDirectory(bytes);
  if (endOfCentralDirectory < 0) {
    throw new Error(`Capture Runtime Python wheel is not a valid ZIP archive: ${wheelPath}.`);
  }
  const diskNumber = bytes.readUInt16LE(endOfCentralDirectory + 4);
  const centralDirectoryDisk = bytes.readUInt16LE(endOfCentralDirectory + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOfCentralDirectory + 8);
  const entriesTotal = bytes.readUInt16LE(endOfCentralDirectory + 10);
  const centralDirectoryBytes = bytes.readUInt32LE(endOfCentralDirectory + 12);
  const centralDirectoryOffset = bytes.readUInt32LE(endOfCentralDirectory + 16);
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entriesTotal ||
    entriesTotal === 0xffff ||
    centralDirectoryBytes === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error(`Capture Runtime Python wheel ZIP64 or multi-disk archives are unsupported: ${wheelPath}.`);
  }
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectoryBytes;
  if (
    centralDirectoryOffset > bytes.length ||
    centralDirectoryEnd > bytes.length ||
    centralDirectoryEnd < centralDirectoryOffset
  ) {
    throw new Error(`Capture Runtime Python wheel central directory is out of bounds: ${wheelPath}.`);
  }
  const entries: WheelEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entriesTotal; index += 1) {
    if (offset + 46 > centralDirectoryEnd || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Capture Runtime Python wheel central directory is malformed: ${wheelPath}.`);
    }
    const nameBytes = bytes.readUInt16LE(offset + 28);
    const extraBytes = bytes.readUInt16LE(offset + 30);
    const commentBytes = bytes.readUInt16LE(offset + 32);
    const entryEnd = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (entryEnd > centralDirectoryEnd || entryEnd > bytes.length) {
      throw new Error(`Capture Runtime Python wheel central directory entry is out of bounds: ${wheelPath}.`);
    }
    const name = decodeUtf8(
      bytes.subarray(offset + 46, offset + 46 + nameBytes),
      `${wheelPath} entry name`,
    );
    if (entries.some((entry) => entry.name === name)) {
      throw new Error(`Capture Runtime Python wheel contains duplicate entry: ${name}.`);
    }
    entries.push({
      name,
      compressionMethod: bytes.readUInt16LE(offset + 10),
      compressedBytes: bytes.readUInt32LE(offset + 20),
      uncompressedBytes: bytes.readUInt32LE(offset + 24),
      localHeaderOffset: bytes.readUInt32LE(offset + 42),
    });
    offset = entryEnd;
  }
  if (offset !== centralDirectoryEnd) {
    throw new Error(`Capture Runtime Python wheel central directory size is invalid: ${wheelPath}.`);
  }
  return entries;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  if (bytes.length < 22) return -1;
  const firstOffset = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= firstOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentBytes = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentBytes === bytes.length) return offset;
  }
  return -1;
}

function findUniqueEntry(
  entries: readonly WheelEntry[],
  predicate: (name: string) => boolean,
): WheelEntry {
  const matches = entries.filter((entry) => predicate(entry.name));
  if (matches.length !== 1) {
    throw new Error('Capture Runtime Python wheel must contain exactly one package METADATA entry.');
  }
  const [entry] = matches;
  if (!entry) throw new Error('Capture Runtime Python wheel METADATA entry was missing.');
  return entry;
}

function requiredEntry(entries: readonly WheelEntry[], name: string): WheelEntry {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Capture Runtime Python wheel omitted ${name}.`);
  return entry;
}

function extractWheelEntry(bytes: Buffer, entry: WheelEntry, wheelPath: string): Buffer {
  const localOffset = entry.localHeaderOffset;
  if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error(`Capture Runtime Python wheel local entry is malformed: ${entry.name}.`);
  }
  const nameBytes = bytes.readUInt16LE(localOffset + 26);
  const extraBytes = bytes.readUInt16LE(localOffset + 28);
  const localName = decodeUtf8(
    bytes.subarray(localOffset + 30, localOffset + 30 + nameBytes),
    `${wheelPath} local entry name`,
  );
  if (localName !== entry.name) {
    throw new Error(`Capture Runtime Python wheel local entry name drifted: ${entry.name}.`);
  }
  const dataOffset = localOffset + 30 + nameBytes + extraBytes;
  const dataEnd = dataOffset + entry.compressedBytes;
  if (dataOffset > bytes.length || dataEnd > bytes.length || dataEnd < dataOffset) {
    throw new Error(`Capture Runtime Python wheel entry is out of bounds: ${entry.name}.`);
  }
  const compressed = bytes.subarray(dataOffset, dataEnd);
  let extracted: Buffer;
  try {
    extracted =
      entry.compressionMethod === 0
        ? Buffer.from(compressed)
        : entry.compressionMethod === 8
          ? inflateRawSync(compressed)
          : (() => {
              throw new Error(`unsupported compression method ${entry.compressionMethod}`);
            })();
  } catch (error) {
    throw new Error(
      `Capture Runtime Python wheel entry could not be decompressed: ${entry.name} (${wheelPath}).`,
      { cause: error },
    );
  }
  if (extracted.length !== entry.uncompressedBytes) {
    throw new Error(`Capture Runtime Python wheel entry size is invalid: ${entry.name}.`);
  }
  return extracted;
}

function metadataField(metadata: string, field: string): string {
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'mu').exec(metadata);
  if (!match?.[1]?.trim()) {
    throw new Error(`Capture Runtime Python wheel metadata omitted ${field}.`);
  }
  return match[1].trim();
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Capture Runtime Python wheel ${label} is not valid UTF-8.`, {
      cause: error,
    });
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
