import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'eslint/**/*.test.mjs'],
    // The browser tests run with pnpm test:e2e, after a build.
    exclude: ['test/e2e/**', 'node_modules/**', 'dist/**'],
    // Clock times are local; a fixed zone that is not UTC pins them and catches UTC slips.
    env: { TZ: 'Europe/Paris' },
  },
});
