import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { displaySettingsUrl, isPrivateLanHost, displayPresenceMessage, displayStateOf, displayStateKey, MAX_SETTINGS_URL_LENGTH } from '../lib/displayPresence.js'
import { SETTINGS_URL_CASES } from './helpers/displayPresenceContract.js'

describe('display settings page (displaySettingsUrl)', () => {
  it('keeps private-LAN http(s) pages, normalised', () => {
    for (const [raw, kept] of SETTINGS_URL_CASES.kept) assert.equal(displaySettingsUrl(raw), kept, raw)
    // WHATWG normalisation: what is checked is what is passed on
    assert.equal(displaySettingsUrl('HTTP://172.24.1.1:8890/#settings'), 'http://172.24.1.1:8890/#settings')
    assert.equal(displaySettingsUrl('http://0xac.24.1.1/'), 'http://172.24.1.1/')
    assert.equal(displaySettingsUrl('http://192.168.5.1.'), 'http://192.168.5.1/')
  })
  it('refuses everything else', () => {
    for (const raw of SETTINGS_URL_CASES.refused) assert.equal(displaySettingsUrl(raw), null, String(raw))
    for (const raw of [undefined, null, '', 'http://10.0.0.1/\n', 'http://10.0.0.1/\u0000', 'http://172.15.255.255/', 'http://11.0.0.1/', 'http://192.169.0.1/']) {
      assert.equal(displaySettingsUrl(raw), null, JSON.stringify(raw))
    }
    assert.equal(displaySettingsUrl(`http://10.0.0.1/${'a'.repeat(MAX_SETTINGS_URL_LENGTH)}`), null)
  })
  it('private-LAN hosts: RFC 1918 IPv4 and IPv6 unique local only', () => {
    for (const h of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.0.1', '[fd00::1]', '[fc00::1]']) assert.ok(isPrivateLanHost(h), h)
    for (const h of ['127.0.0.1', '0.0.0.0', '172.15.0.1', '172.32.0.1', '169.254.0.1', '100.64.0.1', '8.8.8.8', '[::1]', '[fe80::1]', '[2001:db8::1]', '[fc::1]', 'localhost', 'board.local', '999.1.1.1', '']) {
      assert.ok(!isPrivateLanHost(h), h)
    }
  })
})

describe('display-presence message', () => {
  it('present with the newest page; absent carries no page', () => {
    const s = displayStateOf([{ settingsUrl: 'http://10.0.0.1/', at: 1 }, { settingsUrl: null, at: 3 }, { settingsUrl: 'http://10.0.0.2/', at: 2 }])
    assert.deepEqual(s, { present: true, settingsUrl: 'http://10.0.0.2/' })
    assert.deepEqual(displayStateOf([]), { present: false, settingsUrl: null })
    assert.deepEqual(displayStateOf([{ settingsUrl: null, at: 1 }]), { present: true, settingsUrl: null })
    assert.deepEqual(displayPresenceMessage('room', s), { type: 'display-presence', matchId: 'room', present: true, settingsUrl: 'http://10.0.0.2/' })
    assert.deepEqual(displayPresenceMessage('room', { present: false, settingsUrl: 'http://10.0.0.2/' }), { type: 'display-presence', matchId: 'room', present: false, settingsUrl: null })
  })
  it('states compare by presence and page only', () => {
    assert.equal(displayStateKey({ present: false, settingsUrl: null }), displayStateKey({ present: false, settingsUrl: 'x' }))
    assert.notEqual(displayStateKey({ present: true, settingsUrl: null }), displayStateKey({ present: true, settingsUrl: 'http://10.0.0.1/' }))
  })
})
