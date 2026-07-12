import { join, resolve } from 'node:path';

/** Resolves the isolated app-data directory; smoke never pre-seeds runtimes. */
export function packagedAppDataDir(overrideValue?: string): string {
  if (overrideValue?.trim()) {
    return resolve(overrideValue);
  }

  const override = process.env.CERT_PREP_PACKAGE_SMOKE_APP_DATA_DIR?.trim();
  if (override) {
    return resolve(override);
  }

  const appData = process.env.APPDATA?.trim();
  if (!appData) {
    throw new Error('APPDATA is required to run packaged smoke.');
  }
  return join(appData, 'dev.certprep.cert-prep');
}
