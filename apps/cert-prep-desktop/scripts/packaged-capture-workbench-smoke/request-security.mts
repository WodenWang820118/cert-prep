export interface BrowserRequestOrigins {
  readonly appOrigin: string;
  readonly backendOrigin: string;
  readonly expectedBackendAuthorization: string;
}

export interface BrowserRequestSnapshot {
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export type BrowserRequestViolation =
  | 'backend_authorization_mismatch'
  | 'invalid_request_url'
  | 'non_backend_authorization_header'
  | 'non_backend_loopback_request';

/** Rejects inherited switches that would bypass the user-visible acceptance flow. */
export function assertSafePackagedCaptureEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): void {
  const normalized = new Map(
    Object.entries(environment).map(([name, value]) => [
      name.toLowerCase(),
      value?.trim() ?? '',
    ]),
  );
  if ((normalized.get('capture_extraction_provider') ?? '').length > 0) {
    throw new Error(
      'Packaged Capture Workbench smoke refuses an ambient extraction override.',
    );
  }
  if (
    /^(?:1|true|yes)$/i.test(
      normalized.get(
        'cert_prep_package_qa_auto_install_bundled_backend',
      ) ?? '',
    )
  ) {
    throw new Error(
      'Packaged Capture Workbench smoke requires the visible Python backend consent flow.',
    );
  }
}

/**
 * Keeps the browser on the Tauri-app/Cert-Prep-backend boundary. Backend proxy
 * routes such as `/capture-runtime/ready` are expected and safe; an alternate
 * loopback origin is a direct sidecar request even when its path is `/ready`.
 */
export function browserRequestViolations(
  origins: BrowserRequestOrigins,
  request: BrowserRequestSnapshot,
): BrowserRequestViolation[] {
  const appOrigin = exactOrigin(origins.appOrigin, 'app');
  const backendOrigin = exactOrigin(origins.backendOrigin, 'backend');
  if (!/^Bearer\s+\S+$/.test(origins.expectedBackendAuthorization)) {
    throw new Error(
      'Packaged smoke expected backend authorization is invalid.',
    );
  }
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    return ['invalid_request_url'];
  }

  if (target.origin === backendOrigin) {
    const authorizations = authorizationHeaders(request.headers);
    return authorizations.some(
      (authorization) =>
        authorization !== origins.expectedBackendAuthorization,
    )
      ? ['backend_authorization_mismatch']
      : [];
  }

  const violations: BrowserRequestViolation[] = [];
  if (hasAuthorizationHeader(request.headers)) {
    violations.push('non_backend_authorization_header');
  }
  if (
    target.origin !== appOrigin &&
    (target.protocol === 'http:' || target.protocol === 'https:') &&
    isLoopbackHostname(target.hostname)
  ) {
    violations.push('non_backend_loopback_request');
  }
  return violations;
}

function exactOrigin(value: string, label: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.origin === 'null') {
      throw new Error('opaque origin');
    }
    return parsed.origin;
  } catch {
    throw new Error(`Packaged smoke ${label} origin is invalid.`);
  }
}

function hasAuthorizationHeader(
  headers: Readonly<Record<string, string | undefined>>,
): boolean {
  return authorizationHeaders(headers).length > 0;
}

function authorizationHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(headers)
    .filter(
      ([name, value]) =>
        name.toLowerCase() === 'authorization' &&
        typeof value === 'string' &&
        value.trim().length > 0,
    )
    .map(([, value]) => value as string);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.startsWith('127.')
  );
}
