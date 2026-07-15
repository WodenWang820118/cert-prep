import playwright from 'eslint-plugin-playwright';
import baseConfig from '../../eslint.config.mts';

const playwrightPlugin = playwright as typeof playwright & {
  readonly configs: Record<string, object>;
};

export default [
  playwrightPlugin.configs['flat/recommended'],
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.js', '**/*.mts'],
    // Override or add rules here
    rules: {},
  },
];
