#!/usr/bin/env node
/**
 * Finds translation keys used in the code but missing from en.json.
 *
 * Scans src/ and scoresheet_pdf/ for keys passed to t():
 * - literal keys: t('a.b'), t("a.b"), i18n.t('a.b'), and both arms of a
 *   ternary, t(cond ? 'a.b' : 'c.d'). A key counts as present when en.json
 *   has it, or its plural forms (key_one / key_other ...);
 * - template literals, t(`tabletStatus.role.${role}`): the static part up to
 *   the last dot ("tabletStatus.role") must be an object in en.json. Which
 *   children exist cannot be checked statically, but a missing parent means
 *   none of them do (every language falls back to the inline default).
 * Variables and keys handed in through props (labelKey=...) stay invisible.
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

// t( / i18n.t( — the start of a call; its first argument is read by firstArgument()
const T_CALL = /(?<![\w$])(?:i18n\.)?t\(/g
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

const QUOTES = new Set(["'", '"', '`'])

/**
 * The first argument of a call whose "(" ends at `start`, as written (up to
 * the first top-level "," or ")"), or null when it runs off the text. Strings
 * and template literals are skipped over as wholes; ${...} inside a template
 * is not parsed further (no keys hide there).
 */
function firstArgument(source, start) {
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const c = source[i]
    if (QUOTES.has(c)) {
      i = endOfString(source, i)
      if (i < 0) return null
    } else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return source.slice(start, i)
      depth--
    } else if (c === ',' && depth === 0) return source.slice(start, i)
  }
  return null
}

// index of the closing quote of the string starting at `i`, or -1
function endOfString(source, i) {
  const quote = source[i]
  for (let j = i + 1; j < source.length; j++) {
    const c = source[j]
    if (c === '\\') j++
    else if (c === quote) return j
    else if (c === '\n' && quote !== '`') return -1
    else if (quote === '`' && c === '$' && source[j + 1] === '{') {
      // skip ${...}, braces balanced
      let depth = 0
      for (j += 1; j < source.length; j++) {
        if (source[j] === '{') depth++
        else if (source[j] === '}' && --depth === 0) break
      }
    }
  }
  return -1
}

// '...' / "..." literals of an expression, in order (template literals skipped)
const STRING_LITERAL = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g

/** What a t() call's first argument names: { keys: [...], prefixes: [...] } */
export function classifyArgument(arg) {
  const text = arg.trim()
  const keys = []
  const prefixes = []
  if (!text) return { keys, prefixes }
  const q = text[0]
  if ((q === "'" || q === '"') && endOfString(text, 0) === text.length - 1) {
    keys.push(text.slice(1, -1))
  } else if (q === '`' && endOfString(text, 0) === text.length - 1) {
    const body = text.slice(1, -1)
    const dynamic = body.indexOf('${')
    if (dynamic < 0) keys.push(body)
    else {
      const stat = body.slice(0, dynamic)
      const dot = stat.lastIndexOf('.')
      if (dot > 0) prefixes.push(stat.slice(0, dot))
    }
  } else {
    // a ternary: the literal arms after the first top-level "?" (the
    // condition may hold literals of its own: role === 'x' ? ...)
    const ask = topLevelIndex(text, '?')
    if (ask >= 0) {
      for (const m of text.slice(ask + 1).matchAll(STRING_LITERAL)) keys.push(m[2])
      for (const arm of templateArms(text.slice(ask + 1))) {
        const { keys: k, prefixes: p } = classifyArgument(arm)
        keys.push(...k)
        prefixes.push(...p)
      }
    }
  }
  return { keys: keys.filter(k => KEY_SHAPE.test(k)), prefixes: prefixes.filter(p => /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(p)) }
}

// index of `ch` outside strings / brackets, or -1 ("?." is not a ternary)
function topLevelIndex(text, ch) {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (QUOTES.has(c)) {
      i = endOfString(text, i)
      if (i < 0) return -1
    } else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ch && depth === 0 && !(ch === '?' && (text[i + 1] === '.' || text[i + 1] === '?'))) return i
  }
  return -1
}

// the template literals of an expression, as written
function templateArms(text) {
  const arms = []
  for (let i = 0; i < text.length; i++) {
    if (!QUOTES.has(text[i])) continue
    const end = endOfString(text, i)
    if (end < 0) break
    if (text[i] === '`') arms.push(text.slice(i, end + 1))
    i = end
  }
  return arms
}

const lineAt = (source, index) => source.slice(0, index).split('\n').length

/** Keys used in a source text: [{ key, line }] (literals, ternary arms) */
export function extractKeys(source) {
  return extractUses(source).keys
}

/**
 * Keys and template prefixes used in a source text:
 * { keys: [{ key, line }], prefixes: [{ prefix, line }] }
 */
export function extractUses(source) {
  const keys = []
  const prefixes = []
  for (const m of source.matchAll(T_CALL)) {
    const arg = firstArgument(source, m.index + m[0].length)
    if (arg == null) continue
    const line = lineAt(source, m.index)
    const found = classifyArgument(arg)
    for (const key of found.keys) keys.push({ key, line })
    for (const prefix of found.prefixes) prefixes.push({ prefix, line })
  }
  return { keys, prefixes }
}

const lookup = (obj, key) => key.split('.').reduce((o, part) => (o && typeof o === 'object' ? o[part] : undefined), obj)

/** Whether en.json has `prefix` as an object (the parent of t(`prefix.${x}`)) */
export function hasPrefix(messages, prefix) {
  const node = lookup(messages, prefix)
  return !!node && typeof node === 'object'
}

export function hasKey(messages, key) {
  if (lookup(messages, key) !== undefined) return true
  return PLURAL_SUFFIXES.some(s => lookup(messages, `${key}_${s}`) !== undefined)
}

export function loadLocale(lng = 'en', root = FRONTEND_DIR) {
  return JSON.parse(fs.readFileSync(path.join(root, 'src/i18n/locales', `${lng}.json`), 'utf8'))
}

/**
 * Map of missing key -> [file:line, ...] (paths relative to the frontend).
 * A template prefix whose parent object is missing is listed as "prefix.*".
 */
export function findMissingKeys({ messages = loadLocale('en'), files = listSourceFiles(), root = FRONTEND_DIR } = {}) {
  const missing = new Map()
  const add = (name, where) => {
    if (!missing.has(name)) missing.set(name, [])
    missing.get(name).push(where)
  }
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const { keys, prefixes } = extractUses(source)
    const where = (line) => `${path.relative(root, file)}:${line}`
    for (const { key, line } of keys) if (!hasKey(messages, key)) add(key, where(line))
    for (const { prefix, line } of prefixes) if (!hasPrefix(messages, prefix)) add(`${prefix}.*`, where(line))
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
    console.log('All t() keys (and template-key parents) exist in en.json.')
  }
  process.exit(missing.size ? 1 : 0)
}
