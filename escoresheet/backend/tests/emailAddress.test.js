/**
 * One strict address (lib/emailAddress.js): nothing nodemailer could read as
 * a list or a display name, so one inbox has one spelling per account.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isEmailAddress } from '../lib/emailAddress.js'
import { noticeName } from '../lib/signupNotices.js'

describe('isEmailAddress', () => {
  it('takes plain addresses, refuses lists and display names', () => {
    for (const ok of ['a@example.ch', 'first.last+tag@sub.example.org']) assert.equal(isEmailAddress(ok), true, ok)
    for (const bad of ['victim@example.ch,a.b7', 'a.b7<victim@example.ch>', '"x"@example.ch', 'a@b@example.ch', 'a;b@example.ch',
      'a@example', 'a b@example.ch', 'x:victim@example.ch', `${'a'.repeat(250)}@example.ch`, 42]) {
      assert.equal(isEmailAddress(bad), false, String(bad))
    }
  })
})

describe('noticeName', () => {
  it('one line, no links, at most 80 characters', () => {
    assert.equal(noticeName('Nora  Neu'), 'Nora Neu')
    assert.equal(noticeName('Anna\nBcc: x'), 'Anna Bcc: x')
    assert.equal(noticeName('Win now https://evil.example/x www.evil.example evil.example'), 'Win now')
    assert.equal(noticeName('\u202eAnna'), 'Anna')
    assert.equal(noticeName('A'.repeat(200)).length, 80)
    assert.equal(noticeName(null), '')
  })
})
