import { describe, it, expect } from 'vitest'
import { isSensitiveTarget } from '../eventCapture'
import { isSecretEntry } from '../comprehensiveLogger'

function field(attrs = {}) {
  const el = document.createElement('input')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

describe('isSensitiveTarget', () => {
  it('treats a nameless password field as secret (the sign-in field)', () => {
    expect(isSensitiveTarget(field({ type: 'password' }))).toBe(true)
  })

  it('treats a PIN field by its label, placeholder or autocomplete as secret', () => {
    expect(isSensitiveTarget(field({ 'aria-label': 'Approval PIN' }))).toBe(true)
    expect(isSensitiveTarget(field({ placeholder: 'PIN' }))).toBe(true)
    expect(isSensitiveTarget(field({ autocomplete: 'one-time-code' }))).toBe(true)
    expect(isSensitiveTarget(field({ autocomplete: 'current-password' }))).toBe(true)
  })

  it('treats any field inside [data-sensitive] as secret', () => {
    const box = document.createElement('div')
    box.setAttribute('data-sensitive', '')
    const el = field({ type: 'text' })
    box.appendChild(el)
    expect(isSensitiveTarget(el)).toBe(true)
  })

  it('leaves ordinary fields alone', () => {
    expect(isSensitiveTarget(field({ type: 'text', name: 'lastName' }))).toBe(false)
    expect(isSensitiveTarget(field({ type: 'email', autocomplete: 'email' }))).toBe(false)
    expect(isSensitiveTarget(null)).toBe(false)
  })
})

describe('isSecretEntry', () => {
  it('flags stored entries typed into a password or PIN field', () => {
    expect(isSecretEntry({ target: { type: 'password', name: null } })).toBe(true)
    expect(isSecretEntry({ target: { type: 'text', ariaLabel: 'Approval PIN' } })).toBe(true)
  })

  it('keeps other entries', () => {
    expect(isSecretEntry({ target: { type: 'text', name: 'teamName' } })).toBe(false)
    expect(isSecretEntry({ target: null })).toBe(false)
    expect(isSecretEntry({})).toBe(false)
  })
})
