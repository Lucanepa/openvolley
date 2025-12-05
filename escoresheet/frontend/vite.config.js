import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Read version from package.json
const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const appVersion = packageJson.version

const isElectron = process.env.ELECTRON === 'true'

export default defineConfig({
  // Set base from env for GitHub Pages project site deployments.
  // If deploying to a custom domain (CNAME), use '/'. Otherwise set to '/<repo-name>/'
  // For Electron, use './' for relative paths
  base: isElectron ? './' : (process.env.VITE_BASE_PATH || '/'),
  optimizeDeps: {
    include: ['pdfjs-dist']
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      manifest: {
        name: process.env.VITE_APP_TITLE || 'Open eScoresheet',
        short_name: 'eScoresheet',
        start_url: '.',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#111827',
        icons: [
          { src: 'favicon.png', sizes: '192x192', type: 'image/png' },
          { src: 'favicon.png', sizes: '512x512', type: 'image/png' }
        ]
      }
    })
  ],
  server: { 
    port: 5173,
    host: '0.0.0.0', // Bind to all interfaces (IPv4 and IPv6)
    strictPort: false
  },
  build: {
    // Use safer build options to avoid eval in production
    minify: 'esbuild',
    target: 'es2015',
    rollupOptions: {
      input: {
        main: './index.html',
        referee: './referee.html',
        scoresheet: './scoresheet.html',
        bench: './bench.html',
        livescore: './livescore.html',
        upload_roster: './upload_roster.html'
      },
      output: {
        // Avoid eval in production builds
        format: 'es'
      }
    }
  }
})


