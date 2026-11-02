/**
 * Pick the most specific user-facing text from an HTTP-style error: the API
 * body's message, then a plain-string body, then the error's own message.
 */
export function requestErrorMessage(error: unknown, fallback: string): string {
  const httpError = error as { error?: unknown; message?: unknown };
  if (hasMessage(httpError.error)) {
    return httpError.error.message;
  }

  if (typeof httpError.error === 'string' && httpError.error.length > 0) {
    return httpError.error;
  }

  if (typeof httpError.message === 'string' && httpError.message.length > 0) {
    return httpError.message;
  }

  return fallback;
}

function hasMessage(value: unknown): value is { message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}
