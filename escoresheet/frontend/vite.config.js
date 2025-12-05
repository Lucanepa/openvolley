import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Set base from env for GitHub Pages project site deployments.
  // If deploying to a custom domain (CNAME), use '/'. Otherwise set to '/<repo-name>/'
  base: process.env.VITE_BASE_PATH || '/',
  optimizeDeps: {
    include: ['pdfjs-dist']
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
  server: { port: 5173 },
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


