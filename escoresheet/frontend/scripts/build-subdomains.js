#!/usr/bin/env node
/**
 * Build script for subdomain deployments
 * Builds each dashboard as a standalone app for Railway static site deployment
 *
 * Usage:
 *   node scripts/build-subdomains.js          # Build all subdomains
 *   node scripts/build-subdomains.js referee  # Build only referee
 *
 * Output:
 *   dist-app/       → app.openvolley.app (main scoresheet)
 *   dist-referee/   → referee.openvolley.app
 *   dist-bench/     → bench.openvolley.app
 *   dist-livescore/ → livescore.openvolley.app
 *   dist-roster/    → roster.openvolley.app
 */

import { build } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, renameSync } from 'fs'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const __dirname = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(__dirname, '..')

// Read version from package.json
const packageJson = JSON.parse(readFileSync(resolve(frontendDir, 'package.json'), 'utf-8'))
const appVersion = packageJson.version

// Subdomain configurations
const subdomains = {
  app: {
    name: 'Open eScoresheet',
    shortName: 'eScoresheet',
    description: 'Volleyball match scoring application',
    title: 'Open eScoresheet',
    mainEntry: 'main',
    themeColor: '#111827'
  },
  referee: {
    name: 'Referee Dashboard',
    shortName: 'Referee',
    description: 'Referee view for volleyball match scoring',
    title: 'Referee Dashboard - OpenVolley',
    mainEntry: 'referee-main',
    themeColor: '#1e40af'
  },
  bench: {
    name: 'Team Dashboard',
    shortName: 'Bench',
    description: 'Team bench dashboard for volleyball match management',
    title: 'Team Dashboard - OpenVolley',
    mainEntry: 'bench-main',
    themeColor: '#047857'
  },
  livescore: {
    name: 'Live Scoreboard',
    shortName: 'Livescore',
    description: 'Live scoring display for volleyball match',
    title: 'Live Scoreboard - OpenVolley',
    mainEntry: 'livescore-main',
    themeColor: '#7c3aed'
  },
  roster: {
    name: 'Roster Upload',
    shortName: 'Roster',
    description: 'Upload roster PDF for volleyball match',
    title: 'Roster Upload - OpenVolley',
    mainEntry: 'upload-roster-main',
    themeColor: '#ea580c'
  }
}

function createIndexHtml(config) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/png" sizes="16x16 32x32 48x48 64x64" href="/favicon.png" />
    <link rel="icon" type="image/png" sizes="128x128 256x256" href="/favicon.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/favicon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="${config.themeColor}" />
    <meta name="description" content="${config.description}" />
    <title>${config.title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/${config.mainEntry}.jsx"></script>
  </body>
</html>
`
}

async function buildSubdomain(subdomain) {
  const config = subdomains[subdomain]
  if (!config) {
    console.error(`Unknown subdomain: ${subdomain}`)
    console.error(`Available: ${Object.keys(subdomains).join(', ')}`)
    process.exit(1)
  }

  const outDir = resolve(frontendDir, `dist-${subdomain}`)
  const tempIndexName = `_build_${subdomain}.html`
  const tempIndexPath = resolve(frontendDir, tempIndexName)

  // Clean output directory
  if (existsSync(outDir)) rmSync(outDir, { recursive: true })

  console.log(`\n🔨 Building ${subdomain}.openvolley.app...`)

  // Create temp index.html in frontend root
  writeFileSync(tempIndexPath, createIndexHtml(config))

  try {
    await build({
      root: frontendDir,
      base: '/',
      publicDir: 'public',
      define: {
        __APP_VERSION__: JSON.stringify(appVersion)
      },
      optimizeDeps: {
        include: ['pdfjs-dist', 'react', 'react-dom', 'dexie', 'dexie-react-hooks']
      },
      resolve: {
        dedupe: ['react', 'react-dom', 'dexie']
      },
      plugins: [
        react(),
        VitePWA({
          registerType: 'prompt',
          includeAssets: ['favicon.png'],
          workbox: {
            skipWaiting: false,
            clientsClaim: true,
            // Disable navigateFallback - each subdomain is a single entry point
            // and the temp filename issue causes precache mismatch
            navigateFallback: null,
            runtimeCaching: [
              {
                urlPattern: /^https?:\/\/.*\/api\/.*/i,
                handler: 'NetworkFirst',
                options: {
                  cacheName: 'api-cache',
                  expiration: { maxEntries: 50, maxAgeSeconds: 86400 },
                  networkTimeoutSeconds: 10
                }
              },
              {
                urlPattern: /\.(?:js|css|png|jpg|jpeg|svg|gif|woff|woff2)$/,
                handler: 'CacheFirst',
                options: {
                  cacheName: 'static-assets',
                  expiration: { maxEntries: 100, maxAgeSeconds: 2592000 }
                }
              },
              {
                // HTML pages - network first for navigation
                urlPattern: /\.html$/,
                handler: 'NetworkFirst',
                options: {
                  cacheName: 'html-cache',
                  expiration: { maxEntries: 10, maxAgeSeconds: 86400 }
                }
              }
            ],
            navigateFallbackDenylist: [/^\/api\//],
            cleanupOutdatedCaches: true
          },
          manifest: {
            name: config.name,
            short_name: config.shortName,
            description: config.description,
            start_url: '/',
            display: 'standalone',
            background_color: '#ffffff',
            theme_color: config.themeColor,
            icons: [
              { src: 'favicon.png', sizes: '192x192', type: 'image/png' },
              { src: 'favicon.png', sizes: '512x512', type: 'image/png' }
            ]
          }
        })
      ],
      build: {
        outDir,
        emptyOutDir: true,
        rollupOptions: {
          input: tempIndexPath,
          output: {
            format: 'es',
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
      },
      logLevel: 'warn'
    })

    // Rename the built HTML to index.html
    const builtHtmlPath = resolve(outDir, tempIndexName)
    const finalHtmlPath = resolve(outDir, 'index.html')
    if (existsSync(builtHtmlPath)) {
      renameSync(builtHtmlPath, finalHtmlPath)
    }

    // Create package.json for Railway deployment
    const railwayPackageJson = {
      name: `openvolley-${subdomain}`,
      version: appVersion,
      private: true,
      scripts: {
        start: 'npx serve . -s -l $PORT'
      },
      dependencies: {
        serve: '^14.2.5'
      }
    }
    writeFileSync(
      resolve(outDir, 'package.json'),
      JSON.stringify(railwayPackageJson, null, 2)
    )

    console.log(`✅ Built ${subdomain}.openvolley.app → dist-${subdomain}/`)

  } finally {
    // Clean up temp file
    if (existsSync(tempIndexPath)) {
      rmSync(tempIndexPath)
    }
  }
}

async function main() {
  const targetSubdomain = process.argv[2]

  console.log('🏐 OpenVolley Subdomain Builder')
  console.log(`   Version: ${appVersion}`)

  if (targetSubdomain) {
    await buildSubdomain(targetSubdomain)
  } else {
    console.log('\n📦 Building all subdomains...')
    for (const subdomain of Object.keys(subdomains)) {
      await buildSubdomain(subdomain)
    }
    console.log('\n✨ All subdomain builds complete!')
    console.log('\n📁 Output directories:')
    for (const subdomain of Object.keys(subdomains)) {
      console.log(`   dist-${subdomain}/ → ${subdomain}.openvolley.app`)
    }
  }
}

main().catch((err) => {
  console.error('Build failed:', err)
  process.exit(1)
})
