import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Hosted Windows runners can expose TEMP through an 8.3 path alias such as RUNNER~1.
const canonicalTempDirectory = realpathSync.native(tmpdir());

process.env.TEMP = canonicalTempDirectory;
process.env.TMP = canonicalTempDirectory;
process.env.TMPDIR = canonicalTempDirectory;
