// @ts-check
const nextConfig = require('eslint-config-next');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

/** @type {import('eslint').Linter.FlatConfig[]} */
const config = [
  // Next.js recommended rules (core-web-vitals + react + react-hooks)
  ...nextConfig,

  // TypeScript source files
  {
    files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-console': 'error',
      'eqeqeq': ['error', 'always'],
    },
  },

  // E2E test files — relax rules that don't apply to test files
  {
    files: ['e2e/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Ignore patterns
  {
    ignores: [
      '.next/**',
      'out/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
];

module.exports = config;
