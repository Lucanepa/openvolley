import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Windows and macOS file systems ignore case. Two files in one folder that
// differ only in case (legalLinks.js next to LegalLinks.jsx) made an
// extension-less import load the wrong one there, and the desktop build
// failed on Windows while Linux passed. Same stem regardless of extension
// counts too, since Vite resolves '.js' before '.jsx'.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIRS = ['src', 'scoresheet_pdf']

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

describe('file names', () => {
  it('no two files in a folder differ only in case (or only in case and extension)', () => {
    const clashes = []
    for (const d of DIRS) {
      const seen = new Map()
      for (const file of walk(join(ROOT, d), [])) {
        const key = join(dirname(file), basename(file, extname(file))).toLowerCase()
        const prev = seen.get(key)
        if (prev && basename(prev, extname(prev)) !== basename(file, extname(file))) {
          clashes.push(`${relative(ROOT, prev)} <-> ${relative(ROOT, file)}`)
        }
        if (!prev) seen.set(key, file)
      }
    }
    expect(clashes).toEqual([])
  })
})
