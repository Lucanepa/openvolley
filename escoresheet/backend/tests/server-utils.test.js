import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Re-implement the pure functions from server.js for testing
// These match the exact logic in server.js without needing module-level state

function isValidStoragePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false
  if (filePath.includes('..') || filePath.startsWith('/') || filePath.includes('\\')) return false
  return true
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string' || email.length > 254) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function isValidPin(pin) {
  return /^\d{6}$/.test(String(pin).trim())
}

function sanitizeLog(str) {
  if (typeof str !== 'string') return String(str)
  return str.replace(/[\r\n\t]/g, ' ').substring(0, 200)
}

// Tests

describe('isValidStoragePath', () => {
  it('rejects null/undefined/empty', () => {
    assert.equal(isValidStoragePath(null), false)
    assert.equal(isValidStoragePath(undefined), false)
    assert.equal(isValidStoragePath(''), false)
  })

  it('rejects non-string', () => {
    assert.equal(isValidStoragePath(123), false)
    assert.equal(isValidStoragePath({}), false)
  })

  it('rejects directory traversal', () => {
    assert.equal(isValidStoragePath('../secret'), false)
    assert.equal(isValidStoragePath('path/../etc/passwd'), false)
  })

  it('rejects absolute paths', () => {
    assert.equal(isValidStoragePath('/etc/passwd'), false)
  })

  it('rejects backslashes', () => {
    assert.equal(isValidStoragePath('path\\file'), false)
    assert.equal(isValidStoragePath('C:\\Windows'), false)
  })

  it('accepts valid relative paths', () => {
    assert.equal(isValidStoragePath('file.txt'), true)
    assert.equal(isValidStoragePath('path/to/file.json'), true)
    assert.equal(isValidStoragePath('match-123-scoresheet.pdf'), true)
  })
})

describe('isValidEmail', () => {
  it('rejects null/undefined/empty', () => {
    assert.equal(isValidEmail(null), false)
    assert.equal(isValidEmail(undefined), false)
    assert.equal(isValidEmail(''), false)
  })

  it('rejects non-string', () => {
    assert.equal(isValidEmail(123), false)
  })

  it('rejects emails longer than 254 chars', () => {
    const longEmail = 'a'.repeat(250) + '@b.co'
    assert.equal(isValidEmail(longEmail), false)
  })

  it('rejects invalid format', () => {
    assert.equal(isValidEmail('noatsign'), false)
    assert.equal(isValidEmail('@nodomain'), false)
    assert.equal(isValidEmail('no@dot'), false)
    assert.equal(isValidEmail('has space@mail.com'), false)
  })

  it('accepts valid emails', () => {
    assert.equal(isValidEmail('user@example.com'), true)
    assert.equal(isValidEmail('first.last@domain.org'), true)
    assert.equal(isValidEmail('user+tag@gmail.com'), true)
  })
})

describe('isValidPin', () => {
  it('accepts exactly 6 digits', () => {
    assert.equal(isValidPin('123456'), true)
    assert.equal(isValidPin('000000'), true)
    assert.equal(isValidPin('999999'), true)
  })

  it('accepts numeric input', () => {
    assert.equal(isValidPin(123456), true)
  })

  it('trims whitespace', () => {
    assert.equal(isValidPin(' 123456 '), true)
  })

  it('rejects too few digits', () => {
    assert.equal(isValidPin('12345'), false)
    assert.equal(isValidPin('1'), false)
  })

  it('rejects too many digits', () => {
    assert.equal(isValidPin('1234567'), false)
  })

  it('rejects non-numeric', () => {
    assert.equal(isValidPin('abcdef'), false)
    assert.equal(isValidPin('12345a'), false)
  })
})

describe('sanitizeLog', () => {
  it('replaces newlines and tabs with spaces', () => {
    assert.equal(sanitizeLog('line1\nline2\rline3\tend'), 'line1 line2 line3 end')
  })

  it('truncates to 200 chars', () => {
    const long = 'a'.repeat(300)
    assert.equal(sanitizeLog(long).length, 200)
  })

  it('converts non-strings to string', () => {
    assert.equal(sanitizeLog(42), '42')
    assert.equal(sanitizeLog(null), 'null')
    assert.equal(sanitizeLog(undefined), 'undefined')
  })

  it('passes through clean strings', () => {
    assert.equal(sanitizeLog('hello world'), 'hello world')
  })
})
