// The commit a build is made from, shown beside the version where testers note it
// (photo import timing, owner 27.11): Cloudflare Pages gives it, else git; '' if
// neither. Used by vite.config.js and scripts/build-subdomains.js (the per-site
// builds Cloudflare runs), so both define the same __BUILD_COMMIT__.
import { execSync } from 'child_process'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

export function buildCommit (env = process.env) {
  const cf = env.CF_PAGES_COMMIT_SHA
  if (cf) return String(cf).slice(0, 7)
  try {
    return execSync('git rev-parse --short=7 HEAD', { cwd: dirname(fileURLToPath(import.meta.url)), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}
