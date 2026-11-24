import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

// The TypeScript sheet is type-checked with every test run (review 2026-11-16,
// F10): unused refs and locals, a broken memo dependency or a wrong prop show up
// here instead of shipping. `npm run typecheck` runs the same.
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tsc = resolve(frontend, 'node_modules', 'typescript', 'bin', 'tsc')

describe('scoresheet_pdf type check', () => {
  it.skipIf(!existsSync(tsc))('tsc --noEmit --noUnusedLocals reports nothing', () => {
    let out = ''
    try {
      execFileSync(process.execPath, [tsc, '--noEmit', '-p', 'scoresheet_pdf', '--noUnusedLocals'], { cwd: frontend, encoding: 'utf8', stdio: 'pipe' })
    } catch (err: any) {
      out = `${err.stdout || ''}${err.stderr || ''}` || String(err)
    }
    expect(out).toBe('')
  }, 180_000)
})
