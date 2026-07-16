import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOCAL_NONPUBLISHABLE_PROFILE = 'local_nonpublishable';
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const ALPHA_VERSION_PATTERN = /^\d+\.\d+\.\d+-alpha\.\d+$/;
const CANDIDATE_HARNESS_PATH =
  'harness/tools/release/local-install-acceptance.ts';
const INSTALLER_IDENTITY_PATTERN =
  /^(release\/installers\/[^/:]*setup\.exe):([0-9a-f]{64})$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const INSTALLED_EXE_NAME = 'cert-prep-desktop.exe';
const PRODUCT_NAME = 'Cert Prep';
// Tauri 2.11.2 renders Cargo author `cert-prep` as this NSIS manufacturer.
const NSIS_MANUFACTURER = 'certprep';

interface CandidateIdentity {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly version: string;
  readonly tag: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly distributionProfile: typeof LOCAL_NONPUBLISHABLE_PROFILE;
  readonly publishable: false;
  readonly files: readonly string[];
}

interface LocalReleasePlan extends Record<string, unknown> {
  readonly channel: typeof LOCAL_NONPUBLISHABLE_PROFILE;
  readonly distributionProfile: typeof LOCAL_NONPUBLISHABLE_PROFILE;
  readonly publishable: false;
}

interface UninstallEntry {
  readonly hive: 'HKCU' | 'HKLM' | 'HKLM32';
  readonly key: string;
  readonly displayName: string;
  readonly displayVersion: string;
  readonly publisher: string;
  readonly installLocation: string;
  readonly mainBinaryName: string;
  readonly uninstallString: string;
}

interface RunningProcess {
  readonly processId: number;
  readonly name: string;
  readonly executablePath: string;
}

export interface HostInstallState {
  readonly uninstallEntries: readonly UninstallEntry[];
  readonly manufacturerKeyExists: boolean;
  readonly manufacturerInstallLocation: string;
  readonly runningProcesses: readonly RunningProcess[];
  readonly existingInstallRoots: readonly string[];
}

interface InstallerRunResult {
  readonly exitCode: number;
}

interface AcceptanceDependencies {
  readonly platform: NodeJS.Platform;
  readonly executingHarnessPath: string;
  readonly readWorkspaceHead: (workspaceRoot: string) => string;
  readonly resolvePowerShellExecutable: () => string;
  readonly inspectHostState: (
    knownInstallRoots: readonly string[],
    powershellExecutable: string,
  ) => HostInstallState;
  readonly runInstaller: (
    installerPath: string,
    installRoot: string,
  ) => InstallerRunResult;
  readonly now: () => Date;
  readonly newRunId: () => string;
  readonly newTempId: () => string;
}

interface AcceptanceArguments {
  readonly 'workspace-root'?: string;
  readonly 'candidate-root'?: string;
  readonly 'output-root'?: string;
  readonly 'install-root'?: string;
  readonly 'acceptance-run-id'?: string;
  readonly 'dry-run'?: string;
}

interface PreparedAcceptance {
  readonly workspaceRoot: string;
  readonly candidateRoot: string;
  readonly outputRoot: string;
  readonly installRoot: string;
  readonly receiptPath: string;
  readonly acceptanceRunId: string;
  readonly candidate: CandidateIdentity;
  readonly installerPath: string;
  readonly installerRelativePath: string;
  readonly installerSha256: string;
  readonly harnessSha256: string;
}

const defaultDependencies: AcceptanceDependencies = {
  platform: process.platform,
  executingHarnessPath: fileURLToPath(import.meta.url),
  readWorkspaceHead,
  resolvePowerShellExecutable: () =>
    resolveWindowsPowerShellExecutable(process.env),
  inspectHostState: inspectWindowsHostState,
  runInstaller: runNsisInstaller,
  now: () => new Date(),
  newRunId: () => `local-install-${randomUUID()}`,
  newTempId: randomUUID,
};

