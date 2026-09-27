import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import {
  collectProcessTree,
  snapshotWindowsProcesses,
  terminateProcessTreeByPid,
  type ProcessRecord,
} from '../apps/cert-prep-desktop/scripts/process-lifecycle/processes.mts';

const DEFAULT_TREE_EXIT_TIMEOUT_MS = 10_000;
const TREE_EXIT_POLL_INTERVAL_MS = 50;

export interface ProjectionProcessCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ProjectionInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: false;
  readonly windowsHide: true;
}

export interface ProjectionInvocationResolutionOptions {
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
  readonly path?: string;
  readonly corepackScript?: string;
}

interface ProjectionProcessDependencies {
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly snapshot: () => readonly ProcessRecord[];
  readonly terminateTree: (pid: number) => { readonly attempted: boolean; readonly error: string | null };
  readonly platform: NodeJS.Platform;
  readonly delay: (durationMs: number) => Promise<void>;
  readonly treeExitTimeoutMs: number;
}

interface OwnedProjectionProcess {
  readonly child: ChildProcess;
  readonly pid: number | null;
}

function findCorepackScript(
  executablePath: string,
  pathValue: string,
): string | undefined {
  const pathEntries = pathValue
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const executableDirectory = dirname(executablePath);
  const candidateDirectories = [
    ...pathEntries,
    executableDirectory,
  ];
  const seen = new Set<string>();
  for (const directory of candidateDirectories) {
    const normalized = directory.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const shim = join(directory, 'corepack.cmd');
    const script = join(directory, 'node_modules', 'corepack', 'dist', 'corepack.js');
    if (existsSync(shim) && existsSync(script)) return script;
  }
  return undefined;
}

/**
 * Resolves a projection command without asking a shell to interpret it.
 * Windows cmd shims cannot be spawned with shell:false on this Node host, so
 * the Corepack shim is resolved to its actual Node entrypoint and its args are
 * retained as separate argv entries.
 */
export function resolveProjectionInvocation(
  command: string,
  args: readonly string[],
  options: ProjectionInvocationResolutionOptions = {},
): ProjectionInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || !/^corepack(?:\.cmd)?$/iu.test(command.split(/[\\/]/u).pop() ?? '')) {
    return { command, args: [...args], shell: false, windowsHide: true };
  }

  const executablePath = options.execPath ?? process.execPath;
  const corepackScript =
    options.corepackScript ??
    findCorepackScript(
      executablePath,
      options.path ?? process.env.Path ?? process.env.PATH ?? '',
    );
  if (!corepackScript) {
    throw new Error('Corepack launcher could not be resolved for a shell-free projection command.');
  }
  return {
    command: executablePath,
    args: [corepackScript, ...args],
    shell: false,
    windowsHide: true,
  };
}

function processTreePids(
  processes: readonly ProcessRecord[],
  rootPid: number,
): readonly number[] {
  return collectProcessTree(processes, rootPid).map(({ pid }) => pid);
}

function processIsExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function createDefaultDependencies(): ProjectionProcessDependencies {
  return {
    spawn: (command, args, options) => spawn(command, [...args], options),
    snapshot: snapshotWindowsProcesses,
    terminateTree: (pid) => {
      const result = terminateProcessTreeByPid(pid);
      return { attempted: result.attempted, error: result.error };
    },
    platform: process.platform,
    delay: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
    treeExitTimeoutMs: DEFAULT_TREE_EXIT_TIMEOUT_MS,
  };
}

/** Owns projection build-tool roots and their descendants for scoped cleanup. */
export class OwnedProjectionProcessManager {
  private readonly dependencies: ProjectionProcessDependencies;
  private readonly processes = new Set<OwnedProjectionProcess>();
  private cleanupPromise: Promise<number> | null = null;

  constructor(
    dependencies: Partial<ProjectionProcessDependencies> = {},
  ) {
    this.dependencies = { ...createDefaultDependencies(), ...dependencies };
  }

  run(command: ProjectionProcessCommand): Promise<void> {
    if (this.cleanupPromise) {
      return Promise.reject(new Error('Projection process cleanup is already in progress.'));
    }
    const invocation = resolveProjectionInvocation(command.command, command.args, {
      platform: this.dependencies.platform,
    });
    let child: ChildProcess;
    try {
      child = this.dependencies.spawn(invocation.command, invocation.args, {
        cwd: command.cwd,
        env: {
          ...process.env,
          ...command.env,
          CI: '1',
          NO_COLOR: '1',
          UV_NO_PROGRESS: '1',
          CARGO_TERM_COLOR: 'never',
        },
        shell: invocation.shell,
        windowsHide: invocation.windowsHide,
        detached: this.dependencies.platform !== 'win32',
        stdio: 'ignore',
      });
    } catch {
      throw new Error('Projection build-tool command could not start.');
    }

    const owned: OwnedProjectionProcess = { child, pid: child.pid ?? null };
    this.processes.add(owned);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      child.once('error', () => {
        if (settled) return;
        settled = true;
        reject(new Error('Projection build-tool command could not start.'));
      });
      child.once('close', (status, signal) => {
        if (settled) return;
        settled = true;
        if (status !== 0) {
          reject(
            new Error(
              `Projection build-tool command failed with status ${String(status)}${
                signal ? ' after a signal' : ''
              }.`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  }

  async closeOwnedProcesses(): Promise<number> {
    if (this.cleanupPromise) return this.cleanupPromise;
    const owned = [...this.processes];
    const cleanup = Promise.all(owned.map((process) => this.cleanupProcess(process))).then(
      () => owned.length,
    );
    this.cleanupPromise = cleanup;
    try {
      return await cleanup;
    } finally {
      for (const process of owned) this.processes.delete(process);
      if (this.cleanupPromise === cleanup) this.cleanupPromise = null;
    }
  }

  private async cleanupProcess(owned: OwnedProjectionProcess): Promise<void> {
    const { child, pid } = owned;
    if (pid === null) return;

    let knownPids: Set<number> = new Set([pid]);
    if (this.dependencies.platform === 'win32') {
      knownPids = new Set(processTreePids(this.dependencies.snapshot(), pid));
      knownPids.add(pid);
      if (!processIsExited(child) || knownPids.size > 1) {
        this.dependencies.terminateTree(pid);
        for (const descendantPid of [...knownPids].filter((candidate) => candidate !== pid).reverse()) {
          this.dependencies.terminateTree(descendantPid);
        }
      }
    } else if (!processIsExited(child)) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          // The root already exited.
        }
      }
    }

    await this.waitForOwnedTreeExit(child, knownPids);
  }

  private async waitForOwnedTreeExit(
    child: ChildProcess,
    knownPids: ReadonlySet<number>,
  ): Promise<void> {
    const deadline = Date.now() + this.dependencies.treeExitTimeoutMs;
    while (Date.now() <= deadline) {
      if (this.dependencies.platform === 'win32') {
        const remaining = this.dependencies.snapshot().some(({ pid }) => knownPids.has(pid));
        if (!remaining && processIsExited(child)) return;
      } else if (processIsExited(child)) {
        return;
      }
      await this.dependencies.delay(TREE_EXIT_POLL_INTERVAL_MS);
    }
    throw new Error('Owned projection process tree did not exit after cleanup.');
  }
}
