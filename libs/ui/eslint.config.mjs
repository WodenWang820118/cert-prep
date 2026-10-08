import baseConfig from '../../eslint.config.mts';

export default [
  ...baseConfig,
  {
    // The generated spartan components import each other through their
    // published entry points, as upstream does.
    files: ['**/*.ts'],
    rules: { '@nx/enforce-module-boundaries': 'off' },
  },
];