export async function runLocalInstallAcceptance(
  args: AcceptanceArguments,
  dependencies: AcceptanceDependencies = defaultDependencies,
) {
  assertAllowedArguments(args);
  if (dependencies.platform !== 'win32') {
    throw new Error('Local NSIS install acceptance requires Windows.');
  }

  const prepared = await prepareAcceptance(args, dependencies);
  const knownInstallRoots = knownCertPrepInstallRoots(process.env);
  const powershellExecutable = dependencies.resolvePowerShellExecutable();
  assertFreshInstallPreconditions(
    dependencies.inspectHostState(knownInstallRoots, powershellExecutable),
  );

  const dryRun = parseBooleanArgument(args['dry-run'], 'dry-run', false);
  if (dryRun) {
    return acceptanceResult(prepared, undefined, 'dry-run');
  }

  const installerResult = dependencies.runInstaller(
    prepared.installerPath,
    prepared.installRoot,
  );
  if (installerResult.exitCode !== 0) {
    throw new Error(
      `NSIS installation failed with exit code ${installerResult.exitCode}.`,
    );
  }

  await validateCandidateFiles(prepared.candidateRoot, prepared.candidate);
  if (
    dependencies.readWorkspaceHead(prepared.workspaceRoot).toLowerCase() !==
    prepared.candidate.commitSha
  ) {
    throw new Error(
      'Workspace HEAD changed while the exact candidate was being installed.',
    );
  }

  const installedExePath = verifyInstalledState(
    prepared,
    dependencies.inspectHostState(knownInstallRoots, powershellExecutable),
  );
  const installedExe = statSync(installedExePath);
  const installedExeSha256 = await sha256File(installedExePath);
  const receipt = {
    schemaVersion: 1,
    candidateId: prepared.candidate.candidateId,
    acceptanceRunId: prepared.acceptanceRunId,
    harnessSha256: prepared.harnessSha256,
    packageKind: 'nsis',
    installer: {
      relativePath: prepared.installerRelativePath,
      sha256: prepared.installerSha256,
    },
    installedExecutable: {
      path: installedExePath,
      name: basename(installedExePath),
      bytes: installedExe.size,
      sha256: installedExeSha256,
    },
    freshInstallVerified: true,
    installerExitCode: 0,
    installedAt: dependencies.now().toISOString(),
  } as const;
  writeJsonAtomically(prepared.receiptPath, receipt, dependencies.newTempId);
  return acceptanceResult(prepared, receipt, 'installed');
}

