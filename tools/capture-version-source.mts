/** Parse JSON while rejecting duplicate decoded property names at every object depth. */
export function parseVersionJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const tokens = [
    ...text.matchAll(
      /"(?:\\.|[^"\\])*"|[{}[\]:,]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gu,
    ),
  ];
  const objects: (Set<string> | null)[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index][0];
    if (token === '{') objects.push(new Set());
    else if (token === '[') objects.push(null);
    else if (token === '}' || token === ']') objects.pop();
    else if (token.startsWith('"') && tokens[index + 1]?.[0] === ':') {
      const key: string = JSON.parse(token);
      const owner = objects.at(-1);
      if (!owner || owner.has(key))
        throw new Error(`Duplicate JSON field: ${key}`);
      owner.add(key);
    }
  }
  return parsed;
}

export function assertVersion(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/u.test(
      value,
    )
  ) {
    throw new Error(`Invalid release version: ${String(value)}`);
  }
}

export function readCaptureVersion(text: string): string {
  const parsed = parseVersionJson(text);
  const matches = [...text.matchAll(/"runtimeVersion"\s*:/gu)];
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    matches.length !== 1
  ) {
    throw new Error(
      'Capture adoption source must contain exactly one runtimeVersion field.',
    );
  }
  const version = (parsed as { runtimeVersion?: unknown }).runtimeVersion;
  assertVersion(version);
  return version;
}
