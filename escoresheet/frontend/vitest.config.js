import { defineConfig } from 'vitest/config'

// The app is used in Switzerland and many tests assume Swiss local time (set
// start times, remarks, HH:MM labels). CI runs in UTC, so pin the zone here;
// the workers inherit it.
process.env.TZ = 'Europe/Zurich'
import react from '@vitejs/plugin-react'
import { htmlToImageFontSize } from './vite-plugin-html-to-image-font-size.js'

export default defineConfig({
  plugins: [react(), htmlToImageFontSize()],
  resolve: {
    // the ES build, as the app's bundle uses: its modules (clone-node) go
    // through htmlToImageFontSize; the CommonJS one's require()s would not
    alias: [{ find: /^html-to-image$/, replacement: 'html-to-image/es/index.js' }]
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.js'],
    // through the plugins (htmlToImageFontSize), as in the app
    server: { deps: { inline: ['html-to-image'] } },
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
