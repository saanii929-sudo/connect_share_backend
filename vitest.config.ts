import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    // Don't run the Next.js build during tests — mock the heavy modules
    alias: {
      'server-only': path.resolve(__dirname, 'tests/__mocks__/server-only.ts'),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
})
