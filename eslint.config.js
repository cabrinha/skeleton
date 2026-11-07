import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Underscore-prefixed args/vars are intentional throwaways (e.g. cheerio
      // `.each((_, el) => …)` where the index is unused).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Tests reach into private methods via a typed cast; allow the looser shapes.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);
