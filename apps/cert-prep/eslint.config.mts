import nx from '@nx/eslint-plugin';
import sheriff from '@softarc/eslint-plugin-sheriff';
import baseConfig from '../../eslint.config.mts';

export default [
  ...nx.configs['flat/angular'],
  ...nx.configs['flat/angular-template'],
  ...baseConfig,
  {
    files: ['**/*.ts'],
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'app',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'app',
          style: 'kebab-case',
        },
      ],
      // Enabled by the Angular ESLint v22 preset; preserve the Angular v22 migration's
      // explicit Eager strategy rather than changing existing component behavior.
      '@angular-eslint/prefer-on-push-component-change-detection': 'off',
    },
  },
  {
    files: ['**/*.html'],
    // Override or add rules here
    rules: {},
  },
  {
    // Architecture rules (sheriff.config.ts); tests may import any layer.
    ...sheriff.configs.all,
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts', '**/testing/**'],
  },
];
