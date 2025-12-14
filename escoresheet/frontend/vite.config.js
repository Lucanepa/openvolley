import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { vitePluginApiRoutes } from './vite-plugin-api-routes.js'

// Valid HTML pages for the app
const validPages = [
  '/',
  '/index.html',
  '/referee.html',
  '/scoresheet.html',
  '/bench.html',
  '/livescore.html',
  '/upload_roster.html',
  // Also allow without .html extension
  '/referee',
  '/scoresheet',
  '/bench',
  '/livescore',
  '/upload_roster'
]

// Map non-.html routes to their .html counterparts
const htmlRedirects = {
  '/referee': '/referee.html',
  '/scoresheet': '/scoresheet.html',
  '/bench': '/bench.html',
  '/livescore': '/livescore.html',
  '/upload_roster': '/upload_roster.html'
}

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
    include: ['pdfjs-dist', 'react', 'react-dom']
  },
  resolve: {
    dedupe: ['react', 'react-dom']
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  plugins: [
    react(),
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

          // Redirect non-.html routes to their .html counterparts
          if (htmlRedirects[url]) {
            req.url = htmlRedirects[url] + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '')
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
        type: 'module'
        // No navigateFallback - we want 404s for invalid routes
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


