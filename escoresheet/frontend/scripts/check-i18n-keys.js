#!/usr/bin/env node
/**
 * Finds translation keys used in the code but missing from en.json.
 *
 * Scans src/ and scoresheet_pdf/ for literal keys passed to t():
 * t('a.b'), t("a.b"), i18n.t('a.b') (template literals and variables are
 * skipped: they cannot be checked statically). A key counts as present when
 * en.json has it, or its plural forms (key_one / key_other ...).
 *
 * A missing key renders as its raw name ("matchSetup.allowPopups" in a
 * Notice dialog), or as the inline default where one is given; either way
 * the other languages never see a translation.
 *
 * Usage:
 *   node scripts/check-i18n-keys.js          # exit 1 and list the missing keys
 *   node scripts/check-i18n-keys.js --json   # the same, as JSON
 *
 * Also run by vitest (src/i18n/__tests__/missingKeys.test.js).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const FRONTEND_DIR = path.join(__dirname, '..')
export const SCAN_DIRS = ['src', 'scoresheet_pdf']
const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx'])
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist'])

// t('key' / t("key" — the first argument only, a single literal
const T_CALL = /(?<![\w$])(?:i18n\.)?t\(\s*(['"])([^'"\n\\]+)\1/g
// a translation key: dotted path segments, no spaces
const KEY_SHAPE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other']

export function listSourceFiles(dirs = SCAN_DIRS, root = FRONTEND_DIR) {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name))
      } else if (EXTENSIONS.has(path.extname(entry.name)) && !/\.test\.[jt]sx?$/.test(entry.name)) {
        out.push(path.join(dir, entry.name))
      }
    }
  }
  for (const d of dirs) walk(path.join(root, d))
  return out
}

/** Literal keys used in a source text: [{ key, line }] */
export function extractKeys(source) {
  const found = []
  for (const m of source.matchAll(T_CALL)) {
    const key = m[2]
    if (!KEY_SHAPE.test(key)) continue
    const line = source.slice(0, m.index).split('\n').length
    found.push({ key, line })
  }
  return found
}

const lookup = (obj, key) => key.split('.').reduce((o, part) => (o && typeof o === 'object' ? o[part] : undefined), obj)

export function hasKey(messages, key) {
  if (lookup(messages, key) !== undefined) return true
  return PLURAL_SUFFIXES.some(s => lookup(messages, `${key}_${s}`) !== undefined)
}

export function loadLocale(lng = 'en', root = FRONTEND_DIR) {
  return JSON.parse(fs.readFileSync(path.join(root, 'src/i18n/locales', `${lng}.json`), 'utf8'))
}

/** Map of missing key -> [file:line, ...] (paths relative to the frontend) */
export function findMissingKeys({ messages = loadLocale('en'), files = listSourceFiles(), root = FRONTEND_DIR } = {}) {
  const missing = new Map()
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    for (const { key, line } of extractKeys(source)) {
      if (hasKey(messages, key)) continue
      const where = `${path.relative(root, file)}:${line}`
      if (!missing.has(key)) missing.set(key, [])
      missing.get(key).push(where)
    }
  }
  return missing
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const missing = findMissingKeys()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(Object.fromEntries(missing), null, 2))
  } else if (missing.size) {
    console.error(`${missing.size} translation key(s) used in the code are missing from en.json:`)
    for (const [key, places] of [...missing].sort()) console.error(`  ${key}  (${places.join(', ')})`)
  } else {
    console.log('All literal t() keys exist in en.json.')
  }
  process.exit(missing.size ? 1 : 0)
}
