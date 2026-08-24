import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Keep the app-data lease outside the repository's deep path. The downloaded
// worker contains native files whose full extraction paths must stay below the
// Windows loader budget.
const ACCEPTANCE_APP_DATA_DIRECTORY = join('..', 'cp-a');
const MAX_WIN32_PATH_LENGTH = 259;
const HIDDEN_VERSION_UUID = '0'.repeat(32);

export function acceptanceAppDataRoot(workspaceRoot: string): string {
  return resolve(workspaceRoot, ACCEPTANCE_APP_DATA_DIRECTORY);
}

export function createAcceptanceAppDataDirectory(
  workspaceRoot: string,
  runId: string,
  purpose: 'image' | 'pdf',
): string {
  const root = acceptanceAppDataRoot(workspaceRoot);
  mkdirSync(root, { recursive: true });
  assertNotReparsePoint(root, 'Acceptance app-data root');
  const directory = mkdtempSync(join(root, `${runId.slice(0, 12)}-${purpose}-`));
  assertDirectChild(root, directory);
  assertNotReparsePoint(directory, 'Acceptance app-data directory');
  return directory;
}

export function removeAcceptanceAppDataDirectory(
  workspaceRoot: string,
  directory: string,
): void {
  const root = acceptanceAppDataRoot(workspaceRoot);
  const resolvedDirectory = resolve(directory);
  if (existsSync(resolvedDirectory)) {
    assertDirectChild(root, resolvedDirectory);
    assertNotReparsePoint(resolvedDirectory, 'Acceptance app-data directory');
    rmSync(resolvedDirectory, { recursive: true, force: true });
  }
  if (existsSync(resolvedDirectory)) {
    throw new Error(
      `Acceptance cleanup could not remove temporary app-data: ${resolvedDirectory}.`,
    );
  }
}

export function assertAcceptanceAppDataDirectory(
  workspaceRoot: string,
  directory: string,
): void {
  const root = acceptanceAppDataRoot(workspaceRoot);
  assertNotReparsePoint(root, 'Acceptance app-data root');
  const resolvedDirectory = resolve(directory);
  assertDirectChild(root, resolvedDirectory);
  if (!existsSync(resolvedDirectory)) {
    throw new Error(
      `Acceptance app-data directory does not exist: ${resolvedDirectory}.`,
    );
  }
  assertNotReparsePoint(
    resolvedDirectory,
    'Acceptance app-data directory',
  );
}

export function assertDownloadedWorkerPathBudget(
  appDataDirectory: string,
  runtimeVersion: string,
  workerArchive: Uint8Array,
): void {
  const maximumEntryLength = maximumZipEntryLength(workerArchive);
  const probeRoot = join(
    resolve(appDataDirectory),
    'capture-workbench',
    'engines',
    'windowsml-ocr',
    'versions',
    `.${runtimeVersion}.${HIDDEN_VERSION_UUID}`,
    'worker',
  );
  const worstCasePathLength = probeRoot.length + 1 + maximumEntryLength;
  if (worstCasePathLength > MAX_WIN32_PATH_LENGTH) {
    throw new Error(
      `Downloaded Capture Runtime worker paths exceed the Windows loader budget (${worstCasePathLength} > ${MAX_WIN32_PATH_LENGTH}); use a shorter acceptance app-data root.`,
    );
  }
}

function assertDirectChild(root: string, directory: string): void {
  const relativeDirectory = relative(resolve(root), resolve(directory));
  if (
    !relativeDirectory ||
    relativeDirectory.includes(sep) ||
    relativeDirectory === '..' ||
    relativeDirectory.startsWith(`..${sep}`)
  ) {
    throw new Error(
      `Acceptance app-data path escaped its canonical root: ${resolve(directory)}.`,
    );
  }
}

function assertNotReparsePoint(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} cannot be a symbolic link: ${path}.`);
  }
}

function maximumZipEntryLength(archive: Uint8Array): number {
  const bytes = Buffer.from(archive);
  const endOfCentralDirectory = findSignatureFromEnd(bytes, 0x06054b50);
  if (endOfCentralDirectory < 0) {
    throw new Error('Downloaded OCR worker archive has no ZIP directory.');
  }
  const centralDirectorySize = bytes.readUInt32LE(endOfCentralDirectory + 12);
  const centralDirectoryOffset = bytes.readUInt32LE(endOfCentralDirectory + 16);
  let cursor = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;
  let maximum = 0;
  while (cursor < end) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Downloaded OCR worker archive has an invalid ZIP entry.');
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    maximum = Math.max(
      maximum,
      bytes
        .subarray(cursor + 46, cursor + 46 + nameLength)
        .toString('utf8').length,
    );
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end || maximum === 0) {
    throw new Error('Downloaded OCR worker archive has an invalid ZIP directory.');
  }
  return maximum;
}

function findSignatureFromEnd(bytes: Buffer, signature: number): number {
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (bytes.readUInt32LE(index) === signature) return index;
  }
  return -1;
}
