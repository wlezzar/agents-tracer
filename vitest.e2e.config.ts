import { defineConfig } from 'vitest/config';

// The browser tests of pnpm test:e2e, which builds first: they drive the built CLI's viewer in
// Playwright's Chromium.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    env: { TZ: 'Europe/Paris' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One browser at a time.
    fileParallelism: false,
  },
});
