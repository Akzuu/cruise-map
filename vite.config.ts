import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: 'localhost', port: 5173, open: false },
  build: { chunkSizeWarningLimit: 1500 },
  test: { include: ['tests/**/*.test.ts'] },
});