async function prepareAcceptance(
  args: AcceptanceArguments,
  dependencies: AcceptanceDependencies,
): Promise<PreparedAcceptance> {
  const workspaceRoot = safeExistingDirectory(
    resolve(args['workspace-root'] ?? '.'),
    'Workspace root',
  );
  const candidateRoot = safeExistingDirectory(
    resolve(
      workspaceRoot,
      args['candidate-root'] ?? 'tmp/local-alpha-candidate',
    ),
    'Candidate root',
  );
  const outputRoot = resolve(
    workspaceRoot,
    args['output-root'] ?? 'tmp/cert-prep-desktop/local-install-acceptance',
  );
  assertSafeNewOutputRoot(workspaceRoot, outputRoot);
  const installRoot = resolve(
    workspaceRoot,
    args['install-root'] ?? join(outputRoot, 'installed'),
  );
  requireStrictDescendant(installRoot, outputRoot, 'NSIS install root');
  if (pathEntryExists(installRoot)) {
    throw new Error(`NSIS install root already exists: ${installRoot}.`);
  }

  const candidateValue = readJson(join(candidateRoot, 'candidate.json'));
  const candidate = localCandidateIdentity(candidateValue);
  await validateCandidateFiles(candidateRoot, candidate);
  const plan = readJson(
    join(candidateRoot, 'release', 'metadata', 'release-plan.json'),
  );
  assertSupportedDistributionPlan(plan);
  assertCandidateMatchesPlan(candidate, plan);
  if (
    plan.distributionProfile !== LOCAL_NONPUBLISHABLE_PROFILE ||
    plan.publishable !== false ||
    plan.channel !== LOCAL_NONPUBLISHABLE_PROFILE
  ) {
    throw new Error(
      'Install acceptance requires an exact local_nonpublishable release plan.',
    );
  }

  const head = dependencies.readWorkspaceHead(workspaceRoot).toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(head) || head !== candidate.commitSha) {
    throw new Error(
      'Workspace HEAD does not match the exact local candidate commit.',
    );
  }
  const expectedTag = `cert-prep-local-v${candidate.version}-${candidate.commitSha.slice(0, 12)}`;
  if (candidate.tag !== expectedTag) {
    throw new Error('Local candidate tag does not match its exact commit.');
  }

  const harnessSha256 = await verifiedCandidateFile(
    candidateRoot,
    candidate,
    CANDIDATE_HARNESS_PATH,
  );
  const expectedHarnessPath = realpathSync(
    resolve(candidateRoot, ...CANDIDATE_HARNESS_PATH.split('/')),
  );
  const executingHarnessPath = safeExistingFile(
    dependencies.executingHarnessPath,
    'Executing install-acceptance harness',
  );
  if (!samePath(executingHarnessPath, expectedHarnessPath)) {
    throw new Error(
      'Install acceptance must execute the harness copied into the exact candidate.',
    );
  }

  const installerIdentities = candidate.files
    .map((identity) => String(identity).match(INSTALLER_IDENTITY_PATTERN))
    .filter((match): match is RegExpMatchArray => match !== null);
  if (installerIdentities.length !== 1) {
    throw new Error('Candidate must declare exactly one NSIS setup installer.');
  }
  const installerRelativePath = installerIdentities[0][1];
  const installerSha256 = installerIdentities[0][2].toLowerCase();
  const installerPath = safeCandidateFile(candidateRoot, installerRelativePath);
  if ((await sha256File(installerPath)) !== installerSha256) {
    throw new Error('NSIS installer digest does not match candidate.json.');
  }

  const acceptanceRunId = args['acceptance-run-id'] ?? dependencies.newRunId();
  if (!RUN_ID_PATTERN.test(acceptanceRunId)) {
    throw new Error(
      'acceptance-run-id must contain 8-128 letters, digits, dots, underscores, or hyphens.',
    );
  }

  return {
    workspaceRoot,
    candidateRoot,
    outputRoot,
    installRoot,
    receiptPath: join(outputRoot, 'install-receipt.json'),
    acceptanceRunId,
    candidate,
    installerPath,
    installerRelativePath,
    installerSha256,
    harnessSha256,
  };
}

export function assertFreshInstallPreconditions(state: HostInstallState): void {
  const blockers: string[] = [];
  if (state.uninstallEntries.length > 0) blockers.push('uninstall entry');
  if (state.manufacturerKeyExists) blockers.push('manufacturer registry key');
  if (state.runningProcesses.length > 0) blockers.push('running process');
  if (state.existingInstallRoots.length > 0)
    blockers.push('existing install root');
  if (blockers.length > 0) {
    throw new Error(
      `Fresh-install preconditions failed: ${blockers.join(', ')}. Remove the existing Cert Prep installation state before retrying.`,
    );
  }
}

