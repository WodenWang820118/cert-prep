import { CAPTURE_RUNTIME_VERSION } from './capture-runtime-version.mts';
import { createHash } from 'node:crypto';
import { readFile as readFileAsync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  reverifyCandidateArtifactReceipt,
  verifyCandidateArtifactReceipt,
  type CandidateArtifactReceipt,
  type CandidateArtifactReceiptInput,
} from './capture-candidate-gate.mts';
import {
  captureRuntimeConsumerSnapshot,
  createCaptureRuntimeConsumerDiskSource,
  verifyCaptureRuntimeConsumerSnapshot,
  type CaptureRuntimeConsumerSnapshot,
  type CaptureRuntimeConsumerSource,
} from './capture-runtime-consumer-source.mts';
import {
  assertCaptureRuntimeConsumerInventory,
  readCaptureRuntimeConsumerInventoryFromSnapshot,
  type CaptureRuntimeConsumerInventoryReport,
  type CaptureRuntimeContractSource,
} from './capture-runtime-version-check.mts';

/**
 * Phase 2's producer receipt binding is for release 0.5.0. It proves a
 * complete declared candidate directory plus the producer-required subset and
 * a matching consumer source snapshot. It does not prove full D3 runtime or
 * installer readiness, and it never performs installation.
 */
export const CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION = CAPTURE_RUNTIME_VERSION;

export type CandidateInstallGitResolver = Readonly<{
  resolveTopLevel(workspaceRoot: string): string;
  resolveHead(workspaceRoot: string): string;
}>;

export type CandidateInstallBindingDependencies = Readonly<{
  readonly git?: CandidateInstallGitResolver;
  readonly source?: CaptureRuntimeConsumerSource;
  readonly verifyReceipt?: (
    input: CandidateArtifactReceiptInput,
  ) => Promise<CandidateArtifactReceipt>;
  readonly reverifyReceipt?: (
    receipt: CandidateArtifactReceipt,
  ) => Promise<void>;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}>;

export type CandidateInstallBindingPrepareInput = Readonly<{
  readonly workspaceRoot: string;
  readonly expectedReleaseVersion: typeof CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION;
  readonly expectedReleaseMode: CandidateArtifactReceiptInput['releaseMode'];
  readonly candidate: CandidateArtifactReceiptInput;
}>;

export type CandidateInstallBindingPreparation = Readonly<{
  readonly workspaceRoot: string;
  /** Cert Prep consumer repository HEAD; independent of producer receipt.sourceCommit. */
  readonly sourceHead: string;
  readonly sourceSnapshot: CaptureRuntimeConsumerSnapshot;
  readonly candidate: CandidateArtifactReceipt;
  readonly contractSource: CaptureRuntimeContractSource;
  readonly inventory: CaptureRuntimeConsumerInventoryReport;
}>;

export type CandidateInstallBindingWriter = (
  preparation: CandidateInstallBindingPreparation,
) => Promise<void> | void;

const GIT_HEAD_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ACTIVE_PREPARATIONS = new WeakSet<object>();
const PREPARATION_STATE = new WeakMap<
  object,
  Readonly<{
    readonly inventoryFingerprint: string;
    readonly contractSha256: string;
  }>
