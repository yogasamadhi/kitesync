import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/.package/**',
      '**/dist/**',
      '**/release/**',
      '**/node_modules/**',
      'vendor/**',
      'coverage/**',
    ],
  },
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
);
