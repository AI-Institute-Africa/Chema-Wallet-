import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import chema from './tools/eslint-plugin-chema/index.js';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    plugins: { chema },
    rules: {
      'chema/no-number-money': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|floor|ceil)$/]",
          message: 'No float rounding near money; use bigint minor units.',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat is banned; amounts are bigint minor units (parseMinor).',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
