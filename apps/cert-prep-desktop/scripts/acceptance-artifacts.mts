import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export interface AcceptanceRun {
  readonly project: string;
  readonly runId: string;
  readonly artifactRoot: string;
  readonly recordVideo: boolean;
}

export function createAcceptanceRun(
  environment: NodeJS.ProcessEnv,
  project: string,
  workspaceRoot: string,
): AcceptanceRun {
  const runId = environment.E2E_ACCEPTANCE_RUN_ID?.trim();
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(runId)) {
    throw new Error('E2E_ACCEPTANCE_RUN_ID must be a safe non-empty run ID.');
  }
  const video = environment.E2E_RECORD_VIDEO?.trim() ?? '0';
  if (!['0', '1'].includes(video))
    throw new Error('E2E_RECORD_VIDEO must be 0 or 1.');
  const projectRoot = resolve(workspaceRoot, 'output', 'playwright', project);
  const artifactRoot = resolve(
    environment.E2E_ARTIFACT_ROOT?.trim() || resolve(projectRoot, runId),
  );
  const relativeArtifactRoot = relative(projectRoot, artifactRoot);
  if (
    relativeArtifactRoot !== runId ||
    relativeArtifactRoot === '..' ||
    relativeArtifactRoot.startsWith(`..${sep}`) ||
    /^[A-Za-z]:/u.test(relativeArtifactRoot)
  ) {
    throw new Error(
      'E2E_ARTIFACT_ROOT must equal output/playwright/<project>/<run-id>.',
    );
  }
  return {
    project,
    runId,
    recordVideo: video === '1',
    artifactRoot,
  };
}

export async function assertWebmArtifact(filePath: string): Promise<void> {
  const metadata = await stat(filePath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size === 0)
    throw new Error('Acceptance video is empty or missing.');
  const header = (await readFile(filePath)).subarray(0, 4);
  if (!header.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    throw new Error('Acceptance video is not WebM/EBML.');
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

export async function writeAcceptanceManifest(
  artifactRoot: string,
  input: {
    project: string;
    runId: string;
    status: 'completed' | 'failed';
    recordVideo: boolean;
    artifacts: readonly { path: string; kind: string }[];
    errors: readonly string[];
    consoleErrors: readonly string[];
    pageErrors: readonly string[];
    cleanup: Record<string, boolean>;
    fixture?: { name: string; sha256: string };
    fixtures?: Record<string, unknown>;
  },
): Promise<string> {
  await mkdir(artifactRoot, { recursive: true });
  const resolvedArtifactRoot = resolve(artifactRoot);
  const artifacts = [];
  for (const item of input.artifacts) {
    const absolutePath = resolve(item.path);
    const relativePath = relative(resolvedArtifactRoot, absolutePath);
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      /^[A-Za-z]:/u.test(relativePath)
    ) {
      throw new Error('Acceptance artifact escaped its isolated output root.');
    }
    const inputMetadata = await stat(absolutePath).catch(() => undefined);
    if (!inputMetadata?.isFile())
      throw new Error(`Acceptance artifact missing: ${redact(absolutePath)}`);
    if (item.kind === 'trace' || item.kind === 'report')
      sanitizeAcceptanceArchive(absolutePath);
    await sanitizeTextArtifact(absolutePath);
    const metadata = await stat(absolutePath).catch(() => undefined);
    if (!metadata?.isFile())
      throw new Error(`Acceptance artifact missing: ${redact(absolutePath)}`);
    artifacts.push({
      path: relativePath.split(sep).join('/'),
      kind: item.kind,
      bytes: metadata.size,
      sha256: await sha256File(absolutePath),
    });
  }
  const result = {
    schemaVersion: 1,
    project: input.project,
    runId: input.runId,
    status: input.status,
    recordVideo: input.recordVideo,
    artifacts,
    errors: input.errors.map(redact),
    consoleErrors: input.consoleErrors.map(redact),
    pageErrors: input.pageErrors.map(redact),
    cleanup: input.cleanup,
    fixture: input.fixture,
    fixtures: input.fixtures,
  };
  const path = resolve(artifactRoot, 'acceptance-manifest.json');
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return path;
}

function sanitizeAcceptanceArchive(filePath: string): void {
  if (!filePath.toLowerCase().endsWith('.zip')) return;
  const script = String.raw`
import os
import json
import re
import sys
import tempfile
import time
import zipfile

path = sys.argv[1]
bearer = re.compile(r'''Bearer\s+("[^"]*"|'[^']*'|[^\s,;}\]"']+)''', re.IGNORECASE)
credential = re.compile(r'''((?:"?(?:authorization|token|secret|password)"?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,;}"'\]]+)''', re.IGNORECASE)
windows_path = re.compile(r'''[A-Za-z]:[\\/][^"'<>\r\n]+''')
unix_path = re.compile(r'''/(?:Users|private|home|tmp|var|workspace|software-dev)/[^"'<>\r\n]+''', re.IGNORECASE)

def redacted_value(value):
    if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
        return value[0] + '<redacted>' + value[0]
    return '<redacted>'

def redact(value):
    value = bearer.sub(lambda match: 'Bearer ' + redacted_value(match.group(1)), value)
    value = credential.sub(lambda match: match.group(1) + redacted_value(match.group(2)), value)
    value = windows_path.sub('<private-path>', value)
    return unix_path.sub('<private-path>', value)

def sensitive_key(key):
    return re.search(r'(?:authorization|token|secret|password|api[_-]?key|private[_-]?key)', key, re.IGNORECASE) is not None

def redact_object(value, key=None):
    if key is not None and sensitive_key(key):
        return '<redacted>'
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [redact_object(item) for item in value]
    if isinstance(value, dict):
        return {key: redact_object(item, key) for key, item in value.items()}
    return value

def scrub(payload, name):
    try:
        text = payload.decode('utf-8')
    except UnicodeDecodeError:
        return payload
    try:
        return json.dumps(redact_object(json.loads(text)), ensure_ascii=False, indent=2).encode('utf-8')
    except (TypeError, ValueError, json.JSONDecodeError):
        pass
    if name.lower().endswith(('.jsonl', '.ndjson')):
        lines = []
        parsed_any = False
        for line in text.splitlines(keepends=True):
            if not line.strip():
                lines.append(line)
                continue
            try:
                lines.append(json.dumps(redact_object(json.loads(line)), ensure_ascii=False) + ('\n' if line.endswith('\n') else ''))
                parsed_any = True
            except (TypeError, ValueError, json.JSONDecodeError):
                lines.append(redact(line))
        if parsed_any:
            return ''.join(lines).encode('utf-8')
    return redact(text).encode('utf-8')

with zipfile.ZipFile(path, 'r') as source:
    entries = [(info, scrub(source.read(info), info.filename)) for info in source.infolist()]
fd, temporary = tempfile.mkstemp(prefix='acceptance-redacted-', suffix='.zip', dir=os.path.dirname(path))
os.close(fd)
try:
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as target:
        for info, payload in entries:
            target.writestr(info, payload)
    for attempt in range(10):
        try:
            os.replace(temporary, path)
            break
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.25)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
`;
  const commands: readonly [string, readonly string[]][] =
    process.platform === 'win32'
      ? [
          ['py', ['-3', '-c', script, filePath]],
          ['python', ['-c', script, filePath]],
        ]
      : [
          ['python3', ['-c', script, filePath]],
          ['python', ['-c', script, filePath]],
        ];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status === 0) return;
  }
  throw new Error(
    `Acceptance ZIP artifact could not be sanitized: ${redact(filePath)}`,
  );
}

