const LABELED_SECRET =
  /(?<![A-Za-z0-9_-])((?:--)?(?:authorization|access[_-]?token|refresh[_-]?token|token|secret|password|api[_-]?key))\b\s*(?::|=|\s)\s*(?:Bearer\s+)?[^\s"'`;,)\]}>]+/gi;
const BEARER_SECRET = /\bBearer\s+[^\s"'`;,)\]}>]+/gi;
const HTTP_URL = /https?:\/\/[^\s"'<>]+/gi;

export function redactCaptureEvidence(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(LABELED_SECRET, '$1=[REDACTED]')
      .replace(BEARER_SECRET, 'Bearer [REDACTED]')
      .replace(HTTP_URL, '[REDACTED_URL]');
  }
  if (Array.isArray(value)) {
    return value.map(redactCaptureEvidence);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitiveEvidenceKey(key))
      .map(([key, item]) => [key, redactCaptureEvidence(item)]),
  );
}

function isSensitiveEvidenceKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
  return (
    normalized.includes('authorization') ||
    normalized.includes('credential') ||
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.endsWith('token') ||
    normalized === 'url' ||
    normalized.endsWith('baseurl') ||
    normalized === 'sourcetext' ||
    normalized === 'targettext'
  );
}
