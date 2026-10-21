import { join } from 'node:path';

import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

import { boundaries, boundarySelectors } from './eslint/boundaries.mjs';
import { plugin } from './eslint/layers.mjs';

// The layers of src/ and what each may import: docs/architecture.md. A layer may always import
// its own modules.
const layers = {
  model: { imports: [], node: false },
  util: { imports: [], node: ['node:path'] },
  // The registry, src/adapters/*.ts, lists the adapters.
  adapters: { imports: ['model', 'adapters/*'], node: false },
  // Each adapter, src/adapters/<id>/, a layer of its own: the model and util, not another adapter.
  'adapters/*': { imports: ['model', 'util'], node: true },
  analysis: { imports: ['model', 'util'], node: false },
  report: { imports: ['analysis', 'model', 'util'], node: false },
  conversation: { imports: ['analysis', 'model', 'util'], node: false },
  view: { imports: ['analysis', 'conversation', 'model', 'util'], node: true },
  // The browser client imports only the view's types; esbuild bundles it alone.
  'viewer/client': { imports: [{ layer: 'view', typeOnly: true }], node: false },
  server: { imports: ['view', 'adapters', 'model', 'util'], node: true },
  cli: { imports: '*', node: true },
};
const layerOptions = { srcDir: join(import.meta.dirname, 'src'), layers };

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'local/', '.tmp/']),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-check': false, 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true },
      ],
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // As strict, but numbers read naturally in templates.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowAny: false,
          allowArray: false,
          allowBoolean: false,
          allowNever: false,
          allowNullish: false,
          allowNumber: true,
          allowRegExp: false,
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },

  // Layers: what each directory of src/ may import.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    plugins: { 'agents-tracer': plugin },
    rules: { 'agents-tracer/layers': ['error', layerOptions] },
  },
  // The adapter boundary: no agent's vocabulary outside the adapters (eslint/boundaries.mjs). Each
  // adapter's directory is exempt: its agent may share a word with another's, and the layers rule
  // keeps adapters from importing each other.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/adapters/*/**'],
    rules: { 'no-restricted-syntax': ['error', ...boundarySelectors(boundaries)] },
  },
  // No package reaches src/ through require either.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:module',
              importNames: ['createRequire'],
              message: 'agents-tracer has no runtime dependencies; import modules of src/ or Node built-ins instead.',
            },
          ],
        },
      ],
    },
  },
  // The pure layers compute; reading files and printing is for the layers around them.
  {
    files: ['src/{model,util,analysis,report,conversation}/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': ['error', 'process', 'Buffer', 'console'],
      'no-restricted-properties': [
        'error',
        ...['process', 'Buffer', 'console'].map((property) => ({
          object: 'globalThis',
          property,
          message: 'The pure layers compute; reading files and printing is for the layers around them.',
        })),
      ],
    },
  },
);