async function sanitizeTextArtifact(filePath: string): Promise<void> {
  if (!/\.(?:html|json|jsonl|log|md|txt)$/iu.test(filePath)) return;
  const value = await readFile(filePath, 'utf8');
  if (filePath.toLowerCase().endsWith('.json')) {
    try {
      await writeFile(
        filePath,
        `${JSON.stringify(redactStructuredValue(JSON.parse(value)), null, 2)}\n`,
        'utf8',
      );
      return;
    } catch {
      // Fall through to text redaction for malformed diagnostic output.
    }
  }
  if (filePath.toLowerCase().endsWith('.jsonl')) {
    const lines = value.split(/\r?\n/u).map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(redactStructuredValue(JSON.parse(line)));
      } catch {
        return redact(line);
      }
    });
    await writeFile(filePath, lines.join('\n'), 'utf8');
    return;
  }
  await writeFile(filePath, redact(value), 'utf8');
}

function redactStructuredValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return '<redacted>';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value))
    return value.map((item) => redactStructuredValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nested]) => [
        nestedKey,
        redactStructuredValue(nested, nestedKey),
      ]),
    );
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|token|secret|password|api[_-]?key|private[_-]?key)/iu.test(
    key,
  );
}

export async function collectAcceptanceArtifactInputs(
  artifactRoot: string,
): Promise<readonly { path: string; kind: string }[]> {
  const entries = await readdir(artifactRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const artifacts: { path: string; kind: string }[] = [];
  for (const entry of entries) {
    if (entry.name === 'acceptance-manifest.json') continue;
    const path = resolve(artifactRoot, entry.name);
    if (entry.isDirectory()) {
      // A failed cleanup must never publish app data or packaged runtime
      // state as acceptance evidence. The manifest still records cleanup=false.
      if (entry.name === 'app-data' || entry.name === 'runtime') continue;
      artifacts.push(...(await collectAcceptanceArtifactInputs(path)));
    } else if (entry.isFile() && isPublishableArtifact(path)) {
      artifacts.push({ path, kind: artifactKind(path) });
    }
  }
  return artifacts;
}

function isPublishableArtifact(path: string): boolean {
  return /\.(?:html|json|jsonl|log|md|png|txt|webm|zip)$/iu.test(path);
}

function artifactKind(path: string): string {
  if (path.endsWith('.webm')) return 'video';
  if (path.endsWith('.png')) return 'screenshot';
  if (path.endsWith('.zip')) return 'trace';
  if (path.endsWith('.html') || path.endsWith('.md')) return 'report';
  if (
    path.endsWith('.log') ||
    path.endsWith('.json') ||
    path.endsWith('.jsonl')
  )
    return 'log';
  return 'other';
}

export function redact(value: string): string {
  return value
    .replace(
      /Bearer\s+("[^"]*"|'[^']*'|[^\s,;}\]"']+)/giu,
      (_match: string, secret: string) =>
        `Bearer ${redactDelimitedValue(secret)}`,
    )
    .replace(
      /((?:"?(?:authorization|token|secret|password)"?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,;}"'\]]+)/giu,
      (_match: string, prefix: string, secret: string) =>
        `${prefix}${redactDelimitedValue(secret)}`,
    )
    .replace(/[A-Za-z]:[\\/][^"'<>\r\n]+/gu, '<private-path>')
    .replace(
      /\/(?:Users|private|home|tmp|var|workspace|software-dev)\/[^"'<>\r\n]+/giu,
      '<private-path>',
    );
}

function redactDelimitedValue(value: string): string {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.at(-1) === quote
    ? `${quote}<redacted>${quote}`
    : '<redacted>';
}
