#!/usr/bin/env node
/**
 * Build script for subdomain deployments
 * Builds each dashboard as a standalone app for Render static site deployment
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
const disablePWA = process.env.DISABLE_PWA === 'true'

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
  },
  scoresheet: {
    name: 'Scoresheet Archive',
    shortName: 'Scoresheet',
    description: 'View and download volleyball match scoresheets',
    title: 'Scoresheet Archive - OpenVolley',
    mainEntry: 'scoresheet-main',
    themeColor: '#0891b2',
    customHtml: true
  }
}

function createIndexHtml(config) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/png" sizes="16x16 32x32 48x48 64x64" href="/openvolley_no_bg.png" />
    <link rel="icon" type="image/png" sizes="128x128 256x256" href="/openvolley_no_bg.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/openvolley_no_bg.png" />
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

function createScoresheetHtml(config) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/png" sizes="16x16 32x32 48x48 64x64" href="/openvolley_no_bg.png" />
  <link rel="icon" type="image/png" sizes="128x128 256x256" href="/openvolley_no_bg.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/openvolley_no_bg.png" />
  <meta name="theme-color" content="${config.themeColor}" />
  <meta name="description" content="${config.description}" />
  <title>${config.title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    /* Global Font Setting */
    body {
      font-family: 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }

    /* Custom print styles to ensure background graphics/colors print */
    @media print {
      html,
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
        margin: 0 !important;
        padding: 0 !important;
        height: 100% !important;
        overflow: hidden !important;
      }

      @page {
        size: A4 landscape;
        margin: 0;
      }

      #root {
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        height: 100vh !important;
        max-height: 100vh !important;
      }
    }

    /* Hide scrollbar for cleaner look in inputs */
    input[type="number"]::-webkit-inner-spin-button,
    input[type="number"]::-webkit-outer-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    .vertical-text {
      writing-mode: vertical-lr;
      transform: rotate(180deg);
    }

    /* Dense table utils */
    .input-dense {
      text-align: center;
      background-color: transparent;
      width: 100%;
      height: 100%;
      outline: none;
    }

    .input-dense:focus {
      background-color: rgba(59, 130, 246, 0.1);
    }
  </style>
</head>
<body class="bg-gray-100 text-gray-900 antialiased print:bg-white text-[10px] overflow-auto">
  <div id="root"></div>
  <script type="module" src="/src/${config.mainEntry}.jsx"></script>
</body>
</html>
`
}

async function buildSubdomain(subdomain, basePath = '/') {
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

  console.log(`\n🔨 Building ${subdomain}.openvolley.app...${basePath !== '/' ? ` (base: ${basePath})` : ''}`)

  // Create temp index.html in frontend root (use custom HTML for scoresheet)
  const htmlContent = config.customHtml ? createScoresheetHtml(config) : createIndexHtml(config)
  writeFileSync(tempIndexPath, htmlContent)

  try {
    await build({
      root: frontendDir,
      base: basePath,
      publicDir: 'public',
      define: {
        __APP_VERSION__: JSON.stringify(appVersion)
      },
      resolve: {
        dedupe: ['react', 'react-dom', 'dexie']
      },
      plugins: [
        react(),
        ...(!disablePWA ? [VitePWA({
          registerType: 'prompt',
          includeAssets: ['openvolley_no_bg.png'],
          workbox: {
            skipWaiting: false,
            clientsClaim: true,
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
              { src: 'openvolley_no_bg.png', sizes: '192x192', type: 'image/png' },
              { src: 'openvolley_no_bg.png', sizes: '512x512', type: 'image/png' }
            ]
          }
        })] : [])
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

    // Create package.json for Render deployment
    const renderPackageJson = {
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
      JSON.stringify(renderPackageJson, null, 2)
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
  const baseArgIndex = process.argv.indexOf('--base')
  const basePath = baseArgIndex !== -1 ? process.argv[baseArgIndex + 1] : '/'

  console.log('🏐 OpenVolley Subdomain Builder')
  console.log(`   Version: ${appVersion}`)

  if (targetSubdomain) {
    await buildSubdomain(targetSubdomain, basePath)

    // If building 'app', also build scoresheet with /scoresheet/ base path
    if (targetSubdomain === 'app') {
      console.log('\n📋 Building embedded scoresheet for app.openvolley.app/scoresheet...')
      await buildSubdomain('scoresheet', '/scoresheet/')
      const scoresheetSrc = resolve(frontendDir, 'dist-scoresheet')
      const scoresheetDest = resolve(frontendDir, 'dist-app', 'scoresheet')
      if (existsSync(scoresheetSrc)) {
        mkdirSync(scoresheetDest, { recursive: true })
        cpSync(scoresheetSrc, scoresheetDest, { recursive: true })
        console.log('✅ Copied scoresheet to dist-app/scoresheet/')
      }
    }
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

main().then(() => {
  process.exit(0)
}).catch((err) => {
  console.error('Build failed:', err)
  process.exit(1)
})
