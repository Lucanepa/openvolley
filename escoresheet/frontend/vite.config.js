import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { vitePluginApiRoutes } from './vite-plugin-api-routes.js'

// Valid HTML pages for the app (folder-based structure for clean URLs)
const validPages = [
  '/',
  '/index.html',
  '/referee',
  '/referee/',
  '/scoresheet',
  '/scoresheet/',
  '/bench',
  '/bench/',
  '/livescore',
  '/livescore/',
  '/upload_roster',
  '/upload_roster/'
]

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
    include: ['pdfjs-dist', 'react', 'react-dom', 'dexie', 'dexie-react-hooks']
  },
  resolve: {
    dedupe: ['react', 'react-dom', 'dexie']
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  plugins: [
    react(),
    // Rewrite clean URLs to their index.html files
    {
      name: 'html-rewrite-handler',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url?.split('?')[0] || '/'

          // Rewrite folder routes to their index.html
          const folderRoutes = ['referee', 'scoresheet', 'bench', 'livescore', 'upload_roster']
          for (const route of folderRoutes) {
            if (url === `/${route}` || url === `/${route}/`) {
              req.url = `/${route}/index.html`
              break
            }
          }

          next()
        })
      }
    },
    // Custom 404 handling for invalid routes
    {
      name: 'html-404-handler',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url?.split('?')[0] || '/'

          // Skip API routes, assets, and Vite internal routes
          if (url.startsWith('/api/') ||
              url.startsWith('/@') ||
              url.startsWith('/node_modules/') ||
              url.startsWith('/src/') ||
              url.includes('.')) {
            return next()
          }

          // Check if it's a valid page route
          if (!validPages.includes(url)) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'text/html')
            res.end(`
              <!DOCTYPE html>
              <html>
              <head>
                <title>404 - Page Not Found</title>
                <style>
                  body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                    color: #fff;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin: 0;
                  }
                  .container {
                    text-align: center;
                    padding: 40px;
                  }
                  h1 { font-size: 72px; margin: 0; color: #ef4444; }
                  p { font-size: 18px; color: rgba(255,255,255,0.7); margin: 20px 0; }
                  a {
                    display: inline-block;
                    padding: 12px 24px;
                    background: #3b82f6;
                    color: #fff;
                    text-decoration: none;
                    border-radius: 8px;
                    font-weight: 600;
                    margin-top: 20px;
                  }
                  a:hover { background: #2563eb; }
                  .valid-pages {
                    margin-top: 30px;
                    font-size: 14px;
                    color: rgba(255,255,255,0.5);
                  }
                  .valid-pages a {
                    background: transparent;
                    border: 1px solid rgba(255,255,255,0.3);
                    padding: 6px 12px;
                    margin: 4px;
                    font-size: 12px;
                  }
                </style>
              </head>
              <body>
                <div class="container">
                  <h1>404</h1>
                  <p>Page not found: <code>${url}</code></p>
                  <a href="/">Go to Home</a>
                  <div class="valid-pages">
                    <p>Valid pages:</p>
                    <a href="/referee">Referee</a>
                    <a href="/bench">Bench</a>
                    <a href="/livescore">Livescore</a>
                    <a href="/upload_roster">Upload Roster</a>
                  </div>
                </div>
              </body>
              </html>
            `)
            return
          }

          next()
        })
      }
    },
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.png'],
      workbox: {
        // Don't skip waiting automatically - let user choose when to update
        skipWaiting: false,
        clientsClaim: true,
        // IMPORTANT: Disable navigateFallback for multi-page app
        // Without this, navigating to /scoresheet, /referee, etc. falls back to index.html
        navigateFallback: null,
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
        navigateFallback: undefined, // Explicitly disable - we handle multi-page routing ourselves
        navigateFallbackAllowlist: [], // No fallback for any routes
        disableDevLogs: true // Disable verbose workbox logging in dev console
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
    rollupOptions: {
      input: {
        main: './index.html',
        referee: './referee/index.html',
        scoresheet: './scoresheet/index.html',
        bench: './bench/index.html',
        livescore: './livescore/index.html',
        upload_roster: './upload_roster/index.html'
      },
      output: {
        format: 'es',
        // Keep React and Dexie in separate chunks to avoid initialization issues
        manualChunks: (id) => {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'react-vendor'
          }
          if (id.includes('node_modules/dexie')) {
            return 'dexie-vendor'
          }
        }
      }
    }
  }
})


