import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.js'],
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