>();

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replaceAll('\\', '/');
  const normalizedRight = resolve(right).replaceAll('\\', '/');
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function oneLineGitOutput(
  workspaceRoot: string,
  args: readonly string[],
  label: string,
): string {
  const result = spawnSync('git', [...args], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Could not resolve Git ${label}.`, { cause: result.error });
  }
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error(`Could not resolve Git ${label}.`);
  }
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1 || lines[0].includes('\0') || lines[0].trim() !== lines[0]) {
    throw new Error(`Git ${label} output is not one canonical line.`);
  }
  return lines[0];
}

function defaultGitResolver(): CandidateInstallGitResolver {
  return {
    resolveTopLevel(workspaceRoot) {
      return oneLineGitOutput(
        workspaceRoot,
        ['rev-parse', '--show-toplevel'],
        'workspace root',
      );
    },
    resolveHead(workspaceRoot) {
      const head = oneLineGitOutput(
        workspaceRoot,
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        'HEAD',
      );
      if (!GIT_HEAD_PATTERN.test(head)) {
        throw new Error('Git HEAD is not a lowercase 40-character commit.');
      }
      return head;
    },
  };
}

export function resolveTrustedGitIdentity(
  workspaceRoot: string,
  resolver: CandidateInstallGitResolver = defaultGitResolver(),
): { readonly workspaceRoot: string; readonly sourceHead: string } {
  const requestedRoot = resolve(workspaceRoot);
  const canonicalRequestedRoot = realpathSync(requestedRoot);
  if (!sameFilesystemPath(requestedRoot, canonicalRequestedRoot)) {
    throw new Error('Candidate binding workspace root is not canonical.');
  }
  const gitRoot = resolver.resolveTopLevel(requestedRoot);
  const canonicalGitRoot = realpathSync(resolve(gitRoot));
  if (!sameFilesystemPath(canonicalRequestedRoot, canonicalGitRoot)) {
    throw new Error(
      `Git workspace root does not match the explicit workspace root: ${canonicalGitRoot}.`,
    );
  }
  const sourceHead = resolver.resolveHead(requestedRoot);
  if (!GIT_HEAD_PATTERN.test(sourceHead)) {
    throw new Error('Git HEAD is not a lowercase 40-character commit.');
  }
  return { workspaceRoot: canonicalRequestedRoot, sourceHead };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function candidateContractPath(receipt: CandidateArtifactReceipt): string {
  const path = `${receipt.candidateRoot}/contracts/contract-set.json`;
  if (!sameFilesystemPath(resolve(receipt.candidateRoot), resolve(path, '..', '..'))) {
    throw new Error('Candidate contract path escaped its verified root.');
  }
  return path;
}

async function readCandidateContractSource(
  receipt: CandidateArtifactReceipt,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<CaptureRuntimeContractSource> {
  const contractPath = candidateContractPath(receipt);
  const bytes = Uint8Array.from(await readFile(contractPath));
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== receipt.contractSetSha256 || !SHA256_PATTERN.test(actualSha256)) {
    throw new Error(
      'Verified candidate contract bytes do not match the receipt contract-set SHA-256.',
    );
  }
  return Object.freeze({
    source: contractPath,
    bytes,
    declaredSha256: receipt.contractSetSha256,
  });
}

function assertContractSourceIntegrity(
  contract: CaptureRuntimeContractSource,
  expectedSha256?: string,
): void {
  const actualSha256 = sha256(contract.bytes);
  if (
    !SHA256_PATTERN.test(contract.declaredSha256) ||
    actualSha256 !== contract.declaredSha256 ||
    (expectedSha256 !== undefined && actualSha256 !== expectedSha256)
  ) {
    throw new Error('Candidate contract source bytes were mutated after preparation.');
  }
}

function inventoryFingerprint(inventory: CaptureRuntimeConsumerInventoryReport): string {
  return sha256(
    Buffer.from(
      JSON.stringify({
        status: inventory.status,
        expectedRuntimeVersion: inventory.expectedRuntimeVersion,
        expectedApiVersion: inventory.expectedApiVersion,
        expectedDocumentSchemaVersion: inventory.expectedDocumentSchemaVersion,
        expectedContractSetVersion: inventory.expectedContractSetVersion,
        observedRuntimeVersion: inventory.observedRuntimeVersion,
        contractSource: inventory.contractSource,
        contractSetSha256: inventory.contractSetSha256,
        contractSchemaNames: [...inventory.contractSchemaNames],
        ocrProjectionSchemaVersion: inventory.ocrProjectionSchemaVersion,
        entries: inventory.entries.map((entry) => ({ ...entry })),
        errors: [...inventory.errors],
      }),
    ),
  );
}

function defaultReadFile(path: string): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    readFileAsync(path, (error, bytes) => {
      if (error) reject(error);
      else resolvePromise(Uint8Array.from(bytes));
    });
  });
}

function assertReceiptIdentity(
  receipt: CandidateArtifactReceipt,
  input: CandidateInstallBindingPrepareInput,
): void {
  if (!sameFilesystemPath(receipt.candidateRoot, input.candidate.candidate)) {
    throw new Error('Verified candidate root does not match the requested candidate.');
  }
  if (receipt.candidateId !== input.candidate.candidateId) {
    throw new Error('Verified candidate ID does not match the requested candidate.');
  }
  if (receipt.candidateManifestSha256 !== input.candidate.candidateManifestSha256) {
    throw new Error('Verified candidate manifest digest does not match the requested candidate.');
  }
  if (receipt.packageCandidateId !== input.candidate.packageCandidateId) {
    throw new Error('Verified package candidate ID does not match the requested candidate.');
  }
  if (receipt.runtimeCandidateId !== input.candidate.runtimeCandidateId) {
    throw new Error('Verified runtime candidate ID does not match the requested candidate.');
  }
  if (receipt.contractSetSha256 !== input.candidate.contractSetSha256) {
    throw new Error('Verified contract-set digest does not match the requested candidate.');
  }
  // This is producer provenance. It is intentionally compared only with the
  // requested receipt identity, never with the Cert Prep consumer HEAD.
  if (receipt.sourceCommit !== input.candidate.sourceCommit) {
    throw new Error('Verified producer source commit does not match the requested candidate.');
  }
  if (receipt.releaseVersion !== input.expectedReleaseVersion) {
    throw new Error(
      `Candidate release version must be ${input.expectedReleaseVersion}.`,
    );
  }
  if (receipt.releaseMode !== input.expectedReleaseMode) {
    throw new Error('Candidate release mode does not match the expected release.');
  }
}

function freezeSnapshot(
  snapshot: CaptureRuntimeConsumerSnapshot,
): CaptureRuntimeConsumerSnapshot {
  return Object.freeze({
    version: snapshot.version,
    sourceHead: snapshot.sourceHead,
    files: Object.freeze(
      snapshot.files.map((file) =>
        Object.freeze({
          path: file.path,
          bytes: Uint8Array.from(file.bytes),
          sha256: file.sha256,
        }),
      ),
    ),
    aggregateSha256: snapshot.aggregateSha256,
  });
}

export async function prepareCandidateInstallBinding(
  input: CandidateInstallBindingPrepareInput,
  dependencies: CandidateInstallBindingDependencies = {},
): Promise<CandidateInstallBindingPreparation> {
  if (input.expectedReleaseVersion !== CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION) {
    throw new Error(
      `Candidate binding only accepts release ${CAPTURE_CANDIDATE_INSTALL_RELEASE_VERSION}.`,
    );
  }
  if (input.candidate.releaseVersion !== input.expectedReleaseVersion) {
    throw new Error('Candidate input release version does not match the expected release.');
  }
  if (input.candidate.releaseMode !== input.expectedReleaseMode) {
    throw new Error('Candidate input release mode does not match the expected release.');
  }

  const identity = resolveTrustedGitIdentity(input.workspaceRoot, dependencies.git);

  const verifyReceipt = dependencies.verifyReceipt ?? verifyCandidateArtifactReceipt;
  const receipt = await verifyReceipt(input.candidate);
  assertReceiptIdentity(receipt, input);

  // Contract bytes are read only after the producer receipt has closed the
  // candidate root, then their digest is bound before consumer inventory.
  const contractSource = await readCandidateContractSource(
    receipt,
    dependencies.readFile ?? defaultReadFile,
  );
  const source =
    dependencies.source ?? createCaptureRuntimeConsumerDiskSource(identity.workspaceRoot);
  const sourceSnapshot = freezeSnapshot(
    captureRuntimeConsumerSnapshot(source, identity.sourceHead),
  );
  const inventory = assertCaptureRuntimeConsumerInventory(
    readCaptureRuntimeConsumerInventoryFromSnapshot(sourceSnapshot, contractSource),
  );
  if (inventory.expectedRuntimeVersion !== input.expectedReleaseVersion) {
    throw new Error(
      `Producer contract runtime version does not match ${input.expectedReleaseVersion}.`,
    );
  }
  const preparation = Object.freeze({
    workspaceRoot: identity.workspaceRoot,
    sourceHead: identity.sourceHead,
    sourceSnapshot,
    candidate: receipt,
    contractSource,
    inventory,
  });
  ACTIVE_PREPARATIONS.add(preparation);
  PREPARATION_STATE.set(preparation, {
    inventoryFingerprint: inventoryFingerprint(inventory),
    contractSha256: sha256(contractSource.bytes),
  });
  return preparation;
}

export async function executeCandidateInstallBinding(
  preparation: CandidateInstallBindingPreparation,
  writer: CandidateInstallBindingWriter,
  dependencies: CandidateInstallBindingDependencies = {},
): Promise<void> {
  if (
    preparation === null ||
    typeof preparation !== 'object' ||
    !ACTIVE_PREPARATIONS.has(preparation)
  ) {
    throw new Error('Candidate binding preparation is forged, consumed, or already used.');
  }
  // Consume the in-memory binding before the first await. This rejects
  // concurrent/repeated execution and leaves no stale permission after errors.
  ACTIVE_PREPARATIONS.delete(preparation);
  const privateState = PREPARATION_STATE.get(preparation);
  if (!privateState) {
    throw new Error('Candidate binding preparation has no private state.');
  }
  const identity = resolveTrustedGitIdentity(
    preparation.workspaceRoot,
    dependencies.git,
  );
  if (identity.workspaceRoot !== preparation.workspaceRoot) {
    throw new Error('Candidate binding workspace root changed after preparation.');
  }
  if (identity.sourceHead !== preparation.sourceHead) {
    throw new Error('Git HEAD changed after candidate binding preparation.');
  }
  const source =
    dependencies.source ?? createCaptureRuntimeConsumerDiskSource(identity.workspaceRoot);
  verifyCaptureRuntimeConsumerSnapshot(
    preparation.sourceSnapshot,
    source,
    identity.sourceHead,
  );
  const reverifyReceipt =
    dependencies.reverifyReceipt ?? reverifyCandidateArtifactReceipt;
  await reverifyReceipt(preparation.candidate);
  const contractSource = await readCandidateContractSource(
    preparation.candidate,
    dependencies.readFile ?? defaultReadFile,
  );
  // These are synchronous final-boundary checks. No await may occur between
  // them and the writer, so source/contract/inventory mutations during the
  // earlier async checks cannot become an authorization race.
  const finalIdentity = resolveTrustedGitIdentity(
    preparation.workspaceRoot,
    dependencies.git,
  );
  if (
    finalIdentity.workspaceRoot !== preparation.workspaceRoot ||
    finalIdentity.sourceHead !== preparation.sourceHead
  ) {
    throw new Error('Git consumer identity changed before candidate binding execution.');
  }
  verifyCaptureRuntimeConsumerSnapshot(
    preparation.sourceSnapshot,
    source,
    finalIdentity.sourceHead,
  );
  assertContractSourceIntegrity(
    preparation.contractSource,
    privateState.contractSha256,
  );
  if (
    contractSource.declaredSha256 !== preparation.contractSource.declaredSha256 ||
    contractSource.declaredSha256 !== preparation.candidate.contractSetSha256 ||
    sha256(contractSource.bytes) !== sha256(preparation.contractSource.bytes)
  ) {
    throw new Error('Candidate contract source changed after preparation.');
  }
  const finalInventory = assertCaptureRuntimeConsumerInventory(
    readCaptureRuntimeConsumerInventoryFromSnapshot(
      preparation.sourceSnapshot,
      preparation.contractSource,
    ),
  );
  if (
    inventoryFingerprint(preparation.inventory) !==
      privateState.inventoryFingerprint ||
    inventoryFingerprint(finalInventory) !== privateState.inventoryFingerprint
  ) {
    throw new Error('Candidate consumer inventory was mutated after preparation.');
  }
  // All checks above are awaited before the writer is called. The writer owns
  // any future installer mutation; this function does not retry or claim rollback.
  await writer(preparation);
}
