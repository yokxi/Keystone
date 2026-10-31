import { defineConfig } from 'vitest/config';

// Suite dell'interfaccia (Playwright + Electron): solo i comportamenti di sicurezza.
export default defineConfig({
  test: {
    include: ['app/e2e/**/*.e2e.ts'],
    globalSetup: ['app/e2e/global-setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
