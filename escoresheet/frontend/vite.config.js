import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { vitePluginApiRoutes } from './vite-plugin-api-routes.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Read version from package.json
const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const appVersion = packageJson.version

const isElectron = process.env.ELECTRON === 'true'

// HTTPS configuration for dev server
const useHttps = process.env.VITE_HTTPS === 'true' || process.env.HTTPS === 'true'
let httpsConfig = false

if (useHttps) {
  const certPath = resolve(__dirname, 'localhost.pem')
  const keyPath = resolve(__dirname, 'localhost-key.pem')
  
  if (existsSync(certPath) && existsSync(keyPath)) {
    httpsConfig = {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath)
    }
    console.log('🔒 Using HTTPS with custom certificates')
  } else {
    // Vite will generate self-signed cert automatically
    httpsConfig = true
    console.log('🔒 Using HTTPS with auto-generated self-signed certificate')
  }
}

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
      workbox: {
        // Network-first strategy for API calls, cache-first for assets
        runtimeCaching: [
          {
            // API routes - network first, fallback to cache
            urlPattern: /^https?:\/\/.*\/api\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 // 24 hours
              },
              networkTimeoutSeconds: 10,
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // Static assets - cache first
            urlPattern: /\.(?:js|css|png|jpg|jpeg|svg|gif|woff|woff2)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'static-assets',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
              }
            }
          },
          {
            // HTML pages - network first
            urlPattern: /\.html$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'html-cache',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60 * 60 * 24 // 24 hours
              }
            }
          }
        ],
        // Don't cache these routes
        navigateFallbackDenylist: [/^\/api\//],
        // Clean up old caches
        cleanupOutdatedCaches: true
      },
      devOptions: {
        enabled: true, // Enable PWA in development
        type: 'module',
        navigateFallback: 'index.html'
      },
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
    }),
    // Add API routes for dev server (same as production server.js)
    vitePluginApiRoutes({ wsPort: process.env.WS_PORT || 8080 })
  ],
  server: { 
    port: 5173,
    host: '0.0.0.0', // Bind to all interfaces (IPv4 and IPv6)
    strictPort: false,
    https: httpsConfig
    // API routes are now handled by vite-plugin-api-routes plugin
    // WebSocket server runs on port 8080 (or WS_PORT env var)
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


