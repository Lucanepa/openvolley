#!/usr/bin/env node
/**
 * Build script for the OpenVolley standalone server binary.
 *
 * Steps:
 *  1. Bundle server.js + all npm dependencies into a single JS file with esbuild
 *  2. Generate Node.js SEA blob
 *  3. Inject blob into a copy of the node binary → standalone executable
 *
 * Prerequisites:
 *  - Node.js >= 22
 *  - npm install (backend deps)
 *  - npx esbuild (comes with npm)
 *  - Frontend dist files in public/ (optional — server works without them)
 *
 * Usage:
 *  node build-server.js                  # Build for current platform
 *  node build-server.js --output mybin   # Custom output name
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, 'dist')
const bundlePath = join(distDir, 'server.bundle.cjs')
const blobPath = join(distDir, 'sea-prep.blob')

const isWindows = process.platform === 'win32'
const defaultName = isWindows ? 'openvolley-server.exe' : 'openvolley-server'

// Parse args
const outputArg = process.argv.indexOf('--output')
const outputName = outputArg !== -1 ? process.argv[outputArg + 1] : defaultName
const outputPath = join(distDir, outputName)

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: __dirname, ...opts })
}

function step(msg) {
  console.log(`\n→ ${msg}`)
}

// Clean
if (existsSync(distDir)) rmSync(distDir, { recursive: true })
mkdirSync(distDir, { recursive: true })

// Step 1: Bundle with esbuild
step('Bundling server.js with esbuild...')
run([
  'npx esbuild server.js',
  '--bundle',
  '--platform=node',
  '--target=node22',
  '--format=cjs',
  `--outfile=${bundlePath}`,
  '--external:bufferutil',
  '--external:utf-8-validate',
  '--define:import.meta.url=__import_meta_url',
  '--banner:js="const __import_meta_url = require(\'url\').pathToFileURL(__filename).href;"'
].join(' '))

// Step 2: Generate SEA config (embed public/ files as assets)
step('Generating SEA configuration...')

const publicDir = join(__dirname, 'public')
const assets = {}
if (existsSync(publicDir)) {
  function walkDir(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walkDir(fullPath, key)
      else assets[key] = fullPath
    }
  }
  walkDir(publicDir, '')
  console.log(`  Embedding ${Object.keys(assets).length} static files from public/`)
} else {
  console.log('  No public/ directory found — building without static assets')
}

const seaConfig = {
  main: bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
  assets
}

const seaConfigPath = join(distDir, 'sea-config.json')
writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2))

// Step 3: Generate SEA blob
step('Generating SEA preparation blob...')
run(`node --experimental-sea-config ${seaConfigPath}`)

// Step 4: Copy node binary
step('Copying Node.js binary...')
copyFileSync(process.execPath, outputPath)

// Step 5: Remove signature on macOS (required before injection)
if (process.platform === 'darwin') {
  step('Removing code signature (macOS)...')
  try {
    run(`codesign --remove-signature ${outputPath}`)
  } catch {
    console.log('  (codesign not available, skipping)')
  }
}

// Step 6: Inject blob with postject
step('Injecting SEA blob into binary...')
const postjectArgs = [
  `npx postject ${outputPath} NODE_SEA_BLOB ${blobPath}`,
  '--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
]
if (process.platform === 'darwin') {
  postjectArgs.push('--macho-segment-name NODE_SEA')
}
run(postjectArgs.join(' '))

// Step 7: Re-sign on macOS
if (process.platform === 'darwin') {
  step('Re-signing binary (macOS)...')
  try {
    run(`codesign --sign - ${outputPath}`)
  } catch {
    console.log('  (codesign not available, skipping)')
  }
}

// Clean up intermediate files
rmSync(bundlePath, { force: true })
rmSync(blobPath, { force: true })
rmSync(seaConfigPath, { force: true })

// Done
const stats = readFileSync(outputPath)
const sizeMB = (stats.length / 1024 / 1024).toFixed(1)
console.log(`
✅ Build complete!
   Binary: ${outputPath}
   Size:   ${sizeMB} MB

To run:
   ${isWindows ? `.\\dist\\${outputName}` : `./dist/${outputName}`}

${Object.keys(assets).length > 0 ? `Frontend assets embedded: ${Object.keys(assets).length} files` : 'No frontend assets embedded — place public/ next to the binary'}
`)
