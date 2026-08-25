import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/release/**', '**/node_modules/**', 'vendor/**', 'coverage/**'] },
  eslint.configs.recommended,
  { rules: { 'no-undef': 'off' } },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-undef': 'off',
    },
  },
  {
    files: ['apps/desktop/src/main/**/*.cts'],
    rules: {
      // Sandboxed Electron preload entry points must execute as CommonJS.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
