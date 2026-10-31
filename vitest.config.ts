import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/test/**/*.test.ts', 'orchestrator/test/**/*.test.ts', 'app/test/**/*.test.ts'],
    // git su Windows è lento: margini generosi
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
