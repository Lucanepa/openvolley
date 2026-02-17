#!/usr/bin/env node

/**
 * Installs git hooks from escoresheet/frontend/scripts/hooks/ into .git/hooks/.
 * Run manually or automatically via npm postinstall.
 */

import { copyFileSync, chmodSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Find the repo root via git
let repoRoot
try {
  repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim()
} catch {
  // Not in a git repo (e.g. CI environment, tarball install) — skip silently
  process.exit(0)
}

const hooksSource = resolve(__dirname, 'hooks')
const hooksDest = resolve(repoRoot, '.git', 'hooks')

if (!existsSync(hooksDest)) {
  // .git/hooks doesn't exist — skip silently
  process.exit(0)
}

const hooks = ['commit-msg']

for (const hook of hooks) {
  const src = resolve(hooksSource, hook)
  const dest = resolve(hooksDest, hook)

  if (!existsSync(src)) continue

  copyFileSync(src, dest)
  chmodSync(dest, 0o755)
  console.log(`✅ Installed git hook: ${hook}`)
}
