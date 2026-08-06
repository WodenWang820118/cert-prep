import { spawn } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '..');
const packageJsonPath = join(repoRoot, 'package.json');
const lockfilePath = join(repoRoot, 'pnpm-lock.yaml');
const workspaceFilePath = join(repoRoot, 'pnpm-workspace.yaml');
const nodeModulesLockfilePath = join(
  repoRoot,
  'node_modules',
  '.pnpm',
  'lock.yaml',
);
const workbenchPackageName = '@gx-capture/capture-workbench';
const contractsPackageName = '@gx-capture/capture-contracts';

type InstallMode =
  | { readonly kind: 'prepublication'; readonly stableVersion: string }
  | { readonly kind: 'candidate'; readonly packageDirectory: string };

function argumentValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parseMode(args: readonly string[]): InstallMode {
  const stableVersion = argumentValue(args, '--prepublication-stable-version');
  const packageDirectory = argumentValue(args, '--candidate-package-dir');
  if ((stableVersion === null) === (packageDirectory === null)) {
    throw new Error(
      'Specify exactly one of --prepublication-stable-version or --candidate-package-dir.',
    );
  }
  if (stableVersion !== null) {
    if (!/^\d+\.\d+\.\d+$/u.test(stableVersion)) {
      throw new Error('The pre-publication stable version must be SemVer.');
    }
    return { kind: 'prepublication', stableVersion };
  }
  return {
    kind: 'candidate',
    packageDirectory: resolve(repoRoot, packageDirectory!),
  };
}

async function runPnpm(args: readonly string[]): Promise<void> {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `pnpm ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`,
        ),
      );
    });
  });
}

function packageArchive(
  packageDirectory: string,
  packageName: string,
  version: string,
): string {
  const expected = `${packageName.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
  const path = resolve(packageDirectory, expected);
  if (!isAbsolute(path) || basename(path) !== expected) {
    throw new Error(`Invalid candidate package path for ${packageName}.`);
  }
  return path;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

function setWorkbenchDependency(
  packageJson: Record<string, unknown>,
  value: string,
): void {
  const dependencies = packageJson.dependencies;
  if (!dependencies || typeof dependencies !== 'object') {
    throw new Error('package.json dependencies are missing.');
  }
  (dependencies as Record<string, unknown>)[workbenchPackageName] = value;
}

async function install(mode: InstallMode): Promise<void> {
  const originalPackageJson = await readFile(packageJsonPath);
  const originalLockfile = await readFile(lockfilePath);
  const originalWorkspaceFile = await readFile(workspaceFilePath);
  let originalNodeModulesLockfile: Buffer | null = null;
  const preserveInstallFiles =
    process.env.CAPTURE_PRESERVE_INSTALL_FILES === 'true';
  try {
    const packageJson = JSON.parse(originalPackageJson.toString('utf8')) as Record<
      string,
      unknown
    >;
    if (mode.kind === 'prepublication') {
      if (process.env.CAPTURE_PUBLISHED_0_3_11 === 'true') {
        await runPnpm(['install', '--frozen-lockfile']);
        return;
      }
      const stablePackageJson = { ...packageJson };
      setWorkbenchDependency(stablePackageJson, mode.stableVersion);
      await writeFile(
        packageJsonPath,
        `${JSON.stringify(stablePackageJson, null, 2)}\n`,
        'utf8',
      );
      await writeFile(lockfilePath, originalLockfile);
      process.stdout.write(
        `Resolving pre-publication CI dependencies with ${workbenchPackageName}@${mode.stableVersion}; candidate gates install immutable candidate bytes separately.\n`,
      );
      await runPnpm(['install', '--no-frozen-lockfile', '--ignore-scripts']);
      return;
    }

    const manifest = await readJson(
      join(mode.packageDirectory, 'package.json'),
    ).catch(() => null);
    if (manifest !== null) {
      throw new Error(
        'The candidate package directory must contain archives, not a package manifest.',
      );
    }
    const workbenchArchive = packageArchive(
      mode.packageDirectory,
      workbenchPackageName,
      process.env.RELEASE_VERSION ?? '0.3.11',
    );
    const contractsArchive = packageArchive(
      mode.packageDirectory,
      contractsPackageName,
      process.env.RELEASE_VERSION ?? '0.3.11',
    );
    const candidatePackageJson = { ...packageJson };
    const workbenchOverride = workbenchArchive.replaceAll('\\', '/');
    setWorkbenchDependency(candidatePackageJson, `file:${workbenchOverride}`);
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(candidatePackageJson, null, 2)}\n`,
      'utf8',
    );
    const contractsOverride = contractsArchive.replaceAll('\\', '/');
    await writeFile(
      workspaceFilePath,
      `${originalWorkspaceFile.toString('utf8').trimEnd()}\noverrides:\n  '${contractsPackageName}': file:${contractsOverride}\n`,
      'utf8',
    );
    await unlink(lockfilePath);
    try {
      originalNodeModulesLockfile = await readFile(nodeModulesLockfilePath);
      await unlink(nodeModulesLockfilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    process.stdout.write(
      `Installing ${workbenchPackageName} and ${contractsPackageName} from the immutable candidate archives.\n`,
    );
    await runPnpm([
      'install',
      '--no-frozen-lockfile',
      '--lockfile=false',
      '--ignore-scripts',
    ]);
  } finally {
    if (!preserveInstallFiles) {
      await writeFile(packageJsonPath, originalPackageJson);
      await writeFile(lockfilePath, originalLockfile);
      await writeFile(workspaceFilePath, originalWorkspaceFile);
      if (originalNodeModulesLockfile !== null) {
        await writeFile(nodeModulesLockfilePath, originalNodeModulesLockfile);
      }
    }
  }
}

async function main(): Promise<void> {
  await install(parseMode(process.argv.slice(2)));
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
