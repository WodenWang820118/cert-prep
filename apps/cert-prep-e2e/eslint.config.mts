import playwright from 'eslint-plugin-playwright';
import baseConfig from '../../eslint.config.mts';

const playwrightPlugin = playwright as typeof playwright & {
  readonly configs: Record<string, object>;
};

export default [
  // Playwright's rules cover the browser specs and their helpers; the
  // node:test unit tests of the real-engine journey use node:assert.
  { ...playwrightPlugin.configs['flat/recommended'], ignores: ['**/*.test.mts'] },
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.js', '**/*.mts'],
    // Override or add rules here
    rules: {},
  },
];
