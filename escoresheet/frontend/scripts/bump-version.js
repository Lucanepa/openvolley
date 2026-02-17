#!/usr/bin/env node

/**
 * Automatic version bump based on conventional commit messages.
 *
 * Usage: node bump-version.js <commit-msg-file>
 *
 * Commit prefix → bump type:
 *   feat:           → minor (1.2.0 → 1.3.0)
 *   fix:, perf:, refactor:, style:, docs:, test:, chore:, build:, ci: → patch (1.2.0 → 1.2.1)
 *   feat!:, fix!:, BREAKING CHANGE → major (1.2.0 → 2.0.0)
 *   no prefix       → patch
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(__dirname, '..')

// Read commit message
const commitMsgFile = process.argv[2]
if (!commitMsgFile) {
  console.error('Usage: bump-version.js <commit-msg-file>')
  process.exit(1)
}

const commitMsg = readFileSync(commitMsgFile, 'utf-8').trim()

// Skip version bump for merge commits, amends, etc.
if (commitMsg.startsWith('Merge ') || commitMsg.startsWith('Revert ')) {
  process.exit(0)
}

// Parse conventional commit
const firstLine = commitMsg.split('\n')[0]
const hasBreakingMarker = /^[a-z]+(\(.+\))?!:/.test(firstLine)
const hasBreakingFooter = commitMsg.includes('BREAKING CHANGE')
const isBreaking = hasBreakingMarker || hasBreakingFooter

const typeMatch = firstLine.match(/^([a-z]+)(\(.+\))?!?:/)
const type = typeMatch ? typeMatch[1] : null

// Determine bump type
let bump
if (isBreaking) {
  bump = 'major'
} else if (type === 'feat') {
  bump = 'minor'
} else {
  bump = 'patch'
}

// Read current version from package.json
const pkgPath = resolve(frontendDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)

// Bump
let newVersion
switch (bump) {
  case 'major':
    newVersion = `${major + 1}.0.0`
    break
  case 'minor':
    newVersion = `${major}.${minor + 1}.0`
    break
  case 'patch':
    newVersion = `${major}.${minor}.${patch + 1}`
    break
}

console.log(`📦 Version bump: ${pkg.version} → ${newVersion} (${bump}, ${type || 'no prefix'})`)

// Update package.json
pkg.version = newVersion
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

// Update public/version.json
const versionJsonPath = resolve(frontendDir, 'public', 'version.json')
writeFileSync(versionJsonPath, JSON.stringify({ version: newVersion }) + '\n')

// Stage the updated files
execSync(`git add "${pkgPath}" "${versionJsonPath}"`)
