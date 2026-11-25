/** Replace secrets before a line is printed or written. Short values are left alone so they cannot erase ordinary words. */

const MINIMUM_SECRET_LENGTH = 8;

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < MINIMUM_SECRET_LENGTH) continue;
    redacted = redacted.split(secret).join('[token]');
  }
  return redacted;
}
