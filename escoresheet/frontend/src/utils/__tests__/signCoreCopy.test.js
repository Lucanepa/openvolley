// @vitest-environment node
/**
 * Drift guard: the backend's generated copies of the Sign on phone code
 * (backend/lib/signSessions.js, backend/lib/signPage.js) equal what
 * scripts/make-sign-core.mjs makes from the frontend sources. Rerun
 * `node scripts/make-sign-core.mjs` after changing either.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { CORE_OUT, PAGE_OUT, renderSignCore, renderSignPage } from '../../../scripts/make-sign-core.mjs'

describe('generated backend copies of the sign code', () => {
  it('backend/lib/signSessions.js is up to date', () => {
    expect(readFileSync(CORE_OUT, 'utf8')).toBe(renderSignCore())
  })

  it('backend/lib/signPage.js is up to date', () => {
    expect(readFileSync(PAGE_OUT, 'utf8')).toBe(renderSignPage())
  })

  it('the core has no require() (it is bundled to ESM and copied to the backend)', () => {
    expect(() => renderSignCore("'use strict'\nconst x = require('fs')\nmodule.exports = { x }\n")).toThrow(/require/)
  })
})
