import js from '@eslint/js';
import ts from 'typescript-eslint';

export default [
  { ignores: ['out/**', 'node_modules/**', 'integration/fixture-workspace/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      curly: 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-throw-literal': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    // The integration specs are mocha, inside a VS Code extension host.
    files: ['integration/**/*.js'],
    languageOptions: {
      globals: { describe: 'readonly', it: 'readonly', before: 'readonly', after: 'readonly', beforeEach: 'readonly', afterEach: 'readonly' },
    },
  },
  {
    // The tests are plain CommonJS run by node --test and by mocha.
    files: ['test/**/*.js', 'integration/**/*.js', '*.mjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly', process: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', Buffer: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];