function verifyInstalledState(
  prepared: PreparedAcceptance,
  state: HostInstallState,
): string {
  if (state.runningProcesses.length > 0) {
    throw new Error(
      'Silent NSIS installation unexpectedly launched Cert Prep.',
    );
  }
  if (state.uninstallEntries.length !== 1) {
    throw new Error(
      'NSIS installation must create exactly one Cert Prep uninstall entry.',
    );
  }
  const entry = state.uninstallEntries[0];
  if (
    entry.hive !== 'HKCU' ||
    entry.key !== PRODUCT_NAME ||
    entry.displayName !== PRODUCT_NAME ||
    entry.displayVersion !== prepared.candidate.version ||
    entry.publisher !== NSIS_MANUFACTURER ||
    entry.mainBinaryName.toLowerCase() !== INSTALLED_EXE_NAME ||
    !samePath(unquotePath(entry.installLocation), prepared.installRoot)
  ) {
    throw new Error(
      'HKCU uninstall metadata does not match the exact NSIS install root and candidate.',
    );
  }
  if (
    !state.manufacturerKeyExists ||
    !samePath(
      unquotePath(state.manufacturerInstallLocation),
      prepared.installRoot,
    )
  ) {
    throw new Error(
      'Cert Prep manufacturer registry metadata does not match the NSIS install root.',
    );
  }

  const verifiedInstallRoot = safeExistingDirectory(
    prepared.installRoot,
    'Installed Cert Prep root',
  );
  if (!samePath(verifiedInstallRoot, prepared.installRoot)) {
    throw new Error(
      'Installed Cert Prep root resolved outside the planned path.',
    );
  }
  const installedExePath = safeExistingFile(
    join(verifiedInstallRoot, INSTALLED_EXE_NAME),
    'Installed Cert Prep executable',
  );
  requireStrictDescendant(
    installedExePath,
    verifiedInstallRoot,
    'Installed Cert Prep executable',
  );
  if (statSync(installedExePath).size < 1) {
    throw new Error('Installed Cert Prep executable is empty.');
  }
  return installedExePath;
}

function acceptanceResult(
  prepared: PreparedAcceptance,
  receipt:
    | {
        readonly installedExecutable: { readonly path: string };
      }
    | undefined,
  mode: 'dry-run' | 'installed',
) {
  return {
    mode,
    candidateId: prepared.candidate.candidateId,
    acceptanceRunId: prepared.acceptanceRunId,
    harnessSha256: prepared.harnessSha256,
    candidateRoot: prepared.candidateRoot,
    installerRelativePath: prepared.installerRelativePath,
    installerSha256: prepared.installerSha256,
    installRoot: prepared.installRoot,
    installedExePath:
      receipt?.installedExecutable.path ??
      join(prepared.installRoot, INSTALLED_EXE_NAME),
    installReceiptPath: prepared.receiptPath,
    resilienceEnvironment: {
      CERT_PREP_RESILIENCE_CANDIDATE_ROOT: prepared.candidateRoot,
      CERT_PREP_RELEASE_CANDIDATE_ID: prepared.candidate.candidateId,
      CERT_PREP_ACCEPTANCE_HARNESS_SHA256: prepared.harnessSha256,
      CERT_PREP_RESILIENCE_INSTALLED_EXE_PATH:
        receipt?.installedExecutable.path ??
        join(prepared.installRoot, INSTALLED_EXE_NAME),
      CERT_PREP_RESILIENCE_INSTALL_RECEIPT_PATH: prepared.receiptPath,
      CERT_PREP_RESILIENCE_ACCEPTANCE_RUN_ID: prepared.acceptanceRunId,
    },
  };
}

