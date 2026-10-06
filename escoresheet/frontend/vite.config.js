import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { vitePluginApiRoutes } from './vite-plugin-api-routes.js'
import { PRECACHE_GLOB_PATTERNS, IGNORE_URL_PARAMETERS, offlineNavigationRoute } from './pwa-workbox.js'

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
// Android app build (scripts/release-android.sh): the WebView loads the bundled
// files, so no service worker — an old precache would otherwise keep serving
// the previous version after an APK update until the user accepted the prompt.
const isCapacitor = process.env.CAPACITOR === 'true'

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
  // Android app: no .env files, only the variables given on the command line
  // (scripts/release-android.sh, the F-Droid recipe). F-Droid builds the APK
  // from source and checks it against the owner-signed one byte for byte, so
  // a value from someone's local .env (e.g. VITE_REOPEN_PASSWORD_HASH) must
  // not end up in the bundle.
  envDir: isCapacitor ? false : undefined,
  optimizeDeps: {
    include: ['pdfjs-dist', 'react', 'react-dom', 'dexie', 'dexie-react-hooks']
  },
  resolve: {
    dedupe: ['react', 'react-dom', 'dexie'],
    alias: [
      { find: '@', replacement: resolve(__dirname, 'src') },
      // Android app (F-Droid): the Swiss Volley logo in the scoresheet PDF
      // header is a federation trademark with no licence to redistribute it,
      // so it must not ship inside the APK. The import resolves to a module
      // that exports null and the header leaves the slot empty. Web and
      // desktop builds keep the logo.
      ...(isCapacitor
        ? [{ find: /^\.\/swissvolleylogo\.jpg$/, replacement: resolve(__dirname, 'scoresheet_pdf/components/noFederationLogo.js') }]
        : [])
    ]
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  plugins: [
    react(),
    tailwindcss(),
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
      disable: isCapacitor,
      registerType: 'prompt',
      includeAssets: ['openvolley_no_bg.png', 'favicon.ico', 'ball.png', 'fonts/*.woff2'],
      workbox: {
        // Disable workbox console logs in production
        mode: 'production',
        // PRECACHE fonts + images + icons too (not just js/css/html). Without this
        // they are only runtime-cached after a first ONLINE render, so a true cold
        // offline start shows system fonts + missing logos/backgrounds.
        // Also .mjs (pdf.js worker) and .jpg (scoresheet logo).
        globPatterns: PRECACHE_GLOB_PATTERNS,
        // Match precache ignoring ALL query params: /scoresheet/?matchId=X,
        // /referee/?match=..&team=.. must load the precached index.html offline
        ignoreURLParametersMatching: IGNORE_URL_PARAMETERS,
        // Don't skip waiting automatically - let user choose when to update
        skipWaiting: false,
        clientsClaim: true,
        // IMPORTANT: Disable navigateFallback for multi-page app
        // Without this, navigating to /scoresheet, /referee, etc. falls back to index.html
        // (offlineNavigationRoute below maps each page URL to its own index.html instead)
        navigateFallback: null,
        // Network-first strategy for API calls, cache-first for assets
        runtimeCaching: [
          // Extension-less page URLs (/referee?match=..) -> that entry's precached index.html
          offlineNavigationRoute,
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
            urlPattern: /\.(?:js|mjs|css|png|jpg|jpeg|svg|gif|webp|woff|woff2)$/,
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
        // Light only: white status bar (a red one would compete with red team
        // colours and red cards courtside; RESTYLE-SPEC 5.3 / R4).
        theme_color: '#ffffff',
        icons: [
          // Real 192/512 renditions (openvolley_no_bg.png itself is 1024x1024)
          { src: 'openvolley_icon_192.png', sizes: '192x192', type: 'image/png' },
          { src: 'openvolley_icon_512.png', sizes: '512x512', type: 'image/png' }
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
        // Split vendor libraries into separate cached chunks
        manualChunks: (id) => {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'react-vendor'
          }
          if (id.includes('node_modules/dexie')) {
            return 'dexie-vendor'
          }
          if (id.includes('node_modules/jspdf') || id.includes('node_modules/html-to-image')) {
            return 'pdf-vendor'
          }
          if (id.includes('node_modules/i18next') || id.includes('node_modules/react-i18next')) {
            return 'i18n-vendor'
          }
        }
      }
    }
  }
})


