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
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readFileSync } from 'fs'
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

// Step 2: Generate SEA config
step('Generating SEA configuration...')
const seaConfig = {
  main: bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useCodeCache: true
}

// If public/ directory exists with static assets, embed key files as SEA assets
// Note: For large static file trees, it's better to keep them alongside the binary
// rather than embedding. The binary will look for a public/ folder next to itself.
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

The server will look for a public/ directory next to the binary
for serving frontend files (referee, bench, livescore).
`)