export function writeJsonAtomically(
  path: string,
  value: unknown,
  newTempId: () => string = randomUUID,
): void {
  if (pathEntryExists(path)) {
    throw new Error(`Install receipt already exists: ${path}.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${newTempId()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, 'wx');
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(tempPath, { force: true });
  }
}

function inspectWindowsHostState(
  knownInstallRoots: readonly string[],
  powershellExecutable: string,
): HostInstallState {
  const manufacturerPath = nsisManufacturerRegistryPath();
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$scopes = @(
  [pscustomobject]@{ Hive = 'HKCU'; Path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' },
  [pscustomobject]@{ Hive = 'HKLM'; Path = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' },
  [pscustomobject]@{ Hive = 'HKLM32'; Path = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' }
)
$entries = @(
  foreach ($scope in $scopes) {
    Get-ItemProperty -Path $scope.Path -ErrorAction SilentlyContinue |
      Where-Object {
        $_.PSChildName -eq 'Cert Prep' -or $_.DisplayName -eq 'Cert Prep'
      } |
      ForEach-Object {
        [pscustomobject]@{
          hive = $scope.Hive
          key = [string]$_.PSChildName
          displayName = [string]$_.DisplayName
          displayVersion = [string]$_.DisplayVersion
          publisher = [string]$_.Publisher
          installLocation = [string]$_.InstallLocation
          mainBinaryName = [string]$_.MainBinaryName
          uninstallString = [string]$_.UninstallString
        }
      }
  }
)
$manufacturerPath = '${manufacturerPath}'
$manufacturerExists = Test-Path -LiteralPath $manufacturerPath
$manufacturerLocation = ''
if ($manufacturerExists) {
  $manufacturerLocation = [string](Get-ItemPropertyValue -LiteralPath $manufacturerPath -Name '(default)' -ErrorAction SilentlyContinue)
}
$processes = @(
  Get-CimInstance Win32_Process -Filter "Name = 'cert-prep-desktop.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object {
      [pscustomobject]@{
        processId = [int]$_.ProcessId
        name = [string]$_.Name
        executablePath = [string]$_.ExecutablePath
      }
    }
)
[pscustomobject]@{
  uninstallEntries = $entries
  manufacturerKeyExists = [bool]$manufacturerExists
  manufacturerInstallLocation = $manufacturerLocation
  runningProcesses = $processes
} | ConvertTo-Json -Depth 5 -Compress
`;
  const invocation = spawnSync(
    powershellExecutable,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (invocation.error || invocation.status !== 0) {
    const detail =
      invocation.error?.message || String(invocation.stderr ?? '').trim();
    throw new Error(
      `Unable to inspect Windows install state${detail ? `: ${detail}` : '.'}`,
    );
  }
  const parsed = JSON.parse(String(invocation.stdout ?? '')) as Omit<
    HostInstallState,
    'existingInstallRoots'
  >;
  return {
    ...parsed,
    existingInstallRoots: knownInstallRoots.filter(pathEntryExists),
  };
}

export function resolveWindowsPowerShellExecutable(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const systemRoot = environment.SystemRoot?.trim();
  if (systemRoot) {
    if (!isAbsolute(systemRoot)) {
      throw new Error('SystemRoot must be an absolute path.');
    }
    const preferred = resolve(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (pathEntryExists(preferred)) {
      return safeExistingFile(preferred, 'Windows PowerShell executable');
    }
  }

  const pathValue = environment.PATH ?? environment.Path ?? '';
  for (const rawEntry of pathValue.split(';')) {
    const trimmed = rawEntry.trim();
    const entry =
      trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1)
        : trimmed;
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = resolve(entry, 'powershell.exe');
    if (pathEntryExists(candidate)) {
      return safeExistingFile(candidate, 'Windows PowerShell executable');
    }
  }

  throw new Error(
    'Unable to resolve a canonical Windows PowerShell executable from SystemRoot or PATH.',
  );
}

export function nsisManufacturerRegistryPath(): string {
  return `HKCU:\\Software\\${NSIS_MANUFACTURER}\\${PRODUCT_NAME}`;
}

function runNsisInstaller(
  installerPath: string,
  installRoot: string,
): InstallerRunResult {
  const invocation = spawnSync(
    installerPath,
    nsisInstallArguments(installRoot),
    {
      stdio: 'inherit',
      windowsHide: true,
      timeout: 10 * 60 * 1_000,
    },
  );
  if (invocation.error) {
    throw new Error(
      `Unable to start NSIS installer: ${invocation.error.message}`,
    );
  }
  if (invocation.signal) {
    throw new Error(
      `NSIS installer terminated by signal ${invocation.signal}.`,
    );
  }
  if (invocation.status === null) {
    throw new Error('NSIS installer did not report an exit code.');
  }
  return { exitCode: invocation.status };
}

export function nsisInstallArguments(installRoot: string): string[] {
  if (!isAbsolute(installRoot)) {
    throw new Error('NSIS install root must be absolute.');
  }
  return ['/S', '/NS', `/D=${resolve(installRoot)}`];
}

function readWorkspaceHead(workspaceRoot: string): string {
  const invocation = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (invocation.error || invocation.status !== 0) {
    throw new Error(
      'Unable to resolve the workspace HEAD for install acceptance.',
    );
  }
  return String(invocation.stdout ?? '').trim();
}

async function validateCandidateFiles(
  candidateRoot: string,
  candidate: CandidateIdentity,
): Promise<void> {
  const root = resolve(candidateRoot);
  const realRoot = realpathSync(root);
  if (
    candidate.schemaVersion !== 1 ||
    candidate.files.length === 0 ||
    !SHA256_PATTERN.test(candidate.candidateId)
  ) {
    throw new Error('Candidate identity document is invalid.');
  }
  const identities = [...candidate.files].sort();
  if (new Set(identities).size !== identities.length) {
    throw new Error('Candidate identity document contains duplicate files.');
  }
  const rootEntries = readdirSync(root, { withFileTypes: true });
  if (
    rootEntries.length !== 3 ||
    !rootEntries.some(
      (entry) => entry.name === 'candidate.json' && entry.isFile(),
    ) ||
    !rootEntries.some(
      (entry) => entry.name === 'release' && entry.isDirectory(),
    ) ||
    !rootEntries.some(
      (entry) => entry.name === 'harness' && entry.isDirectory(),
    ) ||
    rootEntries.some((entry) => entry.isSymbolicLink())
  ) {
    throw new Error('Candidate root contains missing or undeclared entries.');
  }

  const actualPaths = new Set([
    ...listCandidateTree(join(root, 'release'), 'release'),
    ...listCandidateTree(join(root, 'harness'), 'harness'),
  ]);
  const declaredPaths = new Set<string>();
  for (const identity of identities) {
    const match = identity.match(
      /^((?:release|harness)\/[^:]+):([0-9a-f]{64})$/i,
    );
    if (!match) {
      throw new Error(`Candidate file identity is invalid: ${identity}.`);
    }
    const relativePath = match[1];
    declaredPaths.add(relativePath);
    const path = safeCandidateFile(root, relativePath);
    if (
      !realpathSync(path).startsWith(`${realRoot}${sep}`) ||
      (await sha256File(path)) !== match[2].toLowerCase()
    ) {
      throw new Error(
        `Candidate file identity does not match: ${relativePath}.`,
      );
    }
  }
  if (
    actualPaths.size !== declaredPaths.size ||
    [...actualPaths].some((path) => !declaredPaths.has(path))
  ) {
    throw new Error(
      'Candidate identity does not exactly cover release and harness files.',
    );
  }
  const computedCandidateId = createHash('sha256')
    .update(identities.join('\n'))
    .digest('hex');
  if (computedCandidateId !== candidate.candidateId) {
    throw new Error(
      'Candidate ID does not match the verified file identities.',
    );
  }
}

function listCandidateTree(root: string, prefix: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const identityPath = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Candidate tree contains a symbolic link: ${identityPath}.`,
      );
    }
    if (entry.isDirectory()) {
      output.push(...listCandidateTree(path, identityPath));
    } else if (entry.isFile()) {
      output.push(identityPath);
    } else {
      throw new Error(
        `Candidate tree contains an unsupported entry: ${identityPath}.`,
      );
    }
  }
  return output;
}

function assertSupportedDistributionPlan(
  plan: unknown,
): asserts plan is LocalReleasePlan {
  if (!isRecord(plan)) {
    throw new Error('Local release plan must be a JSON object.');
  }
  const version = String(plan.version ?? '');
  const commitSha = String(plan.commitSha ?? '').toLowerCase();
  const tag = String(plan.tag ?? '');
  const valid =
    ALPHA_VERSION_PATTERN.test(version) &&
    COMMIT_SHA_PATTERN.test(commitSha) &&
    plan.target === TARGET_TRIPLE &&
    plan.signed === false &&
    plan.distributionProfile === LOCAL_NONPUBLISHABLE_PROFILE &&
    plan.publishable === false &&
    plan.channel === LOCAL_NONPUBLISHABLE_PROFILE &&
    plan.repository === 'local/nonpublishable' &&
    tag === `cert-prep-local-v${version}-${commitSha.slice(0, 12)}` &&
    isSafeLocalAssetBaseUrl(plan.assetBaseUrl);
  if (!valid) {
    throw new Error(
      'Install acceptance requires an exact local_nonpublishable release plan.',
    );
  }
}

function isSafeLocalAssetBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'file:' &&
      !url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function assertCandidateMatchesPlan(
  candidate: CandidateIdentity,
  plan: unknown,
): void {
  if (!isRecord(plan)) {
    throw new Error('Local release plan must be a JSON object.');
  }
  for (const field of [
    'version',
    'tag',
    'repository',
    'commitSha',
    'distributionProfile',
    'publishable',
  ] as const) {
    if (candidate[field] !== plan[field]) {
      throw new Error(
        `Candidate identity does not match release plan: ${field}.`,
      );
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function parseArgs(args: readonly string[]): AcceptanceArguments {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith('--')) {
      throw new Error(`Unexpected argument: ${name}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} requires a value.`);
    }
    parsed[name.slice(2)] = value;
    index += 1;
  }
  return parsed as AcceptanceArguments;
}

function localCandidateIdentity(value: unknown): CandidateIdentity {
  if (!isRecord(value)) {
    throw new Error('candidate.json must be a JSON object.');
  }
  const files = value.files;
  if (
    value.schemaVersion !== 1 ||
    !SHA256_PATTERN.test(String(value.candidateId ?? '')) ||
    !COMMIT_SHA_PATTERN.test(String(value.commitSha ?? '')) ||
    typeof value.version !== 'string' ||
    typeof value.tag !== 'string' ||
    typeof value.repository !== 'string' ||
    value.distributionProfile !== LOCAL_NONPUBLISHABLE_PROFILE ||
    value.publishable !== false ||
    !Array.isArray(files) ||
    !files.every((item) => typeof item === 'string')
  ) {
    throw new Error(
      'Install acceptance requires a valid local_nonpublishable candidate identity.',
    );
  }
  return {
    schemaVersion: 1,
    candidateId: String(value.candidateId).toLowerCase(),
    version: value.version,
    tag: value.tag,
    repository: value.repository,
    commitSha: String(value.commitSha).toLowerCase(),
    distributionProfile: LOCAL_NONPUBLISHABLE_PROFILE,
    publishable: false,
    files,
  };
}

async function verifiedCandidateFile(
  candidateRoot: string,
  candidate: CandidateIdentity,
  relativePath: string,
): Promise<string> {
  const prefix = `${relativePath}:`;
  const identities = candidate.files.filter((identity) =>
    identity.startsWith(prefix),
  );
  if (identities.length !== 1) {
    throw new Error(`Candidate must declare exactly one ${relativePath}.`);
  }
  const expectedSha256 = identities[0].slice(prefix.length).toLowerCase();
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error(`Candidate ${relativePath} digest is invalid.`);
  }
  const path = safeCandidateFile(candidateRoot, relativePath);
  if ((await sha256File(path)) !== expectedSha256) {
    throw new Error(`Candidate ${relativePath} digest does not match.`);
  }
  return expectedSha256;
}

function safeCandidateFile(
  candidateRoot: string,
  relativePath: string,
): string {
  if (
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    relativePath
      .split('/')
      .some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`Candidate file path is unsafe: ${relativePath}.`);
  }
  const path = safeExistingFile(
    resolve(candidateRoot, ...relativePath.split('/')),
    `Candidate file ${relativePath}`,
  );
  requireStrictDescendant(
    path,
    candidateRoot,
    `Candidate file ${relativePath}`,
  );
  return path;
}

function safeExistingDirectory(path: string, label: string): string {
  if (
    !pathEntryExists(path) ||
    lstatSync(path).isSymbolicLink() ||
    !statSync(path).isDirectory()
  ) {
    throw new Error(`${label} must be an existing non-symlink directory.`);
  }
  return realpathSync(path);
}

function safeExistingFile(path: string, label: string): string {
  const resolvedPath = resolve(path);
  if (
    !pathEntryExists(resolvedPath) ||
    lstatSync(resolvedPath).isSymbolicLink() ||
    !statSync(resolvedPath).isFile()
  ) {
    throw new Error(`${label} must be an existing non-symlink file.`);
  }
  return realpathSync(resolvedPath);
}

function assertSafeNewOutputRoot(
  workspaceRoot: string,
  outputRoot: string,
): void {
  const allowedParent = resolve(workspaceRoot, 'tmp', 'cert-prep-desktop');
  requireStrictDescendant(
    outputRoot,
    allowedParent,
    'Install acceptance output',
  );
  if (pathEntryExists(outputRoot)) {
    throw new Error(`Install acceptance output already exists: ${outputRoot}.`);
  }
  assertExistingAncestorsAreDirectories(workspaceRoot, outputRoot);
}

function assertExistingAncestorsAreDirectories(
  workspaceRoot: string,
  targetPath: string,
): void {
  const parts = relative(workspaceRoot, targetPath).split(sep).filter(Boolean);
  let current = workspaceRoot;
  for (const part of parts) {
    current = join(current, part);
    if (!pathEntryExists(current)) return;
    if (
      lstatSync(current).isSymbolicLink() ||
      !statSync(current).isDirectory()
    ) {
      throw new Error(
        `Install acceptance output ancestor is not a regular directory: ${current}.`,
      );
    }
  }
}

function requireStrictDescendant(
  candidatePath: string,
  parentPath: string,
  label: string,
): void {
  const child = resolve(candidatePath);
  const parent = resolve(parentPath);
  const childRelative = relative(parent, child);
  if (
    !childRelative ||
    childRelative === '..' ||
    childRelative.startsWith(`..${sep}`) ||
    isAbsolute(childRelative)
  ) {
    throw new Error(`${label} must stay under ${parent}.`);
  }
}

export function knownCertPrepInstallRoots(
  environment: Readonly<NodeJS.ProcessEnv>,
): string[] {
  const roots = [
    environment.LOCALAPPDATA
      ? join(environment.LOCALAPPDATA, PRODUCT_NAME)
      : undefined,
    environment.LOCALAPPDATA
      ? join(environment.LOCALAPPDATA, 'Programs', PRODUCT_NAME)
      : undefined,
    environment.ProgramFiles
      ? join(environment.ProgramFiles, PRODUCT_NAME)
      : undefined,
    environment['ProgramFiles(x86)']
      ? join(environment['ProgramFiles(x86)'], PRODUCT_NAME)
      : undefined,
  ].filter((path): path is string => path !== undefined);
  return [...new Set(roots.map((path) => resolve(path)))];
}

function parseBooleanArgument(
  value: string | undefined,
  name: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function assertAllowedArguments(args: AcceptanceArguments): void {
  const allowed = new Set([
    'workspace-root',
    'candidate-root',
    'output-root',
    'install-root',
    'acceptance-run-id',
    'dry-run',
  ]);
  const unexpected = Object.keys(args).filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected local install acceptance arguments: ${unexpected.join(', ')}.`,
    );
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function unquotePath(value: string): string {
  const trimmed = String(value ?? '').trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function main() {
  const result = await runLocalInstallAcceptance(
    parseArgs(process.argv.slice(2)) as AcceptanceArguments,
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
