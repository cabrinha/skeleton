import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Source uses NodeNext ESM, so internal imports carry a `.js` suffix that must
  // resolve to the `.ts` file on disk when Vitest loads them.
  resolve: {
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // config.ts throws unless credentials are present; supply dummies for tests.
    env: {
      VAMPIRE_NAME: 'TestVamp',
      VAMPIRE_PASS: 'test-pass',
    },
  },
});
