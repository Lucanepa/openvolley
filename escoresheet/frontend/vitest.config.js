import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.js'],
    // A whole screen drawn and driven through its writes runs past the
    // default 5 s with the machine loaded. Every wait ends on the screen or
    // the database (setup.js: 10 s each), so only a stuck test runs this long.
    testTimeout: 30000,
    // A hook waits on an import or a database clear, not on a timer: past the
    // default 10 s only with the machine loaded (OpenBeach, 2026-10-08)
    hookTimeout: 30000,
    include: ['src/**/*.test.{js,jsx}', 'scoresheet_pdf/**/*.test.{ts,tsx}'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/utils/**', 'src/hooks/**']
    }
  },
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test')
  }
})
