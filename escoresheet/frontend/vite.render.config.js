// The server's vector-PDF page (render/index.html, field-spec 17.19): the
// scoresheet alone, built into dist-render/ with relative asset paths. The
// renderer image (escoresheet/deploy/Dockerfile.render) serves it from its
// own disk to headless Chromium; nothing else of the web app goes in.
//   npx vite build --config vite.render.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { htmlToImageFontSize } from './vite-plugin-html-to-image-font-size.js'
import { BUILD_TARGET } from './build-target.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appVersion = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version

export default defineConfig({
  base: './',
  envDir: false,
  resolve: {
    dedupe: ['react', 'react-dom', 'dexie'],
    alias: [{ find: '@', replacement: resolve(__dirname, 'src') }]
  },
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react(), tailwindcss(), htmlToImageFontSize()],
  build: {
    target: BUILD_TARGET,
    outDir: 'dist-render',
    emptyOutDir: true,
    // one page; fonts and the logo as files beside it (the renderer serves them)
    assetsInlineLimit: 0,
    rolldownOptions: { input: { render: './render/index.html' } }
  }
})
